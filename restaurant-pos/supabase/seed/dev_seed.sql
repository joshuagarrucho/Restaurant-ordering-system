-- Optional local/development data only. Never run this in production.
-- Sample stock is prefixed [DEMO] and is not connected to real sales.
begin;

do $$
declare
  v_category_id bigint;
  v_item_id bigint;
  v_inventory_id bigint;
begin
  if coalesce(current_setting('app.esmiringkape_seed_environment', true), '') <> 'development' then
    raise exception 'Development seed guard failed';
  end if;

  select "CategoryID" into v_category_id from public."Categories"
    where "CategoryName" = '[DEMO] Sample Menu' limit 1;
  if v_category_id is null then
    insert into public."Categories" ("CategoryName") values ('[DEMO] Sample Menu') returning "CategoryID" into v_category_id;
  end if;

  select "ItemID" into v_item_id from public."MenuItems"
    where "ItemName" = '[DEMO] Sample Latte' limit 1;
  if v_item_id is null then
    insert into public."MenuItems" ("ItemName", "Price", "CategoryID", "Available", "ImageURL")
    values ('[DEMO] Sample Latte', 120, v_category_id, false, null)
    returning "ItemID" into v_item_id;
  end if;

  select "InventoryItemID" into v_inventory_id from public."InventoryItem"
    where "Name" = '[DEMO] Sample Milk' limit 1;
  if v_inventory_id is null then
    insert into public."InventoryItem" ("Name", "ItemType", "Unit", "QuantityOnHand", "ReorderThreshold")
    values ('[DEMO] Sample Milk', 'ingredient', 'ml', 1500, 250)
    returning "InventoryItemID" into v_inventory_id;
    insert into public."InventoryMovement" ("InventoryItemID", "QuantityChange", "Reason", "MovementType")
    values (v_inventory_id, 1500, 'Development-only opening balance', 'opening_balance');
  end if;

  insert into public."MenuItemIngredient" ("MenuItemID", "InventoryItemID", "QuantityRequired")
  values (v_item_id, v_inventory_id, 180)
  on conflict ("MenuItemID", "InventoryItemID") do nothing;
end;
$$;

commit;
