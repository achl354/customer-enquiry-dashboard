const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000/api';

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

export function getOverviewStats() {
  return request('/stats/overview');
}

export function getIngestStatus() {
  return request('/ingest/status');
}
