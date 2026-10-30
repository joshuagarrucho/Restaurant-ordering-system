import { getRpcValue } from './order-utils.js';

export const formatPHP = (amount) => new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
}).format(Number(amount || 0));

export const documentItem = (item) => {
  const quantity = Number(getRpcValue(item, 'quantity', 'Quantity') || 0);
  const unitPrice = Number(getRpcValue(item, 'unit_price', 'UnitPrice', 'price', 'Price') || 0);
  const lineTotal = getRpcValue(item, 'line_total', 'LineTotal', 'subtotal', 'Subtotal');
  const optionData = getRpcValue(item, 'selected_options', 'SelectedOptions') || [];
  const options = Array.isArray(optionData) ? optionData.map((option) =>
    typeof option === 'string' ? option : `${option.group_name || option.group || 'Option'}: ${option.name || option.option_name || ''}`,
  ).filter(Boolean) : [];
  return {
    name: getRpcValue(item, 'item_name', 'ItemName', 'name', 'ItemNameSnapshot') || 'Item',
    quantity,
    unitPrice,
    lineTotal: lineTotal == null ? unitPrice * quantity : Number(lineTotal),
    options,
  };
};

export const documentDate = (value) => {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date())
    : new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(date);
};

export const dateKeyPH = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
};

export const exportCSV = (rows, fileName) => {
  const escapeCell = (value) => {
    let text = String(value ?? '');
    if (typeof value === 'string' && /^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const csv = rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};
