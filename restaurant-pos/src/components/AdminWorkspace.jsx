import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Boxes, Check, ChevronRight, LayoutDashboard, LogOut, Plus, RefreshCw, Save, Settings2, ShoppingBag, Users } from 'lucide-react';
import { supabase } from '../lib/supabase.js';
import { dateKeyPH, exportCSV, formatPHP } from '../lib/document-utils.js';
import { buildTableOrderingUrl, formatTableLabel } from '../lib/order-utils.js';
import StaffOrderOperations, { useStaffOrders } from './StaffOrderOperations.jsx';

const asArray = (data) => Array.isArray(data) ? data : [];
const today = () => dateKeyPH(new Date());
const startOfMonth = () => `${today().slice(0, 8)}01`;

export default function AdminWorkspace({ user, employeeProfile, onSignOut, PosDashboard }) {
  const [module, setModule] = useState('dashboard');
  const [from, setFrom] = useState(startOfMonth());
  const [to, setTo] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyOrderId, setBusyOrderId] = useState(null);
  const staffOrders = useStaffOrders(module === 'orders' || module === 'queue');

  const load = useCallback(async () => {
    if (module === 'pos' || module === 'orders' || module === 'queue') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      let result;
      if (module === 'dashboard') result = await supabase.rpc('esmiringkape_admin_dashboard_metrics', { p_from: from, p_to: to });
      else if (module === 'menu') {
        const [categories, items, customizations] = await Promise.all([
          supabase.from('Categories').select('CategoryID, CategoryName').order('CategoryName'),
          supabase.from('MenuItems').select('ItemID, ItemName, Price, CategoryID, Available, ImageURL').order('ItemName'),
          supabase.rpc('esmiringkape_admin_list_menu_customizations'),
        ]);
        if (categories.error) throw categories.error;
        if (items.error) throw items.error;
        if (customizations.error) throw customizations.error;
        setData({ categories: categories.data || [], items: items.data || [], customizations: asArray(customizations.data) });
        return;
      } else if (module === 'inventory') {
        const start = new Date(); start.setDate(start.getDate() - 30);
        const [inventory, recipes, movements] = await Promise.all([
          supabase.rpc('esmiringkape_admin_inventory_list'),
          supabase.rpc('esmiringkape_admin_list_recipes'),
          supabase.rpc('esmiringkape_admin_inventory_movements', { p_from: dateKeyPH(start), p_to: today() }),
        ]);
        if (inventory.error) throw inventory.error;
        if (recipes.error) throw recipes.error;
        if (movements.error) throw movements.error;
        setData({ inventory: asArray(inventory.data), recipes: asArray(recipes.data), movements: asArray(movements.data) });
        return;
      } else if (module === 'tables') result = await supabase.rpc('esmiringkape_admin_list_dining_tables');
      else if (module === 'staff') result = await supabase.rpc('esmiringkape_admin_list_employees');
      else if (module === 'reports') {
        const [sales, movements] = await Promise.all([
          supabase.rpc('esmiringkape_admin_sales_report', { p_from: from, p_to: to }),
          supabase.rpc('esmiringkape_admin_inventory_movements', { p_from: from, p_to: to }),
        ]);
        if (sales.error) throw sales.error;
        if (movements.error) throw movements.error;
        setData({ sales: asArray(sales.data), movements: asArray(movements.data) });
        return;
      } else if (module === 'settings') result = await supabase.rpc('esmiringkape_admin_get_settings');
      if (result?.error) throw result.error;
      setData(result?.data ?? null);
    } catch (loadError) {
      setError(loadError.message || 'This module could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [from, module, to]);

  useEffect(() => { load(); }, [load]);

  const run = async (promise, successMessage) => {
    setError('');
    setNotice('');
    try {
      const result = await promise;
      if (result?.error) throw result.error;
      setNotice(successMessage);
      await load();
      return result?.data;
    } catch (actionError) {
      setError(actionError.message || 'The update could not be saved.');
      return null;
    }
  };

  const nav = [
    ['dashboard', 'Dashboard', LayoutDashboard], ['pos', 'POS', ShoppingBag], ['orders', 'Orders', Activity],
    ['queue', 'FIFO queue', ChevronRight], ['menu', 'Menu & categories', Boxes], ['tables', 'Dining tables & QR', Boxes], ['inventory', 'Inventory', Boxes],
    ['staff', 'Staff', Users], ['reports', 'Reports', BarChart3], ['settings', 'Settings', Settings2],
  ];
  if (module === 'pos') return <PosDashboard user={user} employeeProfile={employeeProfile} authError="" onSignOut={onSignOut} onReturnToAdmin={() => setModule('dashboard')} />;

  return (
    <main className="admin-shell">
      <aside className="sidebar admin-sidebar">
        <div className="admin-brand"><span className="brand-mark"><ShoppingBag size={19} /></span><strong>Esmiringkape</strong></div>
        <div className="sidebar-rule" />
        <div className="sidebar-label">ADMIN</div>
        <nav className="admin-nav" aria-label="Administrator modules">
          {nav.map(([key, label, Icon]) => <button key={key} className={`nav-item ${module === key ? 'nav-item-active' : ''}`} onClick={() => setModule(key)}><Icon size={17} /><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-bottom">
          <button className="cashier-profile" onClick={onSignOut} title="Sign out"><span className="avatar">{employeeProfile.FullName?.slice(0, 1)?.toUpperCase() || 'A'}</span><span className="cashier-meta"><strong>{employeeProfile.FullName}</strong><small>Administrator</small></span><LogOut size={16} /></button>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar"><div className="topbar-title"><span className="eyebrow">ESMIRINGKAPE · ADMIN</span><h1>{nav.find(([key]) => key === module)?.[1]}</h1></div><div className="topbar-right"><button className="button button-secondary compact-action" onClick={load} disabled={loading}><RefreshCw size={15} /> Refresh</button></div></header>
        <main className="admin-content">
          {error && <div className="inline-alert" role="alert">{error}</div>}
          {notice && <div className="success-note" role="status"><Check size={15} />{notice}</div>}
          {['dashboard', 'reports'].includes(module) && <DateFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />}
          {loading ? <div className="menu-empty">Loading {module}…</div> : module === 'dashboard' ? <DashboardModule data={data} />
            : module === 'orders' || module === 'queue' ? <StaffOrderOperations
              orders={staffOrders.orders} queue={staffOrders.queue} loading={staffOrders.loading} error={staffOrders.error}
              onRefresh={staffOrders.reload} onPayment={async (order, amount) => { const id = Number(order.order_id); setBusyOrderId(id); try { const result = await run(supabase.rpc('esmiringkape_confirm_cash_payment', { p_order_id: id, p_cash_tendered: amount }), 'Payment recorded.'); await staffOrders.reload(); return result; } finally { setBusyOrderId(null); } }}
              onStatus={async (order, status) => { const id = Number(order.order_id); setBusyOrderId(id); try { const result = await run(supabase.rpc('esmiringkape_update_preparation_status', { p_order_id: id, p_status: status }), 'Preparation status updated.'); await staffOrders.reload(); return result; } finally { setBusyOrderId(null); } }}
              onClaimNext={async () => { setBusyOrderId('claim-next'); try { const result = await run(supabase.rpc('esmiringkape_claim_next_order'), 'Next ticket claimed.'); await staffOrders.reload(); return result; } finally { setBusyOrderId(null); } }}
              onCancel={async (order, refundAmount, reason) => { const id = Number(order.order_id); setBusyOrderId(id); try { const result = await run(supabase.rpc('esmiringkape_admin_cancel_order', { p_order_id: id, p_refund_amount: refundAmount, p_reason: reason }), 'Order cancelled and audited.'); await staffOrders.reload(); return result; } finally { setBusyOrderId(null); } }}
              busyOrderId={busyOrderId} role="admin" queueMode={module === 'queue'} />
            : module === 'menu' ? <MenuModule data={data} reload={load} run={run} />
            : module === 'tables' ? <DiningTablesModule data={data} run={run} />
            : module === 'inventory' ? <InventoryModule data={data} reload={load} run={run} />
            : module === 'staff' ? <StaffModule data={data} reload={load} run={run} />
            : module === 'reports' ? <ReportsModule data={data} from={from} to={to} />
            : module === 'settings' ? <><SettingsModule data={data} reload={load} run={run} /><InventoryEnforcementSetting settings={data?.settings} run={run} /></> : null}
        </main>
      </section>
    </main>
  );
}

function DateFilter({ from, to, setFrom, setTo }) {
  return <div className="admin-date-filter"><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>;
}

function DashboardModule({ data }) {
  if (!data) return <div className="admin-empty">No dashboard data yet.</div>;
  const metrics = [['Sales', formatPHP(data.sales_total)], ['Orders', data.order_count], ['Active queue', data.active_queue], ['Awaiting payment', data.unpaid_orders], ['Low stock', data.low_stock]];
  return <><div className="admin-metric-grid">{metrics.map(([label, value]) => <article className="admin-metric-card" key={label}><span>{label}</span><strong>{value}</strong></article>)}</div><section className="admin-panel"><h2>Low stock</h2>{(data.low_stock_items || []).length ? <div className="admin-table-wrap"><table><thead><tr><th>Item</th><th>On hand</th><th>Reorder at</th></tr></thead><tbody>{data.low_stock_items.map((item) => <tr key={item.inventory_item_id}><td>{item.name}</td><td>{item.quantity_on_hand} {item.unit}</td><td>{item.reorder_threshold} {item.unit}</td></tr>)}</tbody></table></div> : <p className="muted">No low stock alerts.</p>}</section></>;
}

function MenuModule({ data, reload, run }) {
  const customizationExample = JSON.stringify({
    groups: [
      { name: 'Size', selection_type: 'single', required: true, min_selections: 1, max_selections: 1, options: [
        { name: '12 oz', price_delta: 0, is_default: true, ingredient_multiplier: 0.8 },
        { name: '16 oz', price_delta: 25, ingredient_multiplier: 1.2 },
      ] },
      { name: 'Milk', selection_type: 'single', required: true, min_selections: 1, max_selections: 1, options: [
        { name: 'Regular', is_default: true },
        { name: 'Oat', price_delta: 20, ingredients: [{ inventory_item_id: 4, quantity_required: 180, replaces_inventory_item_id: 2, scale_with_size: true }] },
      ] },
      { name: 'Add-ons', selection_type: 'multiple', min_selections: 0, max_selections: 3, options: [
        { name: 'Extra espresso shot', price_delta: 25, ingredients: [{ inventory_item_id: 1, quantity_required: 18 }] },
      ] },
    ],
    restricted_group_pairs: [],
  }, null, 2);
  const [categoryName, setCategoryName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [draft, setDraft] = useState({ ItemID: '', ItemName: '', CategoryID: '', Price: '', Available: true, ImageURL: '' });
  const [customItemId, setCustomItemId] = useState('');
  const [customizationJson, setCustomizationJson] = useState('{\n  "groups": []\n}');
  const [customizationError, setCustomizationError] = useState('');
  const [busy, setBusy] = useState(false);
  const currentCustomization = (data?.customizations || []).find((entry) => String(entry.item_id) === String(customItemId));
  useEffect(() => {
    if (!customItemId && data?.items?.length) setCustomItemId(String(data.items[0].ItemID));
  }, [customItemId, data?.items]);
  useEffect(() => {
    if (currentCustomization) setCustomizationJson(JSON.stringify({ groups: currentCustomization.groups || [], restricted_group_pairs: currentCustomization.restricted_group_pairs || [] }, null, 2));
    else if (customItemId) setCustomizationJson('{\n  "groups": []\n}');
  }, [customItemId, data?.customizations]);
  const saveCategory = async (event) => {
    event.preventDefault(); setBusy(true);
    const result = categoryId
      ? await run(supabase.from('Categories').update({ CategoryName: categoryName.trim() }).eq('CategoryID', categoryId).select().maybeSingle(), 'Category updated.')
      : await run(supabase.from('Categories').insert({ CategoryName: categoryName.trim() }).select().maybeSingle(), 'Category added.');
    if (result) { setCategoryName(''); setCategoryId(''); } setBusy(false);
  };
  const saveItem = async (event) => {
    event.preventDefault(); setBusy(true);
    const values = { ItemName: draft.ItemName.trim(), CategoryID: draft.CategoryID || null, Price: Number(draft.Price), Available: draft.Available, ImageURL: draft.ImageURL.trim() || null };
    const result = draft.ItemID
      ? await run(supabase.from('MenuItems').update(values).eq('ItemID', draft.ItemID).select().maybeSingle(), 'Product updated.')
      : await run(supabase.from('MenuItems').insert(values).select().maybeSingle(), 'Product added.');
    if (result) setDraft({ ItemID: '', ItemName: '', CategoryID: '', Price: '', Available: true, ImageURL: '' }); setBusy(false);
  };
  const deactivate = async (item) => { setBusy(true); await run(supabase.from('MenuItems').update({ Available: false }).eq('ItemID', item.ItemID).select().maybeSingle(), 'Product deactivated.'); setBusy(false); };
  const saveCustomizations = async (event) => {
    event.preventDefault();
    setBusy(true); setCustomizationError('');
    try {
      const configuration = JSON.parse(customizationJson);
      if (!Array.isArray(configuration.groups)) throw new Error('Add a groups array to the configuration.');
      await run(supabase.rpc('esmiringkape_admin_save_menu_customizations', { p_menu_item_id: Number(customItemId), p_configuration: configuration }), 'Drink options saved.');
    } catch (error) {
      setCustomizationError(error.message || 'Customization JSON is not valid.');
    }
    setBusy(false);
  };
  return <div className="admin-module-grid">
    <section className="admin-panel"><h2>Categories</h2><form className="admin-inline-form" onSubmit={saveCategory}><input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Category name" required /><button className="button button-primary compact-action" disabled={busy}>{categoryId ? <Save size={15} /> : <Plus size={15} />}{categoryId ? ' Save' : ' Add'}</button>{categoryId && <button type="button" className="text-button" onClick={() => { setCategoryId(''); setCategoryName(''); }}>Cancel</button>}</form><div className="admin-chip-list">{(data?.categories || []).map((item) => <button type="button" key={item.CategoryID} onClick={() => { setCategoryId(String(item.CategoryID)); setCategoryName(item.CategoryName); }}>{item.CategoryName} · Edit</button>)}</div></section>
    <section className="admin-panel"><h2>{draft.ItemID ? 'Edit product' : 'Add product'}</h2><form className="admin-form-grid" onSubmit={saveItem}><label>Name<input value={draft.ItemName} onChange={(event) => setDraft({ ...draft, ItemName: event.target.value })} required /></label><label>Category<select value={draft.CategoryID} onChange={(event) => setDraft({ ...draft, CategoryID: event.target.value })}><option value="">Choose</option>{(data?.categories || []).map((category) => <option key={category.CategoryID} value={category.CategoryID}>{category.CategoryName}</option>)}</select></label><label>Price (PHP)<input type="number" min="0" step="0.01" value={draft.Price} onChange={(event) => setDraft({ ...draft, Price: event.target.value })} required /></label><label>Image URL<input type="url" value={draft.ImageURL} onChange={(event) => setDraft({ ...draft, ImageURL: event.target.value })} placeholder="https://…" /></label><label className="admin-check"><input type="checkbox" checked={draft.Available} onChange={(event) => setDraft({ ...draft, Available: event.target.checked })} /> Available to order</label><button className="button button-primary compact-action" disabled={busy}><Save size={15} /> Save product</button></form></section>
    <section className="admin-panel admin-panel-wide"><h2>Coffee options and add-ons</h2><p className="muted">Configure only the choices that apply to each drink. Price and recipe effects are validated in Supabase.</p><form onSubmit={saveCustomizations} className="admin-customization-form"><label>Menu item<select value={customItemId} onChange={(event) => setCustomItemId(event.target.value)} required><option value="">Choose</option>{(data?.items || []).map((item) => <option value={item.ItemID} key={item.ItemID}>{item.ItemName}</option>)}</select></label><label>Configuration (JSON)<textarea className="admin-json-editor" value={customizationJson} onChange={(event) => setCustomizationJson(event.target.value)} spellCheck="false" /></label><small>Groups accept name, selection_type, required, min_selections, max_selections, and options. Options accept name, price_delta, is_default, ingredient_multiplier and ingredients. Ingredients accept inventory_item_id, quantity_required, and optional replaces_inventory_item_id. The Inventory screen shows stock item IDs.</small>{customizationError && <p className="form-error" role="alert">{customizationError}</p>}<button className="button button-primary compact-action" disabled={busy || !customItemId}><Save size={15} /> Save drink options</button><details><summary>Example size, milk, and espresso add-on</summary><pre>{customizationExample}</pre></details></form></section>
    <section className="admin-panel admin-panel-wide"><h2>Products</h2><div className="admin-table-wrap"><table><thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Availability</th><th>Actions</th></tr></thead><tbody>{(data?.items || []).map((item) => <tr key={item.ItemID}><td>{item.ItemName}</td><td>{data.categories.find((category) => String(category.CategoryID) === String(item.CategoryID))?.CategoryName || '—'}</td><td>{formatPHP(item.Price)}</td><td>{item.Available ? 'Available' : 'Unavailable'}</td><td><div className="admin-row-actions"><button className="text-button" onClick={() => { setDraft({ ...item, ItemID: String(item.ItemID), CategoryID: String(item.CategoryID || ''), Price: String(item.Price), ImageURL: item.ImageURL || '' }); setCustomItemId(String(item.ItemID)); }}>Edit</button>{item.Available && <button className="text-button danger-text" disabled={busy} onClick={() => deactivate(item)}>Deactivate</button>}</div></td></tr>)}</tbody></table></div></section>
  </div>;
}

function DiningTablesModule({ data, run }) {
  const [tableId, setTableId] = useState(null);
  const [tableNumber, setTableNumber] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qrError, setQrError] = useState('');
  const [qrNotice, setQrNotice] = useState('');
  const [qrImages, setQrImages] = useState({});
  const [printTableIds, setPrintTableIds] = useState(null);
  const tables = asArray(data);
  const configuredSite = import.meta.env.VITE_PUBLIC_SITE_URL?.trim();
  const configuredMenuPath = import.meta.env.VITE_PUBLIC_MENU_PATH?.trim() || '/';
  let baseUrl = '';
  let menuPath = '/';
  let siteError = '';
  try {
    const candidate = configuredSite || (!import.meta.env.PROD ? window.location.origin : '');
    if (!candidate) throw new Error('Set VITE_PUBLIC_SITE_URL to your public HTTPS website before creating production QR codes.');
    const parsed = new URL(candidate);
    if (import.meta.env.PROD && parsed.protocol !== 'https:') throw new Error('Production QR codes require a public HTTPS website address.');
    if (import.meta.env.PROD && (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname))) {
      throw new Error('Production QR codes cannot point to localhost. Set VITE_PUBLIC_SITE_URL to your public HTTPS website.');
    }
    baseUrl = parsed.origin;
    const route = new URL(configuredMenuPath, `${baseUrl}/`);
    menuPath = route.pathname || '/';
  } catch (error) {
    siteError = error.message;
  }
  const orderUrl = (table) => {
    if (!baseUrl) return '';
    return buildTableOrderingUrl(baseUrl, menuPath, table.public_token);
  };
  useEffect(() => {
    let active = true;
    if (!baseUrl) {
      setQrImages({});
      return () => { active = false; };
    }
    import('qrcode').then(({ default: QRCode }) => Promise.all(tables.map(async (table) => [
      String(table.table_id),
      await QRCode.toDataURL(orderUrl(table), { width: 320, margin: 1, errorCorrectionLevel: 'H' }),
    ]))).then((entries) => {
      if (active) setQrImages(Object.fromEntries(entries));
    }).catch((error) => {
      if (active) setQrError(`QR images could not be generated: ${error.message || 'try again.'}`);
    });
    return () => { active = false; };
  }, [data, baseUrl, menuPath]);
  const reset = () => { setTableId(null); setTableNumber(''); setActive(true); };
  const save = async (event) => {
    event.preventDefault(); setBusy(true);
    const result = await run(supabase.rpc('esmiringkape_admin_save_dining_table', { p_table_id: tableId, p_table_number: tableNumber.trim(), p_active: active }), tableId ? 'Dining table updated. Its QR link stays the same.' : 'Dining table added.');
    if (result) reset();
    setBusy(false);
  };
  const copyLink = async (table) => {
    setQrError('');
    setQrNotice('');
    try {
      const link = orderUrl(table);
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(link);
          copied = true;
        } catch { /* Use the browser fallback below when clipboard permission is denied. */ }
      }
      if (!copied) {
        const input = document.createElement('textarea');
        input.value = link;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        const fallbackCopied = document.execCommand('copy');
        input.remove();
        if (!fallbackCopied) throw new Error('Clipboard access is unavailable in this browser.');
      }
      setQrNotice(`${formatTableLabel(table.table_number)} link copied.`);
    } catch (error) {
      setQrError(error.message || 'The table link could not be copied.');
    }
  };
  const download = (table) => {
    setQrError('');
    const image = qrImages[String(table.table_id)];
    if (!image) return;
    const link = document.createElement('a');
    link.href = image;
    link.download = `esmiringkape-${String(table.table_number).trim().replace(/[^\w-]+/g, '-')}.png`;
    link.click();
  };
  const printSheet = async (ids = tables.filter((table) => table.is_active).map((table) => String(table.table_id))) => {
    setQrError('');
    setPrintTableIds(ids);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const images = [...document.querySelectorAll('.qr-print-sheet img')];
    try {
      await Promise.all(images.map((image) => image.decode()));
      if (!images.length || images.some((image) => !image.naturalWidth)) throw new Error('A QR image could not be loaded. Retry once the QR preview is available.');
    } catch (error) {
      setPrintTableIds(null);
      setQrError(error.message || 'The QR sheet could not be prepared.');
      return;
    }
    document.body.dataset.printType = 'qr-sheet';
    window.addEventListener('afterprint', () => {
      delete document.body.dataset.printType;
      setPrintTableIds(null);
    }, { once: true });
    window.print();
  };
  return <div className="admin-module-grid">
    <section className="admin-panel"><h2>{tableId ? 'Rename or update table' : 'Add dining table'}</h2><p className="muted">Table links stay stable when a table is renamed. Deactivated table links stop accepting orders.</p><form className="admin-form-grid" onSubmit={save}><label>Table name or number<input value={tableNumber} onChange={(event) => setTableNumber(event.target.value)} placeholder="1" required /></label><label className="admin-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Active for ordering</label><button className="button button-primary compact-action" disabled={busy}><Save size={15} /> {busy ? 'Saving…' : 'Save table'}</button>{tableId && <button type="button" className="button button-secondary compact-action" onClick={reset}>Cancel edit</button>}</form></section>
    <section className="admin-panel"><h2>QR address</h2><p className={siteError ? 'form-error' : 'muted'}>{siteError || `QR links use ${baseUrl}${menuPath}`}</p><p className="muted">Development tip: use VITE_PUBLIC_SITE_URL with your computer’s LAN address when testing from a phone. Production requires HTTPS. QR images are generated in this browser.</p><button className="button button-primary compact-action" disabled={!baseUrl || !tables.some((table) => table.is_active) || tables.some((table) => table.is_active && !qrImages[String(table.table_id)])} onClick={() => printSheet()}>Print active table QR sheet</button></section>
    {qrError && <p className="form-error admin-panel-wide" role="alert">{qrError}</p>}
    {qrNotice && <p className="success-note admin-panel-wide" role="status"><Check size={15} />{qrNotice}</p>}
    <section className="admin-panel admin-panel-wide"><h2>Dining tables</h2><div className="admin-table-wrap"><table><thead><tr><th>QR preview</th><th>Table</th><th>Status</th><th>Public ordering link</th><th>Actions</th></tr></thead><tbody>{tables.map((table) => <tr key={table.table_id}><td>{qrImages[String(table.table_id)] ? <img className="admin-table-qr-preview" src={qrImages[String(table.table_id)]} alt={`QR code for ${formatTableLabel(table.table_number)}`} /> : <span className="muted">Generating…</span>}</td><td><strong>{formatTableLabel(table.table_number)}</strong></td><td>{table.is_active ? 'Active' : 'Inactive'}</td><td>{baseUrl ? <a href={orderUrl(table)} target="_blank" rel="noreferrer">{orderUrl(table)}</a> : 'Set a public website URL'}</td><td><div className="admin-row-actions"><button className="text-button" onClick={() => { setTableId(table.table_id); setTableNumber(table.table_number); setActive(table.is_active); }}>Rename</button><button className="text-button" disabled={!baseUrl || !qrImages[String(table.table_id)]} onClick={() => copyLink(table)}>Copy Link</button><button className="text-button" disabled={!baseUrl || !qrImages[String(table.table_id)]} onClick={() => download(table)}>Download PNG</button><button className="text-button" disabled={!baseUrl || !qrImages[String(table.table_id)]} onClick={() => printSheet([String(table.table_id)])}>Print</button><button className="text-button" disabled={busy} onClick={() => { setBusy(true); run(supabase.rpc('esmiringkape_admin_save_dining_table', { p_table_id: table.table_id, p_table_number: table.table_number, p_active: !table.is_active }), table.is_active ? 'Table deactivated.' : 'Table activated.').finally(() => setBusy(false)); }}>{table.is_active ? 'Deactivate' : 'Activate'}</button></div></td></tr>)}</tbody></table></div></section>
    <div className="qr-print-sheet" aria-hidden="true"><h1>Esmiringkape · Scan to order</h1><div className="qr-print-grid">{tables.filter((table) => (!printTableIds ? table.is_active : printTableIds.includes(String(table.table_id)))).map((table) => <article key={table.table_id}><img src={qrImages[String(table.table_id)] || ''} alt="" /><h2>{formatTableLabel(table.table_number)}</h2><p>Scan to order</p></article>)}</div></div>
  </div>;
}

function InventoryModule({ data, reload, run }) {
  const [draft, setDraft] = useState({ Name: '', ItemType: 'ingredient', Unit: '', ReorderThreshold: '0', OpeningQuantity: '0' });
  const [movement, setMovement] = useState({ inventoryId: '', type: 'receipt', quantity: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [thresholds, setThresholds] = useState({});
  const inventory = data?.inventory || [];
  useEffect(() => setThresholds(Object.fromEntries(inventory.map((item) => [item.InventoryItemID, String(item.ReorderThreshold)]))), [data]);
  const createItem = async (event) => { event.preventDefault(); setBusy(true); const result = await run(supabase.rpc('esmiringkape_admin_create_inventory_item', { p_name: draft.Name.trim(), p_item_type: draft.ItemType, p_unit: draft.Unit.trim(), p_reorder_threshold: Number(draft.ReorderThreshold), p_opening_quantity: Number(draft.OpeningQuantity) }), 'Inventory item created.'); if (result) setDraft({ Name: '', ItemType: 'ingredient', Unit: '', ReorderThreshold: '0', OpeningQuantity: '0' }); setBusy(false); };
  const adjust = async (event) => { event.preventDefault(); setBusy(true); let quantity = Number(movement.quantity); if (movement.type === 'waste' && quantity > 0) quantity *= -1; const result = await run(supabase.rpc('esmiringkape_admin_adjust_inventory', { p_inventory_item_id: Number(movement.inventoryId), p_quantity_change: quantity, p_movement_type: movement.type, p_reason: movement.reason.trim() }), 'Stock movement recorded.'); if (result) setMovement({ ...movement, quantity: '', reason: '' }); setBusy(false); };
  const updateInventory = async (item, active = item.IsActive) => { setBusy(true); await run(supabase.rpc('esmiringkape_admin_update_inventory_settings', { p_inventory_item_id: item.InventoryItemID, p_reorder_threshold: Number(thresholds[item.InventoryItemID]), p_active: active }), active === item.IsActive ? 'Inventory settings saved.' : active ? 'Stock item activated.' : 'Stock item deactivated.'); setBusy(false); };
  return <div className="admin-module-grid">
    <section className="admin-panel"><h2>Add stock item</h2><form className="admin-form-grid" onSubmit={createItem}><label>Name<input value={draft.Name} onChange={(event) => setDraft({ ...draft, Name: event.target.value })} required /></label><label>Type<select value={draft.ItemType} onChange={(event) => setDraft({ ...draft, ItemType: event.target.value })}><option value="ingredient">Ingredient</option><option value="finished_good">Finished good</option></select></label><label>Unit<input value={draft.Unit} onChange={(event) => setDraft({ ...draft, Unit: event.target.value })} placeholder="g, ml, pcs" required /></label><label>Reorder threshold<input type="number" min="0" step="0.001" value={draft.ReorderThreshold} onChange={(event) => setDraft({ ...draft, ReorderThreshold: event.target.value })} /></label><label>Opening quantity<input type="number" min="0" step="0.001" value={draft.OpeningQuantity} onChange={(event) => setDraft({ ...draft, OpeningQuantity: event.target.value })} /></label><button className="button button-primary compact-action" disabled={busy}><Plus size={15} /> Add item</button></form></section>
    <section className="admin-panel"><h2>Receive, return, waste, or adjust</h2><form className="admin-form-grid" onSubmit={adjust}><label>Stock item<select value={movement.inventoryId} onChange={(event) => setMovement({ ...movement, inventoryId: event.target.value })} required><option value="">Choose</option>{inventory.map((item) => <option key={item.InventoryItemID} value={item.InventoryItemID}>{item.Name}</option>)}</select></label><label>Reason<input value={movement.reason} onChange={(event) => setMovement({ ...movement, reason: event.target.value })} required /></label><label>Movement<select value={movement.type} onChange={(event) => setMovement({ ...movement, type: event.target.value })}><option value="receipt">Stock receipt (+)</option><option value="return">Physical stock return (+)</option><option value="waste">Waste (deduct)</option><option value="adjustment">Adjustment (signed)</option></select></label><label>Quantity<input type="number" min={movement.type === 'adjustment' ? undefined : '0.001'} step="0.001" value={movement.quantity} onChange={(event) => setMovement({ ...movement, quantity: event.target.value })} required /></label><button className="button button-primary compact-action" disabled={busy}><Save size={15} /> Record movement</button></form></section>
    <section className="admin-panel"><h2>Recipe quantities</h2><RecipeEditor inventory={inventory} run={run} /></section>
    <section className="admin-panel admin-panel-wide"><h2>Stock on hand</h2><p className="muted">Low stock means quantity on hand is at or below the reorder threshold.</p><div className="admin-table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>On hand</th><th>Reorder threshold</th><th>Status</th><th>Action</th></tr></thead><tbody>{inventory.map((item) => { const low = item.IsActive && Number(item.QuantityOnHand) <= Number(item.ReorderThreshold); return <tr key={item.InventoryItemID}><td>{item.InventoryItemID}</td><td>{item.Name}</td><td>{item.ItemType === 'finished_good' ? 'Finished good' : 'Ingredient'}</td><td>{item.QuantityOnHand} {item.Unit}</td><td><input aria-label={`Reorder threshold for ${item.Name}`} type="number" min="0" step="0.001" value={thresholds[item.InventoryItemID] ?? item.ReorderThreshold} onChange={(event) => setThresholds({ ...thresholds, [item.InventoryItemID]: event.target.value })} /></td><td><span className={`stock-state ${low ? 'stock-state-low' : ''}`}>{item.IsActive ? low ? 'Low stock · reorder' : 'In stock' : 'Inactive'}</span></td><td><div className="admin-row-actions"><button className="text-button" disabled={busy} onClick={() => updateInventory(item)}>Save</button><button className="text-button" disabled={busy} onClick={() => updateInventory(item, !item.IsActive)}>{item.IsActive ? 'Deactivate' : 'Activate'}</button></div></td></tr>; })}</tbody></table></div><h3>Ingredient quantities per menu item</h3><div className="admin-table-wrap"><table><thead><tr><th>Menu item</th><th>Stock item</th><th>Quantity per sale</th><th>Unit</th></tr></thead><tbody>{(data?.recipes || []).map((recipe) => <tr key={`${recipe.menu_item_id}-${recipe.inventory_item_id}`}><td>{recipe.menu_item_name}</td><td>{recipe.inventory_item_name}</td><td>{recipe.quantity_required}</td><td>{recipe.unit}</td></tr>)}</tbody></table></div><h3>Recent stock movements · 30 days</h3><div className="admin-table-wrap"><table><thead><tr><th>Date</th><th>Ingredient</th><th>Movement</th><th>Change</th><th>Reason / ticket</th><th>Staff</th></tr></thead><tbody>{(data?.movements || []).map((movement) => <tr key={movement.movement_id}><td>{movement.created_at ? new Date(movement.created_at).toLocaleString('en-PH') : '—'}</td><td>{movement.name}</td><td>{String(movement.movement_type).replaceAll('_', ' ')}</td><td>{movement.quantity_change}</td><td>{movement.order_id ? `Ticket #${movement.order_id} · ` : ''}{movement.reason}</td><td>{movement.employee || 'System sale'}</td></tr>)}</tbody></table></div><p className="muted">Refunds do not restore used ingredients. Physical returns and stock corrections are recorded as separate movements.</p></section>
  </div>;
}

function RecipeEditor({ inventory, run }) {
  const [menuItems, setMenuItems] = useState([]);
  const [draft, setDraft] = useState({ menuItemId: '', inventoryItemId: '', quantity: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { supabase.from('MenuItems').select('ItemID, ItemName').order('ItemName').then(({ data }) => setMenuItems(data || [])); }, []);
  const save = async (event) => { event.preventDefault(); setSaving(true); const result = await run(supabase.rpc('esmiringkape_admin_set_recipe', { p_menu_item_id: Number(draft.menuItemId), p_inventory_item_id: Number(draft.inventoryItemId), p_quantity_required: Number(draft.quantity) }), 'Recipe quantity saved.'); if (result !== null) setDraft({ menuItemId: '', inventoryItemId: '', quantity: '' }); setSaving(false); };
  return <form className="admin-form-grid" onSubmit={save}><label>Menu item<select value={draft.menuItemId} onChange={(event) => setDraft({ ...draft, menuItemId: event.target.value })} required><option value="">Choose</option>{menuItems.map((item) => <option key={item.ItemID} value={item.ItemID}>{item.ItemName}</option>)}</select></label><label>Stock item<select value={draft.inventoryItemId} onChange={(event) => setDraft({ ...draft, inventoryItemId: event.target.value })} required><option value="">Choose</option>{inventory.map((item) => <option key={item.InventoryItemID} value={item.InventoryItemID}>{item.Name} ({item.Unit})</option>)}</select></label><label>Quantity per menu item<input type="number" min="0.001" step="0.001" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value })} required /></label><button className="button button-primary compact-action" disabled={saving}><Save size={15} /> Save recipe</button></form>;
}

function StaffModule({ data, run }) {
  const employees = asArray(data);
  const [drafts, setDrafts] = useState({});
  const [newStaff, setNewStaff] = useState({ FullName: '', Role: 'cashier', AuthUserID: '' });
  useEffect(() => setDrafts(Object.fromEntries(employees.map((employee) => [employee.EmployeeID, { AuthUserID: employee.AuthUserID || '', FullName: employee.FullName || '', Role: String(employee.Role || 'cashier').toLowerCase(), Active: employee.EmployeeStatus === 'Active' }]))), [data]);
  const save = async (employee) => { const draft = drafts[employee.EmployeeID]; await run(supabase.rpc('esmiringkape_admin_set_employee', { p_employee_id: Number(employee.EmployeeID), p_auth_user_id: draft.AuthUserID || null, p_role: draft.Role, p_active: draft.Active, p_full_name: draft.FullName }), 'Staff profile updated.'); };
  const create = async (event) => { event.preventDefault(); const result = await run(supabase.rpc('esmiringkape_admin_create_employee', { p_full_name: newStaff.FullName.trim(), p_role: newStaff.Role, p_auth_user_id: newStaff.AuthUserID || null }), 'Staff profile created.'); if (result) setNewStaff({ FullName: '', Role: 'cashier', AuthUserID: '' }); };
  return <section className="admin-panel"><h2>Employee profiles</h2><p className="muted">Create Supabase Auth users through the Supabase dashboard, then link their user ID. There is no public registration.</p><form className="admin-form-grid staff-create-form" onSubmit={create}><label>Name<input value={newStaff.FullName} onChange={(event) => setNewStaff({ ...newStaff, FullName: event.target.value })} required /></label><label>Role<select value={newStaff.Role} onChange={(event) => setNewStaff({ ...newStaff, Role: event.target.value })}><option value="cashier">Cashier</option><option value="barista">Barista</option><option value="admin">Admin</option></select></label><label>Existing Auth user ID <small>optional</small><input value={newStaff.AuthUserID} onChange={(event) => setNewStaff({ ...newStaff, AuthUserID: event.target.value })} placeholder="UUID" /></label><button className="button button-primary compact-action"><Plus size={15} /> Create profile</button></form><div className="admin-table-wrap"><table><thead><tr><th>Name</th><th>Auth user ID</th><th>Role</th><th>Active</th><th>Action</th></tr></thead><tbody>{employees.map((employee) => { const draft = drafts[employee.EmployeeID] || {}; return <tr key={employee.EmployeeID}><td><input value={draft.FullName || ''} onChange={(event) => setDrafts({ ...drafts, [employee.EmployeeID]: { ...draft, FullName: event.target.value } })} /></td><td><input value={draft.AuthUserID || ''} onChange={(event) => setDrafts({ ...drafts, [employee.EmployeeID]: { ...draft, AuthUserID: event.target.value } })} placeholder="UUID" /></td><td><select value={draft.Role || 'cashier'} onChange={(event) => setDrafts({ ...drafts, [employee.EmployeeID]: { ...draft, Role: event.target.value } })}><option value="cashier">Cashier</option><option value="barista">Barista</option><option value="admin">Admin</option></select></td><td><input type="checkbox" checked={Boolean(draft.Active)} onChange={(event) => setDrafts({ ...drafts, [employee.EmployeeID]: { ...draft, Active: event.target.checked } })} /></td><td><button className="text-button" onClick={() => save(employee)}>Save</button></td></tr>; })}</tbody></table></div></section>;
}

function ReportsModule({ data, from, to }) {
  const [report, setReport] = useState('sales');
  const sales = data?.sales || [];
  const rows = useMemo(() => {
    if (report === 'inventory') return data?.movements || [];
    if (report === 'products') {
      const totals = new Map();
      for (const order of sales.filter((entry) => ['paid', 'partially refunded', 'refunded'].includes(String(entry.payment_status).toLowerCase()))) for (const item of order.items || []) {
        const itemId = item.item_id ?? item.item_name;
        const current = totals.get(itemId) || { itemId, name: item.item_name || 'Item', quantity: 0, amount: 0 };
        current.quantity += Number(item.quantity); current.amount += Number(item.line_total); totals.set(itemId, current);
      }
      return Array.from(totals, ([name, value]) => ({ name, ...value }));
    }
    if (report === 'payments') {
      const totals = new Map();
      for (const order of sales.filter((entry) => ['paid', 'partially refunded', 'refunded'].includes(String(entry.payment_status).toLowerCase()))) {
        const method = order.payment_method || 'Other';
        const current = totals.get(method) || { count: 0, amount: 0, refund: 0, cash: 0, change: 0 };
        current.count += 1; current.amount += Number(order.amount_paid || 0); current.refund += Number(order.refunded_amount || 0); current.cash += Number(order.cash_tendered || 0); current.change += Number(order.change_given || 0); totals.set(method, current);
      }
      return Array.from(totals, ([method, value]) => ({ method, ...value }));
    }
    return sales;
  }, [data, report, sales]);
  const exportRows = () => {
    const map = {
      inventory: [['Date', 'Item', 'Movement', 'Quantity', 'Reason', 'Employee'], ...rows.map((row) => [row.created_at, row.name, row.movement_type, row.quantity_change, row.reason, row.employee])],
      products: [['Product', 'Quantity sold', 'Sales'], ...rows.map((row) => [row.name, row.quantity, row.amount])],
      payments: [['Method', 'Orders', 'Amount applied', 'Refunds', 'Cash tendered', 'Change'], ...rows.map((row) => [row.method, row.count, row.amount, row.refund, row.cash, row.change])],
      sales: [['Ticket', 'Date', 'Pickup', 'Payment', 'Status', 'Subtotal', 'Discount', 'Tax', 'Total', 'Refunded', 'Net paid'], ...rows.map((row) => [row.ticket_number, row.created_at, row.guest_name, row.payment_status, row.status, row.subtotal, row.discount_total, row.tax_total, row.total, row.refunded_amount, row.net_amount])],
    };
    exportCSV(map[report], `${report}-${from}-${to}.csv`);
  };
  const paidTotal = sales.reduce((sum, row) => ['paid', 'partially refunded', 'refunded'].includes(String(row.payment_status).toLowerCase()) ? sum + Number(row.net_amount || 0) : sum, 0);
  return <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Reports</h2><p className="muted">{from} to {to} · {rows.length} rows · Net paid sales {formatPHP(paidTotal)}</p></div><button className="button button-secondary compact-action" onClick={exportRows}><BarChart3 size={15} /> Export CSV</button></div><div className="admin-report-tabs">{[['sales','Sales'],['payments','Payment methods'],['products','Product sales'],['inventory','Inventory']].map(([key,label]) => <button className={report === key ? 'active' : ''} onClick={() => setReport(key)} key={key}>{label}</button>)}</div><div className="admin-table-wrap"><table><thead>{report === 'inventory' ? <tr><th>Date</th><th>Item</th><th>Movement</th><th>Quantity</th><th>Reason</th><th>Employee</th></tr> : report === 'products' ? <tr><th>Product</th><th>Quantity sold</th><th>Sales</th></tr> : report === 'payments' ? <tr><th>Method</th><th>Orders</th><th>Amount applied</th><th>Refunds</th><th>Cash tendered</th><th>Change</th></tr> : <tr><th>Ticket</th><th>Date</th><th>Pickup</th><th>Payment</th><th>Status</th><th>Subtotal</th><th>Discount</th><th>Tax</th><th>Total</th><th>Refunded</th><th>Net paid</th></tr>}</thead><tbody>{report === 'inventory' ? rows.map((row) => <tr key={row.movement_id}><td>{row.created_at}</td><td>{row.name}</td><td>{row.movement_type}</td><td>{row.quantity_change}</td><td>{row.reason}</td><td>{row.employee || '—'}</td></tr>) : report === 'products' ? rows.map((row) => <tr key={row.itemId}><td>{row.name}</td><td>{row.quantity}</td><td>{formatPHP(row.amount)}</td></tr>) : report === 'payments' ? rows.map((row) => <tr key={row.method}><td>{row.method}</td><td>{row.count}</td><td>{formatPHP(row.amount)}</td><td>{formatPHP(row.refund)}</td><td>{formatPHP(row.cash)}</td><td>{formatPHP(row.change)}</td></tr>) : rows.map((row) => <tr key={row.order_id}><td>#{row.ticket_number}</td><td>{row.created_at}</td><td>{row.guest_name || '—'}</td><td>{row.payment_method || row.payment_status}</td><td>{row.status}</td><td>{formatPHP(row.subtotal)}</td><td>{formatPHP(row.discount_total)}</td><td>{formatPHP(row.tax_total)}</td><td>{formatPHP(row.total)}</td><td>{formatPHP(row.refunded_amount)}</td><td>{formatPHP(row.net_amount)}</td></tr>)}</tbody></table></div></section>;
}

function SettingsModule({ data, reload, run }) {
  const settings = data?.settings || {};
  const [shopName, setShopName] = useState(settings.shop_name || 'Esmiringkape');
  const [footer, setFooter] = useState(settings.receipt_footer || '');
  const [taxName, setTaxName] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [discountName, setDiscountName] = useState('');
  const [discountRate, setDiscountRate] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setShopName(settings.shop_name || 'Esmiringkape'); setFooter(settings.receipt_footer || ''); }, [settings.shop_name, settings.receipt_footer]);
  const save = async (key, value) => { setBusy(true); await run(supabase.rpc('esmiringkape_admin_save_setting', { p_key: key, p_value: value }), 'Receipt setting saved.'); setBusy(false); };
  const addTax = async (event) => { event.preventDefault(); setBusy(true); const result = await run(supabase.rpc('esmiringkape_admin_save_tax_rule', { p_rule_id: null, p_name: taxName.trim(), p_rate: Number(taxRate), p_active: true }), 'Tax rule saved.'); if (result) { setTaxName(''); setTaxRate(''); } setBusy(false); };
  const toggleTax = async (rule) => { setBusy(true); await run(supabase.rpc('esmiringkape_admin_save_tax_rule', { p_rule_id: rule.TaxRuleID, p_name: rule.Name, p_rate: Number(rule.RatePercent), p_active: !rule.IsActive }), 'Tax rule updated.'); setBusy(false); };
  const addDiscount = async (event) => { event.preventDefault(); setBusy(true); const result = await run(supabase.rpc('esmiringkape_admin_save_discount_rule', { p_rule_id: null, p_name: discountName.trim(), p_rate: Number(discountRate), p_active: true }), 'Discount rule saved.'); if (result) { setDiscountName(''); setDiscountRate(''); } setBusy(false); };
  const toggleDiscount = async (rule) => { setBusy(true); await run(supabase.rpc('esmiringkape_admin_save_discount_rule', { p_rule_id: rule.DiscountRuleID, p_name: rule.Name, p_rate: Number(rule.RatePercent), p_active: !rule.IsActive }), 'Discount rule updated.'); setBusy(false); };
  return <div className="admin-module-grid"><section className="admin-panel"><h2>Shop and receipt</h2><label className="admin-setting-field">Shop name<input value={shopName} onChange={(event) => setShopName(event.target.value)} /></label><button className="button button-primary compact-action" disabled={busy} onClick={() => save('shop_name', shopName)}>Save shop name</button><label className="admin-setting-field">Receipt footer<textarea rows="3" value={footer} onChange={(event) => setFooter(event.target.value)} /></label><button className="button button-primary compact-action" disabled={busy} onClick={() => save('receipt_footer', footer)}>Save footer</button></section><section className="admin-panel"><h2>Configured taxes</h2><p className="muted">No tax is applied unless a rule is enabled.</p><form className="admin-inline-form" onSubmit={addTax}><input value={taxName} onChange={(event) => setTaxName(event.target.value)} placeholder="Rule name" required /><input type="number" min="0" max="100" step="0.0001" value={taxRate} onChange={(event) => setTaxRate(event.target.value)} placeholder="Percent" required /><button className="button button-primary compact-action" disabled={busy}><Plus size={15} /> Add</button></form><div className="admin-rule-list">{(data?.tax_rules || []).map((rule) => <div key={rule.TaxRuleID}><span>{rule.Name} · {rule.RatePercent}%</span><button className="text-button" disabled={busy} onClick={() => toggleTax(rule)}>{rule.IsActive ? 'Disable' : 'Enable'}</button></div>)}</div></section><section className="admin-panel"><h2>Configured discounts</h2><p className="muted">Active rules are applied to newly calculated sales.</p><form className="admin-inline-form" onSubmit={addDiscount}><input value={discountName} onChange={(event) => setDiscountName(event.target.value)} placeholder="Rule name" required /><input type="number" min="0" max="100" step="0.0001" value={discountRate} onChange={(event) => setDiscountRate(event.target.value)} placeholder="Percent" required /><button className="button button-primary compact-action" disabled={busy}><Plus size={15} /> Add</button></form><div className="admin-rule-list">{(data?.discount_rules || []).map((rule) => <div key={rule.DiscountRuleID}><span>{rule.Name} · {rule.RatePercent}%</span><button className="text-button" disabled={busy} onClick={() => toggleDiscount(rule)}>{rule.IsActive ? 'Disable' : 'Enable'}</button></div>)}</div></section></div>;
}

function InventoryEnforcementSetting({ settings = {}, run }) {
  const [enabled, setEnabled] = useState(settings.inventory_enforced === 'true');
  const [busy, setBusy] = useState(false);
  useEffect(() => setEnabled(settings.inventory_enforced === 'true'), [settings.inventory_enforced]);
  const save = async () => {
    setBusy(true);
    await run(supabase.rpc('esmiringkape_admin_save_setting', {
      p_key: 'inventory_enforced',
      p_value: String(enabled),
    }), enabled ? 'Inventory enforcement enabled.' : 'Inventory enforcement disabled.');
    setBusy(false);
  };
  return <section className="admin-panel admin-inventory-setting"><h2>Stock checks at payment</h2><p className="muted">When enabled, every available product must have an active stock recipe. Payments fail atomically if a recipe is missing or stock is insufficient.</p><label className="admin-setting-field admin-toggle-setting"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Enforce stock recipes</span></label><button className="button button-primary compact-action" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save stock setting'}</button></section>;
}
