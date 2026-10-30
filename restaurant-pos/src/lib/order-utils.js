export const GUEST_CHECKOUT_KEY = 'esmiringkape.guest-checkout';

export const getRpcValue = (record, ...keys) =>
  keys.map((key) => record?.[key]).find((value) => value !== undefined && value !== null);

export const formatTableLabel = (value) => {
  const name = String(value ?? '').trim();
  if (!name) return 'Table —';
  const tableName = name.replace(/^table(?:\s+|$)/i, '').trim();
  return tableName ? `Table ${tableName}` : 'Table';
};

export const buildTableOrderingUrl = (siteUrl, menuPath, publicToken) => {
  const url = new URL(menuPath || '/', siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`);
  url.searchParams.set('table', publicToken);
  return url.toString();
};

export const resolveGuestTableToken = (search, savedCheckout = null) =>
  new URLSearchParams(search).get('table') || savedCheckout?.payload?.p_table_token || '';

const getSingleRpcResult = (data) => {
  if (data == null) return null;
  if (typeof data === 'string') {
    try {
      return getSingleRpcResult(JSON.parse(data));
    } catch {
      return null;
    }
  }
  if (Array.isArray(data)) {
    const firstObject = data.find((entry) => entry && typeof entry === 'object');
    return getSingleRpcResult(firstObject) || getSingleRpcResult(data[0]) || null;
  }
  if (typeof data === 'object' && 'data' in data && data.data !== undefined) {
    return getSingleRpcResult(data.data);
  }
  if (typeof data === 'object' && Object.keys(data).length === 1) {
    const [value] = Object.values(data);
    if (value && typeof value === 'object') return getSingleRpcResult(value);
  }
  return typeof data === 'object' ? data : null;
};

export const normalizeGuestOrder = (data) => {
  const record = getSingleRpcResult(data);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

  const orderId = getRpcValue(record, 'order_id', 'OrderID', 'id');
  const status = getRpcValue(record, 'status', 'Status', 'order_status', 'OrderStatus');
  const total = getRpcValue(record, 'total', 'Total', 'grand_total', 'total_amount', 'TotalAmount', 'amount_due', 'AmountDue');
  const paymentStatus = getRpcValue(record, 'payment_status', 'PaymentStatus', 'payment_state');
  const orderNumber = getRpcValue(record, 'order_number', 'OrderNumber', 'ticket_number', 'TicketNumber', 'ticket_no');
  const guestName = getRpcValue(record, 'guest_name', 'GuestName', 'pickup_name');

  if (
    orderId == null ||
    typeof status !== 'string' ||
    !status.trim() ||
    total == null ||
    !Number.isFinite(Number(total)) ||
    Number(total) < 0 ||
    paymentStatus == null ||
    !String(paymentStatus).trim()
  ) return null;

  const items = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.order_items)
      ? record.order_items
      : Array.isArray(record.OrderItems)
        ? record.OrderItems
        : [];

  return {
    orderId,
    orderNumber: orderNumber ?? orderId,
    status,
    total: Number(total),
    paymentStatus,
    items,
    createdAt: getRpcValue(record, 'created_at', 'createdAt', 'OrderDate', 'order_date', 'ordered_at') ?? null,
    guestName: guestName ?? null,
    amountPaid: getRpcValue(record, 'amount_paid', 'AmountPaid') ?? null,
    refundedAmount: getRpcValue(record, 'refunded_amount', 'RefundedAmount') ?? 0,
    netAmount: getRpcValue(record, 'net_amount', 'NetAmount') ?? null,
    amountDue: getRpcValue(record, 'amount_due', 'AmountDue') ?? null,
    subtotal: Number(getRpcValue(record, 'subtotal', 'Subtotal') ?? total),
    discountTotal: Number(getRpcValue(record, 'discount_total', 'DiscountTotal', 'discount_amount', 'DiscountAmount') ?? 0),
    taxTotal: Number(getRpcValue(record, 'tax_total', 'TaxTotal', 'tax_amount', 'TaxAmount') ?? 0),
    cashier: getRpcValue(record, 'cashier', 'CashierName', 'cashier_name') ?? null,
    orderType: getRpcValue(record, 'order_type', 'OrderType') ?? null,
    serviceType: getRpcValue(record, 'service_type', 'ServiceType') ?? null,
    diningTableId: getRpcValue(record, 'dining_table_id', 'DiningTableID') ?? null,
    tableNumber: getRpcValue(record, 'table_number', 'TableNumber') ?? null,
    paymentMethod: getRpcValue(record, 'payment_method', 'PaymentMethod') ?? null,
    cashTendered: getRpcValue(record, 'cash_tendered', 'CashTendered') ?? null,
    changeGiven: getRpcValue(record, 'change_given', 'ChangeGiven', 'change') ?? null,
    queueEnteredAt: getRpcValue(record, 'queue_entered_at', 'QueueEnteredAt') ?? null,
    history: Array.isArray(record.history) ? record.history : [],
  };
};

export const normalizeStaffRole = (role) => {
  const normalized = String(role || '').trim().toLowerCase();
  if (['administrator', 'admin'].includes(normalized)) return 'admin';
  if (['cashier', 'barista'].includes(normalized)) return normalized;
  return null;
};

export const isPostgresErrorCode = (code) => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);

export const canAccessModule = (role, module) => {
  const normalized = normalizeStaffRole(role);
  if (!normalized) return false;
  if (normalized === 'admin') return true;
  if (normalized === 'cashier') return ['pos', 'orders', 'queue'].includes(module);
  return normalized === 'barista' && module === 'queue';
};

export const calculateCashPayment = (amountDue, cashTendered) => {
  const due = Number(amountDue);
  const tendered = Number(cashTendered);
  if (!Number.isFinite(due) || due < 0 || !Number.isFinite(tendered) || tendered < due) {
    return null;
  }
  return {
    amountApplied: Math.round(due * 100) / 100,
    cashTendered: Math.round(tendered * 100) / 100,
    changeGiven: Math.round((tendered - due) * 100) / 100,
  };
};

export const sortQueueFIFO = (orders) => [...orders].sort((a, b) => {
  const aTime = Date.parse(a.queueEnteredAt || a.QueueEnteredAt || 0) || 0;
  const bTime = Date.parse(b.queueEnteredAt || b.QueueEnteredAt || 0) || 0;
  if (aTime !== bTime) return aTime - bTime;
  const aId = Number(a.orderId ?? a.OrderID ?? 0);
  const bId = Number(b.orderId ?? b.OrderID ?? 0);
  return aId - bId;
});

export const applyStockMovements = (stock, movements, deduplicatedOrders = new Set()) => {
  const nextStock = new Map(stock);
  const seen = new Set(deduplicatedOrders);
  for (const movement of movements) {
    if (seen.has(movement.orderId)) continue;
    const current = Number(nextStock.get(movement.inventoryItemId) || 0);
    const quantity = Number(movement.quantity || 0);
    if (!Number.isFinite(quantity) || quantity < 0 || current < quantity) return null;
    nextStock.set(movement.inventoryItemId, current - quantity);
    seen.add(movement.orderId);
  }
  return { stock: nextStock, deduplicatedOrders: seen };
};

export const normalizedOptionIds = (values = []) => [...new Set((values || []).map((value) => String(value)))].sort();

export const orderLineKey = (itemId, optionIds = []) =>
  `${itemId}:${normalizedOptionIds(optionIds).join(',')}`;

export const customizationSelectionValid = (item, selectedOptionIds = []) => {
  const selected = new Set(normalizedOptionIds(selectedOptionIds));
  if (selected.size !== (selectedOptionIds || []).length) return false;
  for (const group of item?.groups || []) {
    const count = (group.options || []).filter((option) => selected.has(String(option.option_id))).length;
    const min = Number(group.min_selections ?? (group.required ? 1 : 0));
    const max = Number(group.max_selections ?? (group.selection_type === 'single' ? 1 : Infinity));
    if (count < min || count > max || (group.selection_type === 'single' && count > 1)) return false;
  }
  const optionIdsFound = (item?.groups || []).flatMap((group) => group.options || [])
    .filter((option) => selected.has(String(option.option_id))).length;
  return optionIdsFound === selected.size;
};

export const customizationUnitPrice = (item, selectedOptionIds = []) => {
  const selected = new Set(normalizedOptionIds(selectedOptionIds));
  const delta = (item?.groups || []).flatMap((group) => group.options || [])
    .filter((option) => selected.has(String(option.option_id)))
    .reduce((sum, option) => sum + Number(option.price_delta || 0), 0);
  return Math.round((Number(item?.Price || 0) + delta) * 100) / 100;
};

export const customizationLabels = (item, selectedOptionIds = []) => {
  const selected = new Set(normalizedOptionIds(selectedOptionIds));
  return (item?.groups || []).flatMap((group) => (group.options || [])
    .filter((option) => selected.has(String(option.option_id)))
    .map((option) => `${group.name}: ${option.name}`));
};

const isRetryableRequest = (value) =>
  Boolean(value?.token && Array.isArray(value?.payload?.p_items));

export const prepareGuestOrderRequest = ({
  storage,
  pendingRequest,
  cart,
  pickupName,
  serviceType,
  tableToken,
  createToken,
}) => {
  let request = pendingRequest;
  if (!isRetryableRequest(request)) {
    let stored = null;
    try {
      stored = JSON.parse(storage.getItem(GUEST_CHECKOUT_KEY) || 'null');
    } catch {
      stored = null;
    }
    request = isRetryableRequest(stored)
      ? stored
      : (() => {
        const token = createToken();
        return {
          token,
          cart,
          payload: {
          p_items: cart.map((line) => {
            const item = { item_id: line.ItemID ?? line.item_id, quantity: line.quantity };
            const selected = normalizedOptionIds(line.selectedOptionIds || line.selected_option_ids || []);
            if (selected.length) item.selected_option_ids = selected.map(Number);
            return item;
          }),
            p_guest_token: token,
            p_guest_name: pickupName.trim() || null,
            ...(serviceType ? { p_service_type: serviceType } : {}),
            ...(tableToken ? { p_table_token: tableToken } : {}),
          },
        };
      })();
  }

  storage.setItem(GUEST_CHECKOUT_KEY, JSON.stringify(request));
  return request;
};

export const COUNTER_SALE_KEY = 'esmiringkape.counter-sale';

export const prepareCounterSaleRequest = ({ storage, pendingRequest, items, customerId, pickupName, cashTendered, amountDue, serviceType, diningTableId, createToken }) => {
  if (pendingRequest?.idempotencyKey && pendingRequest?.payload?.p_items) return pendingRequest;
  let stored = null;
  try {
    stored = JSON.parse(storage.getItem(COUNTER_SALE_KEY) || 'null');
  } catch {
    stored = null;
  }
  if (stored?.idempotencyKey && stored?.payload?.p_items) return stored;
  const idempotencyKey = createToken();
  const request = {
    idempotencyKey,
    cart: items,
    amountDue: Number(amountDue),
    payload: {
      p_idempotency_key: idempotencyKey,
      p_items: items.map((line) => {
        const item = { item_id: line.ItemID ?? line.item_id, quantity: line.quantity };
        const selected = normalizedOptionIds(line.selectedOptionIds || line.selected_option_ids || []);
        if (selected.length) item.selected_option_ids = selected.map(Number);
        return item;
      }),
      p_customer_id: customerId ? Number(customerId) : null,
      p_pickup_name: pickupName?.trim() || null,
      p_cash_tendered: Number(cashTendered),
      ...(serviceType ? { p_service_type: serviceType } : {}),
      ...(diningTableId ? { p_dining_table_id: Number(diningTableId) } : {}),
    },
  };
  storage.setItem(COUNTER_SALE_KEY, JSON.stringify(request));
  return request;
};
