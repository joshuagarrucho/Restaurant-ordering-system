import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = (name) => readFileSync(resolve('supabase/migrations', name), 'utf8');
const staff = migration('001_staff_access.sql');
const inventory = migration('003_inventory.sql');
const operations = migration('004_staff_orders_payments_queue.sql');
const totals = migration('002_sales_snapshots_and_settings.sql');
const admin = migration('005_admin_reports_and_controls.sql');
const enhancements = migration('006_customization_dining_tables_qr.sql');

test('database payment RPC returns an existing paid order before stock can be deducted again', () => {
  const paidCheck = operations.indexOf("if v_paid then");
  const stockDeduction = operations.indexOf('perform public.esmiringkape_deduct_order_stock(p_order_id, v_employee_id)');
  assert.ok(paidCheck >= 0 && stockDeduction > paidCheck);
  assert.match(operations.slice(paidCheck, stockDeduction), /return public\.esmiringkape_staff_order_json\(p_order_id\)/);
  assert.match(operations, /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/);
  assert.match(operations, /public\."SaleIdempotency"/);
});

test('inventory deduction serializes stock rows, rejects negative balances, and records one order marker', () => {
  assert.match(inventory, /insert into public\."OrderStockDeduction" \("OrderID"\) values \(p_order_id\)\s+on conflict do nothing/);
  assert.match(inventory, /order by recipe\."InventoryItemID"/);
  assert.match(inventory, /for update;/i);
  assert.match(inventory, /v_on_hand < v_item\.quantity_needed/);
  assert.match(inventory, /raise exception 'Insufficient stock/);
  assert.match(inventory, /insert into public\."InventoryMovement"/);
});

test('FIFO claim is locked, ordered by server queue timestamp and OrderID', () => {
  const claim = operations.slice(operations.indexOf('create or replace function public.esmiringkape_claim_next_order()'));
  assert.match(claim, /pg_advisory_xact_lock\(hashtext\('esmiringkape_next_queue_order'\)\)/);
  assert.match(claim, /order by o\."QueueEnteredAt" asc, o\."OrderID" asc/i);
  assert.match(claim, /for update of o skip locked/i);
  assert.match(claim, /limit 1\s+for update of o skip locked/i);
  assert.match(operations, /"QueueEnteredAt" = coalesce\("QueueEnteredAt", clock_timestamp\(\)\)/);
});

test('only trusted server functions can recalculate order totals', () => {
  assert.match(totals, /revoke all on function public\.esmiringkape_calculate_order_totals\(bigint\) from public, anon, authenticated/i);
});

test('new order items use current server prices and cannot use unavailable products', () => {
  assert.match(totals, /if tg_op = 'INSERT' and v_available is distinct from true then/i);
  assert.match(totals, /new\."UnitPrice" := v_price/);
  assert.match(totals, /new\."LineTotal" := round\(new\."UnitPrice" \* new\."Quantity", 2\)/);
});

test('admin sales metrics subtract authorized refunds', () => {
  assert.match(admin, /greatest\(0, coalesce\(p\."AmountApplied", p\."AmountPaid", 0\) - coalesce\(p\."RefundedAmount", 0\)\)/);
  assert.match(operations, /'net_amount', case when lower\(coalesce\(p\."PaymentStatus", ''\)\) in \('paid', 'partially refunded', 'refunded'\) then greatest\(0, coalesce\(p\."AmountApplied", p\."AmountPaid", 0\) - coalesce\(p\."RefundedAmount", 0\)\) else 0 end/);
});

test('RLS and RPC roles deny anonymous employee and transaction-table access', () => {
  assert.match(staff, /alter table public\."Employee" enable row level security/i);
  assert.match(staff, /revoke all on public\."Employee" from public, anon, authenticated/i);
  assert.match(staff, /employee_self_or_admin_read/);
  assert.match(staff, /revoke all on public\.customers, public\."Order"[\s\S]*?from public, anon/i);
  assert.match(operations, /coalesce\(public\.esmiringkape_staff_role\(\), ''\) not in \('admin', 'cashier', 'barista'\)/);
  assert.match(staff, /esmiringkape_staff_role\(\) is distinct from 'admin'/);
  assert.match(inventory, /esmiringkape_staff_role\(\) is distinct from 'admin'/);
  assert.match(admin, /esmiringkape_staff_role\(\) is distinct from 'admin'/);
  assert.doesNotMatch(`${staff}\n${inventory}\n${operations}\n${admin}`, /if public\.esmiringkape_staff_role\(\) <> 'admin'/i);
});

test('guest menu reads survive while all menu writes are restricted to administrators', () => {
  assert.match(staff, /tablename in \('Employee', 'Categories', 'MenuItems'/);
  assert.match(staff, /revoke all on public\."Categories", public\."MenuItems" from public, anon, authenticated/i);
  assert.match(staff, /categories_public_read on public\."Categories" for select to anon, authenticated/i);
  assert.match(staff, /menu_items_admin_write on public\."MenuItems" for all to authenticated\s+using \(public\.esmiringkape_staff_role\(\) = 'admin'\)/i);
});

test('authorized cashier customer inserts can use the existing customer identity sequence', () => {
  assert.match(admin, /pg_get_serial_sequence\('public\.customers', 'customerID'\)/);
});

test('FIFO start is only available through the locked next-order claim', () => {
  const statusUpdate = operations.slice(operations.indexOf('create or replace function public.esmiringkape_update_preparation_status('));
  assert.doesNotMatch(statusUpdate, /v_current = 'waiting' and v_next = 'Preparing'/i);
  assert.match(operations, /update public\."Order" set "Status" = 'Preparing' where "OrderID" = v_order_id/);
});

test('payment uses the server total saved at order creation', () => {
  const payment = operations.slice(operations.indexOf('create or replace function public.esmiringkape_confirm_cash_payment('), operations.indexOf('create or replace function public.esmiringkape_quote_counter_sale('));
  assert.doesNotMatch(payment, /esmiringkape_calculate_order_totals/);
});

test('customization selections are validated and unit prices are snapshotted by the database trigger', () => {
  assert.match(enhancements, /esmiringkape_selected_customization\(p_menu_item_id bigint, p_selected_option_ids bigint\[\]\)/);
  assert.match(enhancements, /v_count < v_group\."MinSelections" or v_count > v_group\."MaxSelections"/i);
  assert.match(enhancements, /That combination of options is not available/);
  assert.match(enhancements, /new\."UnitPrice" := round\(v_price \+ coalesce\(\(v_config->>'price_delta'\)::numeric, 0\), 2\)/);
  assert.match(enhancements, /new\."OptionsSnapshot" := jsonb_build_object\('selected_options', v_config->'selected_options', 'recipe_usage', v_recipe\)/);
  assert.match(enhancements, /new\."UnitPrice" := coalesce\(old\."UnitPrice", new\."UnitPrice", v_price\)/);
  assert.match(enhancements, /new\."OptionsSnapshot" := coalesce\(old\."OptionsSnapshot", new\."OptionsSnapshot", '\[\]'::jsonb\)/);
  assert.match(enhancements, /v_line\.quantity is null or v_line\.quantity not between 1 and 99/);
});

test('legacy order backfill adds recipe snapshots without rewriting saved sale prices', () => {
  const backfillStart = enhancements.indexOf('update public."OrderItem" oi');
  const backfillEnd = enhancements.indexOf('create or replace function public.esmiringkape_deduct_order_stock', backfillStart);
  const backfill = enhancements.slice(backfillStart, backfillEnd);
  assert.match(backfill, /set "OptionsSnapshot" = jsonb_build_object/);
  assert.doesNotMatch(backfill, /set[^;]*"UnitPrice"/s);
});

test('size, substitution, and add-on recipes feed availability and payment deductions', () => {
  assert.match(enhancements, /"IngredientMultiplier" numeric[^\n]*check \("IngredientMultiplier" > 0\)/);
  assert.match(enhancements, /"ScaleWithSize" boolean not null default false/);
  assert.match(enhancements, /not \(recipe\."InventoryItemID" = any\(v_replaced\)\)/);
  assert.match(enhancements, /where option_recipe\."CustomizationOptionID" = any\(coalesce\(p_selected_option_ids/);
  assert.match(enhancements, /raise exception 'Availability changed: there is not enough stock for this complete order.'/);
  assert.match(enhancements, /for update;/i);
  assert.match(enhancements, /insert into public\."InventoryMovement"/);
  assert.match(enhancements, /"OptionsSnapshot"-\>'recipe_usage'/);
  assert.match(enhancements, /A configured add-on recipe cannot stand in for the drink's base recipe/);
});

test('custom guest order and counter sale retries are idempotent and table scoped', () => {
  assert.match(enhancements, /"GuestOrderAccess"[\s\S]*?"TokenHash" text not null unique/);
  assert.match(enhancements, /pg_advisory_xact_lock\(hashtextextended\(v_token_hash, 0\)\)/);
  assert.match(enhancements, /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/);
  assert.match(enhancements, /where a\."TokenHash" = md5\(coalesce\(p_guest_token, ''\)\)/);
  assert.match(enhancements, /p_service_type = 'dine_in'[\s\S]*?p_table_token is null[\s\S]*?where "PublicToken" = p_table_token and "IsActive"/);
  assert.match(enhancements, /p_service_type = 'takeaway'[\s\S]*?Takeaway orders cannot be assigned to a table/);
  assert.match(enhancements, /esmiringkape_confirm_cash_payment\(v_order_id, p_cash_tendered\)/);
  const guestCreate = enhancements.slice(enhancements.indexOf('create or replace function public.esmiringkape_create_guest_order_v2'), enhancements.indexOf('create or replace function public.esmiringkape_guest_order_json'));
  assert.ok(guestCreate.indexOf('GuestOrderAccess') < guestCreate.indexOf('where "PublicToken" = p_table_token'), 'guest retries must resolve before checking whether a table was later deactivated');
  const counterCreate = enhancements.slice(enhancements.indexOf('create or replace function public.esmiringkape_complete_counter_sale_v2'), enhancements.indexOf('-- Admin movement history'));
  assert.ok(counterCreate.indexOf('SaleIdempotency') < counterCreate.indexOf('where "DiningTableID" = p_dining_table_id'), 'counter retries must resolve before checking whether a table was later deactivated');
  assert.match(operations, /if v_paid then[\s\S]*?return public\.esmiringkape_staff_order_json\(p_order_id\)/);
});

test('table QR links are public menu links and inactive tokens are rejected without order access', () => {
  assert.match(enhancements, /"PublicToken" uuid not null default gen_random_uuid\(\) unique/);
  assert.match(enhancements, /This table QR link is invalid or inactive/);
  assert.match(enhancements, /alter table public\."GuestOrderAccess" enable row level security/i);
  assert.match(enhancements, /revoke all on public\.[\s\S]*?"GuestOrderAccess" from public, anon, authenticated/i);
  assert.match(enhancements, /grant execute on function public\.esmiringkape_public_menu\(uuid\) to anon, authenticated/);
  assert.match(enhancements, /grant execute on function public\.esmiringkape_track_guest_order_v2\(text\) to anon/);
  assert.match(readFileSync(resolve('src/components/AdminWorkspace.jsx'), 'utf8'), /Production QR codes cannot point to localhost/);
  assert.match(enhancements, /create or replace function public\.esmiringkape_guest_order_json\(p_order_id bigint\)[\s\S]*?'service_type', o\."ServiceType"[\s\S]*?'selected_options'/);
  assert.match(enhancements, /create or replace function public\.esmiringkape_track_guest_order_v2\(p_guest_token text\)[\s\S]*?esmiringkape_guest_order_json\(a\."OrderID"\)/);
  assert.doesNotMatch(enhancements.slice(enhancements.indexOf('create or replace function public.esmiringkape_guest_order_json'), enhancements.indexOf('create or replace function public.esmiringkape_track_guest_order_v2')), /'cashier'|'cash_tendered'|'change_given'/);
  assert.doesNotMatch(enhancements, /grant select on public\."Order"[\s\S]*?to anon/);
});

test('new service type and table fields leave historic orders unassigned and surface drink details to staff', () => {
  assert.match(enhancements, /add column if not exists "ServiceType" text/);
  assert.match(enhancements, /add column if not exists "DiningTableID" bigint references/);
  assert.doesNotMatch(enhancements, /update public\."Order"[\s\S]*?set "DiningTableID"/i);
  assert.match(enhancements, /'service_type', o\."ServiceType"/);
  assert.match(enhancements, /'table_number', t\."TableNumber"/);
  assert.match(enhancements, /'selected_options', coalesce\(oi\."OptionsSnapshot"->'selected_options'/);
});

test('80 mm print CSS selects one ticket or receipt and hides the application UI', () => {
  const css = readFileSync(resolve('src/styles.css'), 'utf8');
  assert.match(css, /@page\s*\{\s*size:\s*80mm auto/);
  assert.match(css, /body\[data-print-type="ticket"\] \.print-document-receipt/);
  assert.match(css, /body\[data-print-type="receipt"\] \.print-document-ticket/);
  assert.match(css, /body \* \{ visibility: hidden !important; \}/);
});
