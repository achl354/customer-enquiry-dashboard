import { useEffect, useState } from 'react';

/**
 * Fetch-on-granularity-change for the Overview page's family of period-toggle
 * KPI panels (resolution time, first response time, backlog, volume) — each
 * one is "call fetchFn(granularity, {signal}), re-fetch whenever granularity
 * changes, cancel a still-in-flight request from a granularity the operator
 * has already clicked away from." Pulling this into one hook means that
 * logic (and its AbortController cleanup) exists once instead of once per
 * panel.
 *
 * Returns { data, error, loading }: `data` is `null` until the first
 * successful fetch for the *current* granularity resolves (so callers can
 * show a loading state instead of a stale/wrong-shaped previous result),
 * then the fetched array afterward.
 */
export function usePeriodTrend(fetchFn, granularity) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    fetchFn(granularity, { signal: controller.signal })
      .then((rows) => {
        setData(rows);
        setError(null);
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setError(e.message);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granularity]);

  return { data, error, loading: data === null && !error };
}
