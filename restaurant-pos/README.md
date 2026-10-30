# Esmiringkape Ordering and POS

React + Vite customer ordering and staff POS backed by Supabase. Customers check out as guests. Cashiers, baristas, and administrators sign in through Supabase Auth; staff permissions are checked in the database and in the UI.

## Local setup

1. Use Node.js 18 or later.
2. From `restaurant-pos`, run `npm ci`.
3. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Run `npm run dev`.

Only the Supabase project URL and publishable anon key belong in the Vite frontend. Never put a `service_role` or secret key in a `VITE_` variable, browser bundle, or checked-in file.

## Database migrations — manual execution required

This repository now contains six ordered SQL migrations. **This workflow did not apply migration 006, and its live migration state was not verified.** On a fresh database, review the scripts on a backup or staging project first, then run each complete file in Supabase SQL Editor in this order. On an existing database, verify that migrations 001–005 have already committed and run only migration 006; do not rerun an applied migration. If migration state is unclear, reconcile the existing objects and data on staging before proceeding:

1. `supabase/migrations/001_staff_access.sql` — Employee/Auth mapping, staff helpers, RLS, and admin-only staff operations.
2. `supabase/migrations/002_sales_snapshots_and_settings.sql` — product image URL, ticket/order snapshots, configurable totals, and receipt settings.
3. `supabase/migrations/003_inventory.sql` — inventory, recipe links, stock movement history, and atomic deduction helper.
4. `supabase/migrations/004_staff_orders_payments_queue.sql` — idempotent POS sale, cash confirmation, ticket list, FIFO claim/status RPCs, and staff reads.
5. `supabase/migrations/005_admin_reports_and_controls.sql` — admin reports, inventory/staff/settings operations, and audited cancellation/refund RPC.
6. `supabase/migrations/006_customization_dining_tables_qr.sql` — coffee customization and price snapshots, option-specific ingredient recipes, dining tables, table QR links, private guest tracking, and configured order RPCs.

The migrations preserve the quoted base tables (`"Employee"`, `"Categories"`, `"MenuItems"`, `"Order"`, `"OrderItem"`, `"Payment"`, and `"OrderStatusHistory"`) and `customers`. Existing guest functions remain available for legacy tickets. The new UI uses `esmiringkape_create_guest_order_v2` and `esmiringkape_track_guest_order_v2` so customization, table assignment, idempotency, and private per-order tracking can be enforced. A read-only live probe confirmed public category/menu endpoints and denied anonymous access to employee, customer, order, order item, payment, and order-status-history tables. That probe did not inspect protected columns or apply any migration. No order was created during verification.

The app’s current code references the existing base columns used by the migrations. If your live schema has additional required columns or nonstandard status values, reconcile the SQL on staging before running it in production. Do not mark a migration complete until Supabase reports that the full file committed successfully.

The counter-sale RPC calculates product prices and configured totals on the server, records payment and stock movements in one transaction, and uses a client-supplied idempotency UUID. The browser preserves the exact guest token and payload across retries; verify on staging that the existing guest RPC returns the same `OrderID` for repeated calls with that token before production. Ticket numbers use the database-generated `OrderID`. Cash is the only supported payment method; no online payment is simulated.

## First administrator

There is no public staff registration and no default password.

1. In Supabase Dashboard, open **Authentication → Users → Add user → Send invitation**. Let the administrator create their own password through the invitation.
2. In the SQL Editor, link that Auth user to an existing `Employee` row and assign the first admin role. Use the Auth user's UUID and a real EmployeeID from the project:

   ```sql
   update public."Employee"
   set "AuthUserID" = '<AUTH_USER_UUID>'::uuid,
       "Role" = 'Admin',
       "EmployeeStatus" = 'Active'
   where "EmployeeID" = <EMPLOYEE_ID>;
   ```

   Confirm exactly one Employee row was updated. If no Employee profile exists, create a row with the project’s required Employee columns, then link it. Keep the SQL Editor restricted to trusted project administrators.
3. Sign in through **Staff Access**. The app verifies the Auth session with Supabase and loads the linked active Employee row.
4. Create later profiles in **Admin → Staff**. Create/invite their Auth accounts in the Supabase Dashboard, then link the UUID in the admin screen.

## Optional development seed

After migrations 001–006, you may run `supabase/seed/dev_seed.sql` on a development database only. In the same SQL session, first run `SET app.esmiringkape_seed_environment = 'development';`, then execute the seed file. It fails unless that explicit session flag is present. It creates a disabled `[DEMO]` menu item and `[DEMO]` inventory, and records sample opening stock separately from real business records. Do not set the flag or run this seed in production.

## Coffee options and inventory before opening

Configure drink groups and options in **Admin → Menu & categories → Coffee options and add-ons**. Each menu item can have its own required selections, defaults, min/max choices, prices, size multipliers, substitutions, add-ons, and restricted group combinations. The editor accepts JSON and includes a size, milk, and espresso example. Inventory IDs are shown on **Admin → Inventory**. `ingredient_multiplier` scales the base recipe for size choices. Option ingredient rows can set `scale_with_size: true` for substitutions such as milk; leave it false for fixed add-ons such as an espresso shot.

Create stock items and base recipe quantities for every product in **Admin → Inventory**. Add ingredient recipes for substitutions and add-ons in the customization JSON. Turn on **Enforce stock recipes** in **Admin → Settings** after recipes are ready. When enabled, the public menu and selected configuration are checked against on-hand stock. The administrator's manual availability setting remains authoritative; stock never reactivates a manually disabled product.

Stock is deducted by `esmiringkape_deduct_order_stock`, called inside `esmiringkape_confirm_cash_payment` from migration 004. Migration 006 replaces the helper's ingredient source with each order item's saved recipe snapshot. Unpaid guest orders do not consume stock. Cash payment, stock row locks, the unique `OrderStockDeduction` marker, payment recording, and FIFO queue entry commit or roll back together. Ingredient rows are locked in ID order, so concurrent payments cannot oversell. Repeated payment retries return the paid order without another deduction. Refunds do not automatically return used ingredients.

The Inventory screen shows reorder thresholds, low-stock labels, and the last 30 days of movement history. Record physical returns, waste, and corrections as separate movements with a reason.

## Dining tables and QR ordering

Add and manage tables in **Admin → Dining tables & QR**. Renaming a table preserves its public QR token; deactivating it makes its link reject new orders. Production builds must set `VITE_PUBLIC_SITE_URL` to the public HTTPS site origin before downloading or printing QR codes. The QR encodes only the public menu link and does not grant access to any order.

To test one complete QR order from a phone during development:

1. Connect the computer and phone to the same Wi-Fi network. Find the computer's LAN IPv4 address with `ipconfig`.
2. In `restaurant-pos/.env`, set `VITE_PUBLIC_SITE_URL=http://<COMPUTER-LAN-IP>:5173` for development only, then restart Vite with `npm run dev -- --host 0.0.0.0`.
3. On staging, configure at least one drink's options and ingredient recipes in **Menu & categories** and **Inventory**. Turn on inventory enforcement only after the recipes and opening quantities are correct.
4. Sign in as admin, open **Dining tables & QR**, add an active table, and download its QR or print the active table sheet.
5. Scan the QR with the phone camera. Confirm the mobile menu shows that table, customize a drink, and verify the updated price before adding it to **Your Order**. Submit the order and confirm its dine-in table in the customer confirmation and cashier order list.
6. Confirm payment in the cashier order list. Verify the ticket enters the FIFO preparation queue only after payment, then check the table and customization on the preparation ticket/receipt. Track the order from the same phone session. Scan the same table QR in a fresh session to confirm it opens a new menu without exposing the first order.

The LAN address is for development and must not be used in production. Set `VITE_PUBLIC_SITE_URL=https://<your-public-domain>` in the deployment environment before building. QR images currently use a public QR image service; it receives only the public menu link being encoded.

## Realtime and fallback

Cashier and admin order screens subscribe to Supabase Realtime and also refresh every 20 seconds. If `"Order"` and `"Payment"` are not already in the `supabase_realtime` publication, add them in the Supabase Realtime settings. The polling refresh remains available when Realtime is disconnected.

## Build and checks

```sh
npm test
npm run build
```

The Node tests cover RPC result mapping, customization selection and pricing, separate configured order lines, table and option retention across retries, cash/change calculations, role gates, FIFO ordering, stock/idempotency contracts, guest token isolation, and receipt item formatting. They do not replace integration tests against a migrated staging database.

## Deployment

Set the production build root to `restaurant-pos`, install with `npm ci`, run `npm run build`, and publish `dist`. Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_PUBLIC_SITE_URL=https://<your-public-domain>` in the deployment provider’s environment settings. Add the production origin to Supabase Auth’s site and redirect URL settings. Use HTTPS, keep Auth invitation/password flows enabled, and never deploy a privileged Supabase key to the browser.

## Backup and recovery

- Before applying migrations, save a database backup and verify that you can restore it to a separate project.
- Supabase dashboard backups and point-in-time recovery depend on the project plan; see [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups).
- For a logical project backup, link the Supabase CLI to the intended project and use `supabase db dump --linked --file schema.sql` for schema and `supabase db dump --linked --use-copy --data-only --file data.sql` for data. The CLI uses Docker; store dumps encrypted outside this repository.
- Restore into a separate project with `psql --single-transaction --variable ON_ERROR_STOP=1 --file schema.sql --command 'SET session_replication_role = replica' --file data.sql --dbname <TARGET_DATABASE_URL>`. Recreate project settings, Auth configuration, and Storage objects separately, then compare row counts and migration state and run order/payment/stock checks before switching traffic.
- Supabase database dumps do not include Storage object files. See [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups) and the [CLI backup and restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

## Remaining live verification

The migration files require manual execution. The successful guest RPC response shape, live staff login, RLS behavior after migration, concurrent stock/payment locking, Realtime publication, receipt printer output, and the complete order-to-collection workflow still need staging verification. The read-only live checks confirmed public menu reads and denied anonymous direct access to employee, customer, order, order item, payment, and order-status-history tables.
