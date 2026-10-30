-- 007: Use text table tokens at the public RPC boundary so malformed QR values
-- receive a clear validation error instead of a UUID cast error from PostgREST.
-- DiningTable.PublicToken values and existing orders remain unchanged.
begin;

drop function if exists public.esmiringkape_public_menu(uuid);
drop function if exists public.esmiringkape_public_menu(text);
drop function if exists public.esmiringkape_create_guest_order_v2(jsonb, text, text, text, uuid);
drop function if exists public.esmiringkape_create_guest_order_v2(jsonb, text, text, text, text);

create or replace function public.esmiringkape_public_menu(p_table_token text default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_table_token uuid;
  v_table jsonb := null;
  v_result jsonb;
begin
  if nullif(trim(p_table_token), '') is not null then
    begin
      v_table_token := trim(p_table_token)::uuid;
    exception when invalid_text_representation then
      raise exception 'This table QR link is invalid or inactive. Please scan an active table QR code or ask staff for help.' using errcode = 'P0002';
    end;
    select jsonb_build_object('table_id', t."DiningTableID", 'table_number', t."TableNumber", 'public_token', t."PublicToken")
      into v_table from public."DiningTable" t where t."PublicToken" = v_table_token and t."IsActive";
    if v_table is null then raise exception 'This table QR link is invalid or inactive. Please scan an active table QR code or ask staff for help.' using errcode = 'P0002'; end if;
  end if;

  select jsonb_build_object(
    'table', v_table,
    'inventory_enforced', coalesce((select lower("SettingValue") = 'true' from public."ShopSetting" where "SettingKey" = 'inventory_enforced'), false),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('CategoryID', c."CategoryID", 'CategoryName', c."CategoryName") order by c."CategoryName") from public."Categories" c), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'ItemID', m."ItemID", 'ItemName', m."ItemName", 'Price', m."Price", 'CategoryID', m."CategoryID", 'Available', m."Available",
      'ImageURL', m."ImageURL", 'StockAvailable', public.esmiringkape_item_stock_available(m."ItemID", '{}'::bigint[], 1),
      'groups', coalesce((select jsonb_agg(jsonb_build_object(
        'group_id', g."CustomizationGroupID", 'name', g."Name", 'selection_type', g."SelectionType", 'required', g."IsRequired",
        'min_selections', g."MinSelections", 'max_selections', g."MaxSelections", 'sort_order', g."SortOrder",
        'options', coalesce((select jsonb_agg(jsonb_build_object(
          'option_id', o."CustomizationOptionID", 'name', o."Name", 'price_delta', o."PriceDelta", 'is_default', o."IsDefault",
          'available', public.esmiringkape_item_stock_available(m."ItemID", array[o."CustomizationOptionID"], 1), 'sort_order', o."SortOrder"
        ) order by o."SortOrder", o."CustomizationOptionID") from public."MenuCustomizationOption" o where o."CustomizationGroupID" = g."CustomizationGroupID" and o."IsActive"), '[]'::jsonb)
      ) order by g."SortOrder", g."CustomizationGroupID") from public."MenuCustomizationGroup" g where g."MenuItemID" = m."ItemID" and g."IsActive"), '[]'::jsonb)
    ) order by m."ItemName") from public."MenuItems" m), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.esmiringkape_create_guest_order_v2(
  p_items jsonb, p_guest_token text, p_guest_name text default null,
  p_service_type text default 'takeaway', p_table_token text default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_order_id bigint;
  v_employee bigint;
  v_table_id bigint;
  v_table_token uuid;
  v_line record;
  v_quote jsonb;
  v_token_hash text;
begin
  if nullif(trim(p_guest_token), '') is null or length(p_guest_token) < 32 then raise exception 'A secure order tracking token is required'; end if;
  v_token_hash := md5(p_guest_token);
  perform pg_advisory_xact_lock(hashtextextended(v_token_hash, 0));
  -- An idempotent retry returns its already-created order, even if its table was later deactivated.
  select "OrderID" into v_order_id from public."GuestOrderAccess" where "TokenHash" = v_token_hash;
  if v_order_id is not null then return public.esmiringkape_guest_order_json(v_order_id); end if;

  if p_service_type is null or p_service_type not in ('dine_in', 'takeaway') then raise exception 'Choose dine-in or takeaway'; end if;
  if p_service_type = 'dine_in' then
    if nullif(trim(p_table_token), '') is null then raise exception 'Scan your table’s QR code to order dine-in' using errcode = '23514'; end if;
    begin
      v_table_token := trim(p_table_token)::uuid;
    exception when invalid_text_representation then
      raise exception 'This table QR link is invalid or inactive. Scan an active table QR code before placing a dine-in order.' using errcode = '23514';
    end;
    select "DiningTableID" into v_table_id from public."DiningTable" where "PublicToken" = v_table_token and "IsActive";
    if v_table_id is null then raise exception 'This table QR link is invalid or inactive. Scan an active table QR code before placing a dine-in order.' using errcode = '23514'; end if;
  elsif nullif(trim(p_table_token), '') is not null then
    raise exception 'Takeaway orders cannot be assigned to a table';
  end if;

  v_quote := public.esmiringkape_quote_configured_sale(p_items, false);
  insert into public."Order" ("CustomerID", "OrderDate", "Status", "EmployeeID", "PickupName", "OrderType", "ServiceType", "DiningTableID", "Subtotal", "TotalAmount")
  values (null, clock_timestamp(), 'Pending', null, nullif(trim(p_guest_name), ''), 'guest', p_service_type, v_table_id,
    (v_quote->>'subtotal')::numeric, (v_quote->>'total')::numeric) returning "OrderID" into v_order_id;
  for v_line in select * from jsonb_to_recordset(p_items) as x(item_id bigint, quantity integer, selected_option_ids bigint[]) loop
    insert into public."OrderItem" ("OrderID", "ItemID", "Quantity", "SelectedOptionIDs")
    values (v_order_id, v_line.item_id, v_line.quantity, coalesce(v_line.selected_option_ids, '{}'::bigint[]));
  end loop;
  perform public.esmiringkape_calculate_order_totals(v_order_id);
  insert into public."GuestOrderAccess" ("OrderID", "TokenHash") values (v_order_id, v_token_hash);
  return public.esmiringkape_guest_order_json(v_order_id);
end;
$$;

revoke all on function public.esmiringkape_public_menu(text) from public, authenticated;
grant execute on function public.esmiringkape_public_menu(text) to anon, authenticated;
revoke all on function public.esmiringkape_create_guest_order_v2(jsonb, text, text, text, text) from public, authenticated;
grant execute on function public.esmiringkape_create_guest_order_v2(jsonb, text, text, text, text) to anon;

commit;
