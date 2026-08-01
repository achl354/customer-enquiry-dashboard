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

export function listEnquiries(params = {}) {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
  ).toString();
  return request(`/enquiries${query ? `?${query}` : ''}`);
}

export function getEnquiry(id) {
  return request(`/enquiries/${encodeURIComponent(id)}`);
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

export function getOverviewStats() {
  return request('/stats/overview');
}

export function getIngestStatus() {
  return request('/ingest/status');
}
