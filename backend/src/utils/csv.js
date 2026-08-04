// Double up any embedded quotes and wrap the field if it contains a comma,
// quote, or newline — the minimal correct CSV escaping rule, no library
// needed for a field set this simple.
function csvField(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// `columns` is [[header, getter], ...] — same shape enquiries.js's export
// route already used before this was extracted for reuse elsewhere (see
// routes/ingest.js's folder-map/message export).
function toCsv(columns, rows) {
  const lines = [columns.map(([header]) => csvField(header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(([, get]) => csvField(get(row))).join(','));
  }
  return lines.join('\n');
}

module.exports = { csvField, toCsv };
