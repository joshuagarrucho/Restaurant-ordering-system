import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COUNTER_SALE_KEY,
  GUEST_CHECKOUT_KEY,
  applyStockMovements,
  calculateCashPayment,
  canAccessModule,
  customizationSelectionValid,
  customizationUnitPrice,
  customizationLabels,
  isPostgresErrorCode,
  normalizeStaffRole,
  normalizeGuestOrder,
  prepareCounterSaleRequest,
  prepareGuestOrderRequest,
  orderLineKey,
  sortQueueFIFO,
} from '../src/lib/order-utils.js';
import { documentItem, formatPHP } from '../src/lib/document-utils.js';

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

test('normalizes an RPC function wrapper and aliases its ticket fields', () => {
  const order = normalizeGuestOrder([{
    esmiringkape_place_guest_order: {
      order_id: 42,
      ticket_number: '42',
      order_status: 'Pending',
      grand_total: '125.50',
      payment_state: 'Unpaid',
      created_at: '2026-10-28T12:00:00Z',
      pickup_name: 'Mika',
      order_items: [{ item_name: 'Latte', quantity: 1 }],
    },
  }]);

  assert.equal(order.orderId, 42);
  assert.equal(order.orderNumber, '42');
  assert.equal(order.status, 'Pending');
  assert.equal(order.total, 125.5);
  assert.equal(order.guestName, 'Mika');
  assert.equal(order.items[0].item_name, 'Latte');
});

test('does not present an incomplete RPC response as a confirmed order', () => {
  assert.equal(normalizeGuestOrder({ order_id: 42, status: 'Pending' }), null);
});

test('keeps refund amounts separate from the original sale amount', () => {
  const order = normalizeGuestOrder({ order_id: 42, status: 'Cancelled', total: 100, payment_status: 'Paid', amount_paid: 100, refunded_amount: 25, net_amount: 75 });
  assert.equal(order.amountPaid, 100);
  assert.equal(order.refundedAmount, 25);
  assert.equal(order.netAmount, 75);
});

test('only a PostgreSQL SQLSTATE proves a failed sale transaction can be replaced', () => {
  assert.equal(isPostgresErrorCode('23514'), true);
  assert.equal(isPostgresErrorCode('P0001'), true);
  assert.equal(isPostgresErrorCode('PGRST202'), false);
  assert.equal(isPostgresErrorCode(undefined), false);
});

test('checkout retries preserve the exact token and submitted payload', () => {
  const storage = new MemoryStorage();
  const cart = [{ ItemID: 8, ItemName: 'Cappuccino', Price: 100, quantity: 2 }];
  let tokenCalls = 0;
  const first = prepareGuestOrderRequest({
    storage,
    cart,
    pickupName: ' Mika ',
    createToken: () => {
      tokenCalls += 1;
      return 'stable-token';
    },
  });
  const retry = prepareGuestOrderRequest({
    storage,
    pendingRequest: null,
    cart: [],
    pickupName: '',
    createToken: () => {
      tokenCalls += 1;
      return 'different-token';
    },
  });

  assert.equal(tokenCalls, 1);
  assert.equal(retry.token, first.token);
  assert.deepEqual(retry.payload, first.payload);
  assert.deepEqual(JSON.parse(storage.getItem(GUEST_CHECKOUT_KEY)), first);
});

test('customization prices include only selected option deltas and required groups validate', () => {
  const item = {
    ItemID: 8,
    Price: 100,
    groups: [
      { name: 'Size', required: true, min_selections: 1, max_selections: 1, selection_type: 'single', options: [
        { option_id: 11, name: 'Small', price_delta: 0 },
        { option_id: 12, name: 'Large', price_delta: 25 },
      ] },
      { name: 'Milk', required: true, min_selections: 1, max_selections: 1, selection_type: 'single', options: [
        { option_id: 21, name: 'Oat', price_delta: 18 },
      ] },
      { name: 'Add-ons', required: false, min_selections: 0, max_selections: 2, selection_type: 'multiple', options: [
        { option_id: 31, name: 'Extra shot', price_delta: 25 },
      ] },
    ],
  };
  assert.equal(customizationSelectionValid(item, [12, 21, 31]), true);
  assert.equal(customizationSelectionValid(item, [12]), false);
  assert.equal(customizationSelectionValid(item, [11, 12, 21]), false);
  assert.equal(customizationUnitPrice(item, [12, 21, 31]), 168);
  assert.deepEqual(customizationLabels(item, [12, 21]), ['Size: Large', 'Milk: Oat']);
});

test('different drink configurations stay on separate order lines', () => {
  const latte = { ItemID: 8, ItemName: 'Latte', Price: 100, groups: [] };
  const small = orderLineKey(latte.ItemID, [11, 21]);
  const large = orderLineKey(latte.ItemID, [12, 21]);
  assert.notEqual(small, large);
  assert.equal(orderLineKey(latte.ItemID, [21, 11]), small);
});

test('guest requests preserve customization choices, order type, and QR table through retries', () => {
  const storage = new MemoryStorage();
  const cart = [{ ItemID: 8, ItemName: 'Latte', selectedOptionIds: [12, 21], quantity: 2 }];
  const request = prepareGuestOrderRequest({
    storage, cart, pickupName: 'Mika', serviceType: 'dine_in', tableToken: 'table-token',
    createToken: () => 'secure-guest-token',
  });
  assert.deepEqual(request.payload.p_items, [{ item_id: 8, quantity: 2, selected_option_ids: [12, 21] }]);
  assert.equal(request.payload.p_service_type, 'dine_in');
  assert.equal(request.payload.p_table_token, 'table-token');
  const retry = prepareGuestOrderRequest({ storage, cart: [], pickupName: '', createToken: () => assert.fail('Retry must reuse the saved token.') });
  assert.deepEqual(retry.payload, request.payload);
});

test('reuses a saved retry payload after a browser refresh', () => {
  const storage = new MemoryStorage();
  const saved = {
    token: 'old-token',
    payload: {
      p_items: [{ item_id: 3, quantity: 1 }],
      p_guest_token: 'old-token',
      p_guest_name: null,
    },
  };
  storage.setItem(GUEST_CHECKOUT_KEY, JSON.stringify(saved));

  const request = prepareGuestOrderRequest({
    storage,
    cart: [{ ItemID: 99, quantity: 4 }],
    pickupName: 'Different name',
    createToken: () => assert.fail('A retry must not create a new token.'),
  });

  assert.deepEqual(request, saved);
});

test('a damaged saved guest request does not block a new checkout attempt', () => {
  const storage = new MemoryStorage();
  storage.setItem(GUEST_CHECKOUT_KEY, '{bad json');
  const request = prepareGuestOrderRequest({
    storage,
    cart: [{ ItemID: 5, quantity: 1 }],
    pickupName: '',
    createToken: () => 'new-token',
  });
  assert.equal(request.token, 'new-token');
  assert.deepEqual(request.payload.p_items, [{ item_id: 5, quantity: 1 }]);
});

test('counter sale retry keeps its idempotency key and exact submitted payload', () => {
  const storage = new MemoryStorage();
  const input = {
    storage,
    items: [{ ItemID: 7, ItemName: 'Latte', Price: 135, quantity: 2 }],
    customerId: 4,
    pickupName: 'Mika',
    cashTendered: '300',
    amountDue: 270,
    createToken: () => 'sale-key-1',
  };
  const first = prepareCounterSaleRequest(input);
  const retry = prepareCounterSaleRequest({
    storage,
    pendingRequest: null,
    items: [],
    customerId: null,
    pickupName: '',
    cashTendered: '10',
    amountDue: 0,
    createToken: () => assert.fail('A retry must reuse the saved idempotency key.'),
  });
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  assert.deepEqual(retry.payload, first.payload);
  assert.deepEqual(JSON.parse(storage.getItem(COUNTER_SALE_KEY)), first);
});

test('counter requests retain configured options and dine-in table in the idempotent payload', () => {
  const storage = new MemoryStorage();
  const request = prepareCounterSaleRequest({
    storage,
    items: [{ ItemID: 7, ItemName: 'Latte', quantity: 1, selectedOptionIds: [44] }],
    customerId: null, pickupName: '', cashTendered: 150, amountDue: 135,
    serviceType: 'dine_in', diningTableId: 3, createToken: () => 'counter-key',
  });
  assert.deepEqual(request.payload.p_items, [{ item_id: 7, quantity: 1, selected_option_ids: [44] }]);
  assert.equal(request.payload.p_service_type, 'dine_in');
  assert.equal(request.payload.p_dining_table_id, 3);
});

test('cash receipt separates sale amount from tendered cash and change', () => {
  assert.deepEqual(calculateCashPayment(270, 300), {
    amountApplied: 270,
    cashTendered: 300,
    changeGiven: 30,
  });
  assert.equal(calculateCashPayment(270, 269.99), null);
});

test('FIFO uses server queue time then OrderID as a stable tie-breaker', () => {
  const sorted = sortQueueFIFO([
    { orderId: 20, queueEnteredAt: '2026-10-29T10:02:00Z' },
    { orderId: 12, queueEnteredAt: '2026-10-29T10:01:00Z' },
    { orderId: 11, queueEnteredAt: '2026-10-29T10:01:00Z' },
  ]);
  assert.deepEqual(sorted.map((order) => order.orderId), [11, 12, 20]);
});

test('stock movements reject overselling and deduplicate one order', () => {
  const stock = new Map([[1, 5]]);
  const movement = { orderId: 22, inventoryItemId: 1, quantity: 3 };
  const first = applyStockMovements(stock, [movement]);
  assert.equal(first.stock.get(1), 2);
  const retry = applyStockMovements(first.stock, [movement], first.deduplicatedOrders);
  assert.equal(retry.stock.get(1), 2);
  assert.equal(applyStockMovements(stock, [{ ...movement, quantity: 6 }]), null);
  assert.equal(stock.get(1), 5);
});

test('staff modules remain role-scoped in the frontend', () => {
  assert.equal(normalizeStaffRole('Administrator'), 'admin');
  assert.equal(canAccessModule('cashier', 'orders'), true);
  assert.equal(canAccessModule('barista', 'pos'), false);
  assert.equal(canAccessModule('barista', 'orders'), false);
  assert.equal(canAccessModule('cashier', 'inventory'), false);
  assert.equal(canAccessModule('barista', 'queue'), true);
  assert.equal(canAccessModule('unknown', 'queue'), false);
});

test('receipt item rows preserve server unit prices and line totals', () => {
  assert.deepEqual(documentItem({ item_name: 'Latte', quantity: 2, unit_price: '135.00', line_total: '270.00' }), {
    name: 'Latte', quantity: 2, unitPrice: 135, lineTotal: 270, options: [],
  });
  assert.match(formatPHP(270), /₱|PHP/);
});

test('historical configured receipt rows keep their stored price and option labels after menu changes', () => {
  const receiptLine = documentItem({
    item_name: 'Latte', quantity: 1, unit_price: 145, line_total: 145,
    selected_options: [{ group_name: 'Size', name: 'Large', price_delta: 25 }, { group_name: 'Milk', name: 'Oat', price_delta: 20 }],
  });
  const currentMenuPrice = 160;
  assert.equal(receiptLine.unitPrice, 145);
  assert.notEqual(receiptLine.unitPrice, currentMenuPrice);
  assert.deepEqual(receiptLine.options, ['Size: Large', 'Milk: Oat']);
});
