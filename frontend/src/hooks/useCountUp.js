import { useEffect, useRef, useState } from 'react';

const DURATION_MS = 700;

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

// Animates a numeric stat from its previous value to `target` whenever
// `target` changes (including the initial mount, animating from 0). Returns
// the in-flight display value already rounded to `decimals` places.
export function useCountUp(target, { decimals = 0 } = {}) {
  const [display, setDisplay] = useState(target == null ? null : 0);
  const fromRef = useRef(0);
  const frameRef = useRef(null);

  useEffect(() => {
    if (target == null || Number.isNaN(target)) {
      setDisplay(target);
      return undefined;
    }

    const from = fromRef.current;
    const start = performance.now();

    function tick(now) {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / DURATION_MS);
      const value = from + (target - from) * easeOutCubic(t);
      setDisplay(value);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  if (display == null) return null;
  return decimals > 0 ? display.toFixed(decimals) : Math.round(display).toLocaleString();
}
