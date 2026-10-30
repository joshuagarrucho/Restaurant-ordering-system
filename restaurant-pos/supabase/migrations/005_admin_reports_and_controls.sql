-- 005: Administrator dashboard, inventory setup, reports, settings, and audit actions.
-- Run after 004. First-admin linking is described in SETUP.md and requires SQL Editor access.
begin;

do $$
declare
  v_sequence text;
begin
  v_sequence := pg_get_serial_sequence('public."Categories"', 'CategoryID');
  if v_sequence is not null then execute format('grant usage, select on sequence %s to authenticated', v_sequence); end if;
  v_sequence := pg_get_serial_sequence('public."MenuItems"', 'ItemID');
  if v_sequence is not null then execute format('grant usage, select on sequence %s to authenticated', v_sequence); end if;
  v_sequence := pg_get_serial_sequence('public.customers', 'customerID');
  if v_sequence is not null then execute format('grant usage, select on sequence %s to authenticated', v_sequence); end if;
end;
$$;

create or replace function public.esmiringkape_admin_dashboard_metrics(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Invalid date range'; end if;
  select jsonb_build_object(
    'sales_total', coalesce((
      select sum(greatest(0, coalesce(p."AmountApplied", p."AmountPaid", 0) - coalesce(p."RefundedAmount", 0)))
      from public."Order" o
      join public."Payment" p on p."OrderID" = o."OrderID"
        and lower(p."PaymentStatus") in ('paid', 'partially refunded', 'refunded')
      where (o."OrderDate" at time zone 'Asia/Manila')::date between p_from and p_to
    ), 0),
    'order_count', (select count(*) from public."Order" o where (o."OrderDate" at time zone 'Asia/Manila')::date between p_from and p_to),
    'active_queue', (select count(*) from public."Order" o where o."QueueEnteredAt" is not null and lower(o."Status") in ('pending','waiting','preparing','ready')),
    'unpaid_orders', (select count(*) from public."Order" o where not exists (
      select 1 from public."Payment" p where p."OrderID" = o."OrderID" and lower(p."PaymentStatus") = 'paid'
    ) and lower(o."Status") <> 'cancelled'),
    'low_stock', (select count(*) from public."InventoryItem" i where i."IsActive" and i."QuantityOnHand" <= i."ReorderThreshold'),
    'low_stock_items', coalesce((select jsonb_agg(jsonb_build_object(
      'inventory_item_id', i."InventoryItemID", 'name', i."Name", 'quantity_on_hand', i."QuantityOnHand",
      'unit', i."Unit", 'reorder_threshold', i."ReorderThreshold"
    ) order by i."QuantityOnHand", i."Name") from public."InventoryItem" i
      where i."IsActive" and i."QuantityOnHand" <= i."ReorderThreshold"), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.esmiringkape_admin_list_employees()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'EmployeeID', e."EmployeeID", 'FullName', e."FullName", 'Role', e."Role",
    'EmployeeStatus', e."EmployeeStatus", 'AuthUserID', e."AuthUserID"
  ) order by e."FullName") from public."Employee" e), '[]'::jsonb);
end;
$$;

create or replace function public.esmiringkape_admin_create_inventory_item(
  p_name text, p_item_type text, p_unit text, p_reorder_threshold numeric, p_opening_quantity numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item public."InventoryItem"%rowtype;
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if p_item_type not in ('ingredient', 'finished_good') then raise exception 'Choose ingredient or finished good'; end if;
  if p_opening_quantity < 0 or p_reorder_threshold < 0 then raise exception 'Quantities cannot be negative'; end if;
  insert into public."InventoryItem" ("Name", "ItemType", "Unit", "QuantityOnHand", "ReorderThreshold")
  values (trim(p_name), p_item_type, trim(p_unit), 0, p_reorder_threshold)
  returning * into v_item;
  if p_opening_quantity > 0 then
    update public."InventoryItem" set "QuantityOnHand" = p_opening_quantity where "InventoryItemID" = v_item."InventoryItemID" returning * into v_item;
    insert into public."InventoryMovement" ("InventoryItemID", "QuantityChange", "Reason", "MovementType", "EmployeeID")
    values (v_item."InventoryItemID", p_opening_quantity, 'Opening balance', 'opening_balance', public.esmiringkape_current_employee_id());
  end if;
  return to_jsonb(v_item);
end;
$$;

create or replace function public.esmiringkape_admin_update_inventory_settings(
  p_inventory_item_id bigint, p_reorder_threshold numeric, p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_item public."InventoryItem"%rowtype;
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if p_reorder_threshold < 0 then raise exception 'Reorder threshold cannot be negative'; end if;
  update public."InventoryItem" set "ReorderThreshold" = p_reorder_threshold, "IsActive" = p_active, "UpdatedAt" = now()
  where "InventoryItemID" = p_inventory_item_id returning * into v_item;
  if v_item."InventoryItemID" is null then raise exception 'Inventory item not found'; end if;
  return to_jsonb(v_item);
end;
$$;

create or replace function public.esmiringkape_admin_set_recipe(p_menu_item_id bigint, p_inventory_item_id bigint, p_quantity_required numeric)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if p_quantity_required is null then
    delete from public."MenuItemIngredient" where "MenuItemID" = p_menu_item_id and "InventoryItemID" = p_inventory_item_id;
  elsif p_quantity_required <= 0 then
    raise exception 'Recipe quantity must be positive';
  else
    insert into public."MenuItemIngredient" ("MenuItemID", "InventoryItemID", "QuantityRequired")
    values (p_menu_item_id, p_inventory_item_id, p_quantity_required)
    on conflict ("MenuItemID", "InventoryItemID") do update set "QuantityRequired" = excluded."QuantityRequired";
  end if;
end;
$$;

create or replace function public.esmiringkape_admin_list_recipes()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'menu_item_id', recipe."MenuItemID", 'menu_item_name', menu."ItemName",
    'inventory_item_id', recipe."InventoryItemID", 'inventory_item_name', inventory."Name",
    'quantity_required', recipe."QuantityRequired", 'unit', inventory."Unit"
  ) order by menu."ItemName", inventory."Name")
  from public."MenuItemIngredient" recipe
  join public."MenuItems" menu on menu."ItemID" = recipe."MenuItemID"
  join public."InventoryItem" inventory on inventory."InventoryItemID" = recipe."InventoryItemID"), '[]'::jsonb);
end;
$$;

create or replace function public.esmiringkape_admin_inventory_movements(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'movement_id', m."InventoryMovementID", 'inventory_item_id', m."InventoryItemID", 'name', i."Name",
    'quantity_change', m."QuantityChange", 'reason', m."Reason", 'movement_type', m."MovementType",
    'order_id', m."OrderID", 'employee', e."FullName", 'created_at', m."CreatedAt"
  ) order by m."CreatedAt" desc) from public."InventoryMovement" m
  join public."InventoryItem" i on i."InventoryItemID" = m."InventoryItemID"
  left join public."Employee" e on e."EmployeeID" = m."EmployeeID"
  where (m."CreatedAt" at time zone 'Asia/Manila')::date between p_from and p_to), '[]'::jsonb);
end;
$$;

create or replace function public.esmiringkape_admin_sales_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public.esmiringkape_staff_order_json(o."OrderID") order by o."OrderDate", o."OrderID")
    from public."Order" o where (o."OrderDate" at time zone 'Asia/Manila')::date between p_from and p_to), '[]'::jsonb);
end;
$$;

create or replace function public.esmiringkape_admin_get_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'settings', coalesce((select jsonb_object_agg("SettingKey", "SettingValue") from public."ShopSetting"), '{}'::jsonb),
    'tax_rules', coalesce((select jsonb_agg(to_jsonb(t) order by t."Name") from public."TaxRule" t), '[]'::jsonb),
    'discount_rules', coalesce((select jsonb_agg(to_jsonb(d) order by d."Name") from public."DiscountRule" d), '[]'::jsonb)
  );
end;
$$;

create or replace function public.esmiringkape_admin_save_setting(p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if p_key not in ('shop_name', 'receipt_footer', 'inventory_enforced') then raise exception 'Unsupported shop setting'; end if;
  if p_key = 'inventory_enforced' and lower(coalesce(p_value, 'false')) not in ('true', 'false') then
    raise exception 'Inventory enforcement must be true or false';
  end if;
  if p_key = 'inventory_enforced' and lower(p_value) = 'true' and exists (
    select 1 from public."MenuItems" menu
    where menu."Available" is true
      and not exists (select 1 from public."MenuItemIngredient" recipe where recipe."MenuItemID" = menu."ItemID")
  ) then
    raise exception 'Add at least one stock recipe to every available product before enabling inventory enforcement';
  end if;
  if p_key = 'inventory_enforced' and lower(p_value) = 'true' and exists (
    select 1 from public."MenuItems" menu
    join public."MenuItemIngredient" recipe on recipe."MenuItemID" = menu."ItemID"
    join public."InventoryItem" inventory on inventory."InventoryItemID" = recipe."InventoryItemID"
    where menu."Available" is true and inventory."IsActive" is false
  ) then
    raise exception 'Activate every stock item mapped to an available product before enabling inventory enforcement';
  end if;
  insert into public."ShopSetting" ("SettingKey", "SettingValue", "UpdatedAt", "UpdatedByEmployeeID")
  values (p_key, coalesce(p_value, ''), clock_timestamp(), public.esmiringkape_current_employee_id())
  on conflict ("SettingKey") do update set "SettingValue" = excluded."SettingValue", "UpdatedAt" = excluded."UpdatedAt", "UpdatedByEmployeeID" = excluded."UpdatedByEmployeeID";
end;
$$;

create or replace function public.esmiringkape_admin_save_tax_rule(p_rule_id bigint, p_name text, p_rate numeric, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_rule public."TaxRule"%rowtype;
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if p_rule_id is null then
    insert into public."TaxRule" ("Name", "RatePercent", "IsActive") values (trim(p_name), p_rate, p_active) returning * into v_rule;
  else
    update public."TaxRule" set "Name" = trim(p_name), "RatePercent" = p_rate, "IsActive" = p_active, "UpdatedAt" = now()
      where "TaxRuleID" = p_rule_id returning * into v_rule;
  end if;
  if v_rule."TaxRuleID" is null then raise exception 'Tax rule not found'; end if;
  return to_jsonb(v_rule);
end;
$$;

create or replace function public.esmiringkape_admin_save_discount_rule(p_rule_id bigint, p_name text, p_rate numeric, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_rule public."DiscountRule"%rowtype;
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if p_rule_id is null then
    insert into public."DiscountRule" ("Name", "RatePercent", "IsActive") values (trim(p_name), p_rate, p_active) returning * into v_rule;
  else
    update public."DiscountRule" set "Name" = trim(p_name), "RatePercent" = p_rate, "IsActive" = p_active, "UpdatedAt" = now()
      where "DiscountRuleID" = p_rule_id returning * into v_rule;
  end if;
  if v_rule."DiscountRuleID" is null then raise exception 'Discount rule not found'; end if;
  return to_jsonb(v_rule);
end;
$$;

create or replace function public.esmiringkape_admin_cancel_order(p_order_id bigint, p_refund_amount numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public."Order"%rowtype;
  v_employee_id bigint;
  v_paid numeric(12,2);
  v_refunded numeric(12,2);
  v_refund_remaining numeric(12,2);
  v_refund_piece numeric(12,2);
  v_payment record;
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required'; end if;
  v_employee_id := public.esmiringkape_current_employee_id();
  select * into v_order from public."Order" where "OrderID" = p_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if lower(v_order."Status") = 'cancelled' and coalesce(p_refund_amount, 0) = 0 then
    return public.esmiringkape_staff_order_json(p_order_id);
  end if;
  select coalesce(sum(coalesce("AmountApplied", "AmountPaid")), 0), coalesce(sum("RefundedAmount"), 0)
    into v_paid, v_refunded from public."Payment" where "OrderID" = p_order_id and lower("PaymentStatus") in ('paid', 'partially refunded', 'refunded');
  if p_refund_amount is null or p_refund_amount < 0 or p_refund_amount > v_paid - v_refunded then raise exception 'Refund exceeds the remaining paid amount'; end if;
  if v_paid - v_refunded > 0 and p_refund_amount <= 0 then raise exception 'Enter the authorized refund amount'; end if;
  if p_refund_amount > 0 then
    v_refund_remaining := p_refund_amount;
    for v_payment in
      select ctid as payment_tid, coalesce("AmountApplied", "AmountPaid") as amount_applied, "RefundedAmount"
      from public."Payment"
      where "OrderID" = p_order_id and lower("PaymentStatus") in ('paid', 'partially refunded')
      order by "PaymentDate" asc nulls last
      for update
    loop
      exit when v_refund_remaining <= 0;
      v_refund_piece := least(v_refund_remaining, greatest(0, v_payment.amount_applied - v_payment."RefundedAmount"));
      if v_refund_piece > 0 then
        update public."Payment"
          set "RefundedAmount" = "RefundedAmount" + v_refund_piece,
              "RefundedAt" = clock_timestamp(), "RefundedByEmployeeID" = v_employee_id
          where ctid = v_payment.payment_tid;
        v_refund_remaining := v_refund_remaining - v_refund_piece;
      end if;
    end loop;
    if v_refund_remaining > 0 then raise exception 'Refund exceeds the remaining paid amount'; end if;
  end if;
  update public."Order" set "Status" = 'Cancelled' where "OrderID" = p_order_id;
  insert into public."OrderAuditEvent" ("OrderID", "PreviousStatus", "NewStatus", "EmployeeID", "Details")
  values (p_order_id, v_order."Status", 'Cancelled', v_employee_id,
    jsonb_build_object('reason', trim(p_reason), 'refund_amount', p_refund_amount, 'stock_returned', false));
  return public.esmiringkape_staff_order_json(p_order_id);
end;
$$;

revoke all on function public.esmiringkape_admin_dashboard_metrics(date, date) from public, anon;
revoke all on function public.esmiringkape_admin_list_employees() from public, anon;
revoke all on function public.esmiringkape_admin_create_inventory_item(text, text, text, numeric, numeric) from public, anon;
revoke all on function public.esmiringkape_admin_update_inventory_settings(bigint, numeric, boolean) from public, anon;
revoke all on function public.esmiringkape_admin_set_recipe(bigint, bigint, numeric) from public, anon;
revoke all on function public.esmiringkape_admin_list_recipes() from public, anon;
revoke all on function public.esmiringkape_admin_inventory_movements(date, date) from public, anon;
revoke all on function public.esmiringkape_admin_sales_report(date, date) from public, anon;
revoke all on function public.esmiringkape_admin_get_settings() from public, anon;
revoke all on function public.esmiringkape_admin_save_setting(text, text) from public, anon;
revoke all on function public.esmiringkape_admin_save_tax_rule(bigint, text, numeric, boolean) from public, anon;
revoke all on function public.esmiringkape_admin_save_discount_rule(bigint, text, numeric, boolean) from public, anon;
revoke all on function public.esmiringkape_admin_cancel_order(bigint, numeric, text) from public, anon;

grant execute on function public.esmiringkape_admin_dashboard_metrics(date, date) to authenticated;
grant execute on function public.esmiringkape_admin_list_employees() to authenticated;
grant execute on function public.esmiringkape_admin_create_inventory_item(text, text, text, numeric, numeric) to authenticated;
grant execute on function public.esmiringkape_admin_update_inventory_settings(bigint, numeric, boolean) to authenticated;
grant execute on function public.esmiringkape_admin_set_recipe(bigint, bigint, numeric) to authenticated;
grant execute on function public.esmiringkape_admin_list_recipes() to authenticated;
grant execute on function public.esmiringkape_admin_inventory_movements(date, date) to authenticated;
grant execute on function public.esmiringkape_admin_sales_report(date, date) to authenticated;
grant execute on function public.esmiringkape_admin_get_settings() to authenticated;
grant execute on function public.esmiringkape_admin_save_setting(text, text) to authenticated;
grant execute on function public.esmiringkape_admin_save_tax_rule(bigint, text, numeric, boolean) to authenticated;
grant execute on function public.esmiringkape_admin_save_discount_rule(bigint, text, numeric, boolean) to authenticated;
grant execute on function public.esmiringkape_admin_cancel_order(bigint, numeric, text) to authenticated;

commit;

