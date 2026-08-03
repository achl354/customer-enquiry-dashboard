// Relative by default so a single-origin production deploy (Express serving
// the built frontend directly) just works with no build-time config. Local
// dev overrides this via frontend/.env (VITE_API_BASE) since the frontend
// and backend run as two separate servers there.
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// `options` (e.g. { signal }) is forwarded straight to fetch — lets a caller
// that re-fetches on every keystroke/param change (search, pagination, the
// enquiry id in the URL) cancel a stale in-flight request instead of racing
// it against a newer one and possibly rendering whichever happens to
// resolve last.
export function listEnquiries(params = {}, options = {}) {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
  ).toString();
  return request(`/enquiries${query ? `?${query}` : ''}`, options);
}

export function getEnquiry(id, options = {}) {
  return request(`/enquiries/${encodeURIComponent(id)}`, options);
}

export function updateEnquiry(id, updates) {
  return request(`/enquiries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function generateDraft(id) {
  return request(`/enquiries/${encodeURIComponent(id)}/draft`, { method: 'POST' });
}

export function getThreadHistory(id) {
  return request(`/enquiries/${encodeURIComponent(id)}/thread`);
}

export function getFullBody(id) {
  return request(`/enquiries/${encodeURIComponent(id)}/body`);
}

// Returns a plain URL (not a fetch call) — the export button links to this
// directly so the browser handles the file download/filename itself via
// the response's Content-Disposition header.
export function getExportUrl(params = {}) {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
  ).toString();
  return `${API_BASE}/enquiries/export${query ? `?${query}` : ''}`;
}

export function getOverviewStats() {
  return request('/stats/overview');
}

export function getIngestStatus() {
  return request('/ingest/status');
}
