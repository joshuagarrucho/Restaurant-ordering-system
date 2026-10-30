-- 001: Staff identity and RLS boundary. Run manually in Supabase SQL Editor.
-- Existing Employee.AuthUserID values are preserved; link staff only after an Auth user exists.
begin;

alter table public."Employee"
  add column if not exists "AuthUserID" uuid references auth.users(id) on delete set null;

-- Repair a legacy text UUID column safely; stop without changing data if it contains non-UUID values.
do $$
declare
  v_type text;
  v_attnum smallint;
begin
  select udt_name into v_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'Employee' and column_name = 'AuthUserID';
  if v_type <> 'uuid' then
    if exists (
      select 1 from public."Employee"
      where "AuthUserID" is not null
        and btrim("AuthUserID"::text) <> ''
        and btrim("AuthUserID"::text) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      raise exception 'Employee.AuthUserID contains non-UUID values; reconcile those mappings before migration 001';
    end if;
    alter table public."Employee" alter column "AuthUserID" type uuid
      using nullif(btrim("AuthUserID"::text), '')::uuid;
  end if;

  select a.attnum into v_attnum
  from pg_attribute a
  where a.attrelid = 'public."Employee"'::regclass and a.attname = 'AuthUserID' and not a.attisdropped;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public."Employee"'::regclass
      and c.confrelid = 'auth.users'::regclass
      and c.contype = 'f'
      and c.conkey = array[v_attnum]::smallint[]
  ) then
    alter table public."Employee" add constraint employee_auth_user_id_fkey
      foreign key ("AuthUserID") references auth.users(id) on delete set null;
  end if;
end;
$$;

create unique index if not exists employee_auth_user_id_unique
  on public."Employee" ("AuthUserID") where "AuthUserID" is not null;

create or replace function public.esmiringkape_staff_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case lower(trim(e."Role"))
    when 'administrator' then 'admin'
    when 'admin' then 'admin'
    when 'cashier' then 'cashier'
    when 'barista' then 'barista'
    else null
  end
  from public."Employee" e
  where e."AuthUserID" = auth.uid()
    and lower(trim(e."EmployeeStatus")) = 'active'
  limit 1;
$$;

create or replace function public.esmiringkape_current_employee_id()
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select e."EmployeeID"::bigint
  from public."Employee" e
  where e."AuthUserID" = auth.uid()
    and lower(trim(e."EmployeeStatus")) = 'active'
  limit 1;
$$;

revoke all on function public.esmiringkape_staff_role() from public, anon;
revoke all on function public.esmiringkape_current_employee_id() from public, anon;
grant execute on function public.esmiringkape_staff_role() to authenticated;
grant execute on function public.esmiringkape_current_employee_id() to authenticated;

do $$
declare v_policy record;
begin
  for v_policy in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('Employee', 'Categories', 'MenuItems', 'customers', 'Order', 'OrderItem', 'Payment', 'OrderStatusHistory')
  loop
    execute format('drop policy %I on %I.%I', v_policy.policyname, v_policy.schemaname, v_policy.tablename);
  end loop;
end;
$$;

alter table public."Employee" enable row level security;
revoke all on public."Employee" from public, anon, authenticated;
grant select on public."Employee" to authenticated;
drop policy if exists employee_self_or_admin_read on public."Employee";
create policy employee_self_or_admin_read on public."Employee"
  for select to authenticated
  using ("AuthUserID" = auth.uid() or public.esmiringkape_staff_role() = 'admin');

-- Role changes and Auth links can only be made by an already linked administrator.
create or replace function public.esmiringkape_admin_set_employee(
  p_employee_id bigint,
  p_auth_user_id uuid,
  p_role text,
  p_active boolean,
  p_full_name text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if lower(coalesce(p_role, '')) not in ('admin', 'administrator', 'cashier', 'barista') then
    raise exception 'Role must be admin, cashier, or barista' using errcode = '22023';
  end if;
  if exists (
    select 1 from public."Employee" current_admin
    where current_admin."EmployeeID" = p_employee_id
      and lower(trim(current_admin."Role")) in ('admin', 'administrator')
      and lower(trim(current_admin."EmployeeStatus")) = 'active'
      and current_admin."AuthUserID" is not null
  ) and (
    not p_active
    or lower(trim(p_role)) not in ('admin', 'administrator')
    or p_auth_user_id is null
  ) and not exists (
    select 1 from public."Employee" other_admin
    where other_admin."EmployeeID" <> p_employee_id
      and lower(trim(other_admin."Role")) in ('admin', 'administrator')
      and lower(trim(other_admin."EmployeeStatus")) = 'active'
      and other_admin."AuthUserID" is not null
  ) then
    raise exception 'Keep at least one active administrator linked to Supabase Auth';
  end if;
  update public."Employee"
  set "AuthUserID" = p_auth_user_id,
      "Role" = case when lower(p_role) = 'administrator' then 'Admin' else initcap(p_role) end,
      "EmployeeStatus" = case when p_active then 'Active' else 'Inactive' end,
      "FullName" = coalesce(nullif(trim(p_full_name), ''), "FullName")
  where "EmployeeID" = p_employee_id;
  if not found then raise exception 'Employee not found' using errcode = 'P0002'; end if;
end;
$$;
revoke all on function public.esmiringkape_admin_set_employee(bigint, uuid, text, boolean, text) from public, anon;
grant execute on function public.esmiringkape_admin_set_employee(bigint, uuid, text, boolean, text) to authenticated;

create or replace function public.esmiringkape_admin_create_employee(
  p_full_name text,
  p_role text,
  p_auth_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_employee public."Employee"%rowtype;
begin
  if public.esmiringkape_staff_role() is distinct from 'admin' then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if nullif(trim(p_full_name), '') is null or lower(coalesce(p_role, '')) not in ('admin', 'administrator', 'cashier', 'barista') then
    raise exception 'A name and valid role are required' using errcode = '22023';
  end if;
  insert into public."Employee" ("FullName", "Role", "EmployeeStatus", "AuthUserID")
  values (trim(p_full_name), case when lower(p_role) = 'administrator' then 'Admin' else initcap(p_role) end, 'Active', p_auth_user_id)
  returning * into v_employee;
  return jsonb_build_object('EmployeeID', v_employee."EmployeeID", 'FullName', v_employee."FullName", 'Role', v_employee."Role", 'EmployeeStatus', v_employee."EmployeeStatus", 'AuthUserID', v_employee."AuthUserID");
end;
$$;
revoke all on function public.esmiringkape_admin_create_employee(text, text, uuid) from public, anon;
grant execute on function public.esmiringkape_admin_create_employee(text, text, uuid) to authenticated;

-- Guest menu reads remain public. Only active staff with the admin role can edit it.
alter table public."Categories" enable row level security;
alter table public."MenuItems" enable row level security;
revoke all on public."Categories", public."MenuItems" from public, anon, authenticated;
grant select on public."Categories", public."MenuItems" to anon, authenticated;
grant insert, update, delete on public."Categories", public."MenuItems" to authenticated;
drop policy if exists categories_public_read on public."Categories";
create policy categories_public_read on public."Categories" for select to anon, authenticated using (true);
drop policy if exists categories_admin_write on public."Categories";
create policy categories_admin_write on public."Categories" for all to authenticated
  using (public.esmiringkape_staff_role() = 'admin')
  with check (public.esmiringkape_staff_role() = 'admin');
drop policy if exists menu_items_public_read on public."MenuItems";
create policy menu_items_public_read on public."MenuItems" for select to anon, authenticated using (true);
drop policy if exists menu_items_admin_write on public."MenuItems";
create policy menu_items_admin_write on public."MenuItems" for all to authenticated
  using (public.esmiringkape_staff_role() = 'admin')
  with check (public.esmiringkape_staff_role() = 'admin');

-- Customer and transaction records are never directly available to guest sessions.
revoke all on public.customers, public."Order", public."OrderItem", public."Payment", public."OrderStatusHistory"
  from public, anon;
alter table public."Order" enable row level security;
alter table public."OrderItem" enable row level security;
alter table public."Payment" enable row level security;
alter table public."OrderStatusHistory" enable row level security;
revoke all on public."Order", public."OrderItem", public."Payment", public."OrderStatusHistory"
  from anon, authenticated;

alter table public.customers enable row level security;
revoke all on public.customers from anon;
grant select, insert, update on public.customers to authenticated;
drop policy if exists customer_staff_access on public.customers;
create policy customer_staff_access on public.customers for all to authenticated
  using (public.esmiringkape_staff_role() in ('admin', 'cashier'))
  with check (public.esmiringkape_staff_role() in ('admin', 'cashier'));

commit;
