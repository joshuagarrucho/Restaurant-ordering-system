import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Clock3, Printer, RefreshCw, Search } from 'lucide-react';
import { supabase } from '../lib/supabase.js';
import { calculateCashPayment, sortQueueFIFO, formatTableLabel } from '../lib/order-utils.js';
import { dateKeyPH, documentDate, documentItem, formatPHP } from '../lib/document-utils.js';
import PrintDocument from './PrintDocument.jsx';

const isPaid = (order) => ['paid', 'partially refunded', 'refunded'].includes(String(order.paymentStatus || order.payment_status || '').trim().toLowerCase());
const canonicalStatus = (order) => {
  const value = String(order.status || '').toLowerCase();
  return value === 'pending' ? (isPaid(order) ? 'Waiting' : 'Awaiting Payment') : order.status;
};
const nextStatus = (order) => ({ Preparing: 'Ready', Ready: 'Completed' }[canonicalStatus(order)] || null);

export function useStaffOrders(enabled) {
  const [orders, setOrders] = useState([]);
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!enabled) return;
    setError('');
    try {
      const [ordersResult, queueResult] = await Promise.all([
        supabase.rpc('esmiringkape_staff_list_orders'),
        supabase.rpc('esmiringkape_staff_queue'),
      ]);
      if (ordersResult.error) throw ordersResult.error;
      if (queueResult.error) throw queueResult.error;
      setOrders((Array.isArray(ordersResult.data) ? ordersResult.data : []).map(normalizeStaffOrder));
      setQueue(sortQueueFIFO((Array.isArray(queueResult.data) ? queueResult.data : []).map(normalizeStaffOrder)));
    } catch (loadError) {
      setError(loadError.message || 'Could not load staff orders.');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    setLoading(true);
    reload();
    const channel = supabase.channel('esmiringkape-staff-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Order' }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Payment' }, reload)
      .subscribe();
    const fallback = window.setInterval(reload, 20000);
    return () => {
      window.clearInterval(fallback);
      supabase.removeChannel(channel);
    };
  }, [enabled, reload]);

  return { orders, queue, loading, error, reload, setOrders, setQueue };
}

export default function StaffOrderOperations({
  orders,
  queue,
  loading,
  error,
  onRefresh,
  onPayment,
  onStatus,
  onClaimNext,
  busyOrderId,
  role,
  queueMode = false,
  onCancel,
}) {
  const [query, setQuery] = useState('');
  const [date, setDate] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [printPayload, setPrintPayload] = useState(null);
  const [actionError, setActionError] = useState('');
  const canReceivePayment = role === 'admin' || role === 'cashier';
  const source = queueMode ? queue : orders;
  const filtered = useMemo(() => source.filter((order) => {
    const haystack = [order.orderNumber, order.guestName, order.cashier, ...(order.items || []).map((item) => item.item_name)].join(' ').toLowerCase();
    const dateMatches = !date || dateKeyPH(order.createdAt) === date;
    const paymentMatches = paymentFilter === 'all' || (paymentFilter === 'paid' ? isPaid(order) : !isPaid(order));
    const status = canonicalStatus(order).toLowerCase();
    const statusMatches = statusFilter === 'all' || status === statusFilter;
    return haystack.includes(query.trim().toLowerCase()) && dateMatches && paymentMatches && statusMatches;
  }), [date, paymentFilter, query, source, statusFilter]);
  const nextWaitingIndex = queueMode
    ? filtered.findIndex((order) => ['Waiting', 'Pending'].includes(canonicalStatus(order)))
    : -1;

  const print = (order, kind) => {
    setPrintPayload({ order, kind });
    setTimeout(() => {
      document.body.dataset.printType = kind;
      window.addEventListener('afterprint', () => {
        delete document.body.dataset.printType;
        setPrintPayload(null);
      }, { once: true });
      window.print();
    }, 50);
  };

  const takePayment = async (order, amount) => {
    setActionError('');
    const due = Number(order.amountDue ?? order.total);
    if (!calculateCashPayment(due, amount)) {
      setActionError(`Cash received must cover ${formatPHP(due)}.`);
      return;
    }
    await onPayment(order, Number(amount));
  };

  return (
    <section className="staff-orders-view">
      <div className="staff-orders-toolbar">
        <label className="staff-order-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tickets, names, or items" /></label>
        <label><span>Date</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label><span>Payment</span><select value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)}><option value="all">All</option><option value="unpaid">Awaiting Payment</option><option value="paid">Paid</option></select></label>
        <label><span>Order status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All</option><option value="awaiting payment">Awaiting Payment</option><option value="waiting">Waiting</option><option value="preparing">Preparing</option><option value="ready">Ready</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label>
        <button className="button button-secondary compact-action" onClick={onRefresh} disabled={loading}><RefreshCw size={15} /> Refresh</button>
        {queueMode && <button className="button button-primary compact-action" onClick={onClaimNext} disabled={loading || busyOrderId === 'claim-next'}><Check size={15} /> {busyOrderId === 'claim-next' ? 'Claiming…' : 'Claim next'}</button>}
      </div>
      {error && <div className="inline-alert" role="alert">{error}<button className="text-button" onClick={onRefresh}>Try again</button></div>}
      {actionError && <div className="inline-alert" role="alert">{actionError}</div>}
      {loading ? <div className="menu-empty">Loading orders…</div> : filtered.length ? (
        <div className="staff-order-list">
          {filtered.map((order, index) => (
            <StaffOrderCard
              key={order.orderId || order.order_id || order.orderNumber}
              order={order}
              highlight={queueMode && index === nextWaitingIndex}
              expanded={expanded === (order.orderId || order.order_id)}
              onToggle={() => setExpanded((current) => current === (order.orderId || order.order_id) ? null : (order.orderId || order.order_id))}
              onPay={takePayment}
              onStatus={onStatus}
              onPrint={print}
              onCancel={onCancel}
              canCancel={role === 'admin' && Boolean(onCancel)}
              canReceivePayment={canReceivePayment}
              busy={busyOrderId === (order.orderId || order.order_id)}
            />
          ))}
        </div>
      ) : (
        <div className="staff-orders-empty"><Clock3 size={24} /><strong>{queueMode ? 'The queue is clear.' : 'No orders found.'}</strong><span>{queueMode ? 'Paid orders will appear here.' : 'Try a different date or filter.'}</span></div>
      )}
      {printPayload && <PrintDocument order={printPayload.order} kind={printPayload.kind} />}
    </section>
  );
}

function StaffOrderCard({ order, highlight, expanded, onToggle, onPay, onStatus, onPrint, onCancel, canCancel, canReceivePayment, busy }) {
  const [cash, setCash] = useState(String(order.amountDue ?? order.total ?? ''));
  useEffect(() => setCash(String(order.amountDue ?? order.total ?? '')), [order.amountDue, order.total]);
  const status = canonicalStatus(order);
  const paid = isPaid(order);
  const next = nextStatus(order);
  const orderId = order.orderId ?? order.order_id;
  const lines = (order.items || []).map(documentItem);
  return (
    <article className={`staff-order-card ${highlight ? 'staff-order-next' : ''}`}>
      <div className="staff-order-summary">
        <button className="staff-order-open" onClick={onToggle} aria-expanded={expanded}>
          <span className="staff-ticket">Ticket #{order.orderNumber ?? order.ticketNumber ?? orderId}</span>
          {highlight && <span className="staff-next-label">Next</span>}
          <span className="staff-order-meta"><Clock3 size={13} /> {documentDate(order.createdAt)} · {order.orderType === 'counter' ? 'Counter' : 'Guest'} {order.serviceType ? `· ${order.serviceType === 'dine_in' ? `Dine-in · ${formatTableLabel(order.tableNumber)}` : 'Takeaway'}` : ''} {order.guestName ? `· ${order.guestName}` : ''}</span>
          <span className="staff-order-meta">{lines.map((item) => `${item.name} × ${item.quantity}`).join(', ') || 'No item details'}</span>
        </button>
        <div className="staff-order-statuses"><span className={`staff-status-pill ${paid ? 'status-paid' : 'status-unpaid'}`}>{paid ? 'Paid' : 'Awaiting Payment'}</span><span className="staff-status-pill">{status}</span></div>
        <strong className="staff-order-total">{formatPHP(order.total)}</strong>
      </div>
      {expanded && (
        <div className="staff-order-details">
          <div className="staff-order-detail-lines">{lines.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.name} × {item.quantity}{item.options.length > 0 && <small className="staff-line-options">{item.options.join(' · ')}</small>}</span><strong>{formatPHP(item.lineTotal)}</strong></div>)}</div>
          <div className="staff-order-detail-meta"><span>Order: {order.serviceType ? order.serviceType === 'dine_in' ? `Dine-in · ${formatTableLabel(order.tableNumber)}` : 'Takeaway' : 'Legacy order'}</span><span>Pickup: {order.guestName || '—'}</span><span>Cashier: {order.cashier || '—'}</span><span>Order time: {documentDate(order.createdAt)}</span><span>Payment: {order.paymentMethod || order.paymentStatus}</span></div>
          {!paid && canReceivePayment && status !== 'Cancelled' && (
            <div className="staff-order-pay"><label>Cash received <input type="number" min={order.amountDue ?? order.total} step="0.01" value={cash} onChange={(event) => setCash(event.target.value)} /></label><span>Change: {formatPHP(Math.max(0, Number(cash || 0) - Number(order.amountDue ?? order.total)))}</span><button className="button button-primary compact-action" disabled={busy} onClick={() => onPay(order, cash)}>{busy ? 'Saving…' : 'Receive Payment'}</button></div>
          )}
          <div className="staff-order-actions">
            {!paid && <button className="button button-secondary compact-action" onClick={() => onPrint(order, 'ticket')}><Printer size={14} /> Print Ticket</button>}
            {paid && <><button className="button button-secondary compact-action" onClick={() => onPrint(order, 'ticket')}><Printer size={14} /> Print Ticket</button><button className="button button-secondary compact-action" onClick={() => onPrint(order, 'receipt')}><Printer size={14} /> Print Receipt</button></>}
            {paid && next && <button className="button button-primary compact-action" disabled={busy} onClick={() => onStatus(order, next)}>{busy ? 'Saving…' : `${next}`} <ChevronRight size={14} /></button>}
            {canCancel && !['Cancelled', 'Completed'].includes(status) && <button className="text-button danger-text" disabled={busy} onClick={() => {
              if (!window.confirm(`Cancel ticket #${order.orderNumber}?`)) return;
              const reason = window.prompt('Reason for cancellation or refund');
              if (reason?.trim()) onCancel(order, paid ? Number(order.amountPaid ?? order.total) : 0, reason.trim());
            }}>Cancel / refund</button>}
          </div>
        </div>
      )}
    </article>
  );
}

function normalizeStaffOrder(order) {
  return {
    ...order,
    orderId: order.orderId ?? order.order_id,
    orderNumber: order.orderNumber ?? order.order_number ?? order.ticket_number ?? order.order_id,
    ticketNumber: order.ticketNumber ?? order.ticket_number ?? order.order_number ?? order.order_id,
    paymentStatus: order.paymentStatus ?? order.payment_status ?? 'Unpaid',
    amountPaid: order.amountPaid ?? order.amount_paid,
    refundedAmount: order.refundedAmount ?? order.refunded_amount,
    netAmount: order.netAmount ?? order.net_amount,
    amountDue: order.amountDue ?? order.amount_due,
    total: order.total ?? order.TotalAmount ?? 0,
    paymentMethod: order.paymentMethod ?? order.payment_method,
    cashTendered: order.cashTendered ?? order.cash_tendered,
    changeGiven: order.changeGiven ?? order.change_given,
    subtotal: order.subtotal ?? order.Subtotal,
    discountTotal: order.discountTotal ?? order.discount_total,
    taxTotal: order.taxTotal ?? order.tax_total,
    createdAt: order.createdAt ?? order.created_at,
    guestName: order.guestName ?? order.guest_name,
    queueEnteredAt: order.queueEnteredAt ?? order.queue_entered_at,
    cashier: order.cashier ?? order.cashier_name,
    orderType: order.orderType ?? order.order_type,
    tableNumber: order.tableNumber ?? order.table_number,
    shopName: order.shopName ?? order.shop_name,
    receiptFooter: order.receiptFooter ?? order.receipt_footer,
    items: Array.isArray(order.items) ? order.items : [],
  };
}
