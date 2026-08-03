export const CATEGORY_LABELS = {
  PRODUCT_COMPLAINT: 'Product complaint',
  EQUIPMENT_FAULT: 'Equipment fault',
  BACKORDER_NOTICE: 'Backorder notice',
  PO_ETA_REQUEST: 'PO / ETA request',
  RETURNS_CREDIT: 'Returns / credit',
  INVOICE_BILLING: 'Invoice / billing',
  LOGISTICS_FREIGHT: 'Logistics / freight',
  QUOTE_PRICING: 'Quote / pricing',
  ORDER_CONFIRMATION: 'Order confirmation',
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
  // The source message was deleted/moved out of the mailbox (e.g. storage
  // cleanup) before ever getting an explicit Resolved/No Action Needed
  // category — kept distinct from Resolved since disappearing isn't the
  // same confirmation of being handled.
  REMOVED: 'Removed from mailbox',
  // Staff clicked "Delete" on the Detail page — a dashboard-only hide,
  // unlike every other status here which is inferred from Outlook.
  DISMISSED: 'Dismissed',
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
