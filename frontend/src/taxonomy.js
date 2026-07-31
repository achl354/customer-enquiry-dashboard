export const CATEGORY_LABELS = {
  EQUIPMENT_FAULT: 'Equipment fault',
  BACKORDER_NOTICE: 'Backorder notice',
  PO_ETA_REQUEST: 'PO / ETA request',
  INVOICE_BILLING: 'Invoice / billing',
  QUOTE_PRICING: 'Quote / pricing',
  PRODUCT_ENQUIRY: 'Product enquiry',
  SUPPLIER_VENDOR: 'Supplier / vendor',
  INTERNAL: 'Internal',
  SPAM_NOTIFICATION: 'Spam / notification',
  UNCLASSIFIED: 'Unclassified',
};

export const PRIORITY_LABELS = {
  URGENT: 'Urgent',
  HIGH: 'High',
  NORMAL: 'Normal',
  LOW: 'Low',
};

export const STATUS_LABELS = {
  NEW: 'New',
  IN_PROGRESS: 'In progress',
  WAITING_ON_CUSTOMER: 'Waiting on customer',
  RESOLVED: 'Resolved',
  IGNORED: 'Ignored',
};

export const STATUS_OPTIONS = Object.keys(STATUS_LABELS);
export const CATEGORY_OPTIONS = Object.keys(CATEGORY_LABELS);
export const PRIORITY_OPTIONS = Object.keys(PRIORITY_LABELS);

export function categoryLabel(value) {
  return CATEGORY_LABELS[value] || value;
}

export function priorityLabel(value) {
  return PRIORITY_LABELS[value] || value;
}

export function statusLabel(value) {
  return STATUS_LABELS[value] || value;
}
