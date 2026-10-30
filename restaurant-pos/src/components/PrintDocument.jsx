import { documentDate, documentItem, formatPHP } from '../lib/document-utils.js';

export default function PrintDocument({ order, kind = 'ticket' }) {
  if (!order) return null;
  const lines = (order.items || []).map(documentItem);
  const subtotal = Number(order.subtotal ?? order.total ?? 0);
  const discount = Number(order.discountTotal || 0);
  const tax = Number(order.taxTotal || 0);
  const total = Number(order.total ?? (subtotal - discount + tax));
  const amountApplied = Number(order.amountPaid ?? order.amountApplied ?? total);
  const paymentStatus = String(order.paymentStatus || order.payment_status || '').trim();
  const paymentConfirmed = ['paid', 'partially refunded', 'refunded'].includes(paymentStatus.toLowerCase());

  return (
    <section className={`print-document print-document-${kind}`} aria-hidden="true">
      <h1>{order.shopName || order.shop_name || 'Esmiringkape'}</h1>
      <h2>{kind === 'receipt' ? 'Receipt' : 'Order Ticket'}</h2>
      <p><span>Ticket</span><strong>#{order.orderNumber ?? order.ticketNumber ?? order.orderId}</strong></p>
      <p><span>Date</span><strong>{documentDate(order.createdAt)}</strong></p>
      {order.serviceType && <p><span>Order type</span><strong>{order.serviceType === 'dine_in' ? `Dine-in · Table ${order.tableNumber || ''}` : 'Takeaway'}</strong></p>}
      {order.guestName && <p><span>Pickup</span><strong>{order.guestName}</strong></p>}
      {kind === 'receipt' && order.cashier && <p><span>Cashier</span><strong>{order.cashier}</strong></p>}
      <div className="print-document-lines">
        {lines.map((line, index) => (
          <div className="print-document-line" key={`${line.name}-${index}`}>
            <span>{line.name} × {line.quantity}</span>
            {line.options.length > 0 && <small className="print-document-options">{line.options.join(' · ')}</small>}
            {kind === 'receipt' && (
              <>
                <small>{formatPHP(line.unitPrice)} each</small>
                <strong>{formatPHP(line.lineTotal)}</strong>
              </>
            )}
          </div>
        ))}
      </div>
      {kind === 'receipt' ? (
        <>
          <p><span>Subtotal</span><strong>{formatPHP(subtotal)}</strong></p>
          {discount > 0 && <p><span>Discount</span><strong>−{formatPHP(discount)}</strong></p>}
          {tax > 0 && <p><span>Tax</span><strong>{formatPHP(tax)}</strong></p>}
          <p className="print-document-total"><span>Total</span><strong>{formatPHP(total)}</strong></p>
          <p><span>Payment</span><strong>{order.paymentMethod || 'Cash'}</strong></p>
          <p><span>Amount applied</span><strong>{formatPHP(amountApplied)}</strong></p>
          {Number(order.refundedAmount ?? order.refunded_amount ?? 0) > 0 && <p><span>Refunded</span><strong>{formatPHP(order.refundedAmount ?? order.refunded_amount)}</strong></p>}
          {order.cashTendered != null && <p><span>Cash tendered</span><strong>{formatPHP(order.cashTendered)}</strong></p>}
          {order.changeGiven != null && <p><span>Change</span><strong>{formatPHP(order.changeGiven)}</strong></p>}
          {order.amountDue != null && Number(order.amountDue) > 0 && <p><span>Balance</span><strong>{formatPHP(order.amountDue)}</strong></p>}
          <p><span>Status</span><strong>{paymentStatus || 'Awaiting Payment'}</strong></p>
        </>
      ) : (
        <p className="print-document-awaiting">{paymentConfirmed ? '' : 'Awaiting Payment'}</p>
      )}
      <footer>{order.receiptFooter || order.receipt_footer || 'Thank you for stopping by.'}</footer>
    </section>
  );
}
