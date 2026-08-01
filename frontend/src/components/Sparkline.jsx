const WIDTH = 96;
const HEIGHT = 28;
const PAD = 2;

/**
 * Tiny inline trend line for a stat tile — deliberately has no axis, labels,
 * or tooltip; it exists purely to show shape/direction at a glance. Only
 * use this where the values are a real time series (see dailyVolume on
 * Overview) — never fabricate a trend line for a metric with no history.
 */
export function Sparkline({ values, color = 'var(--series-1)' }) {
  if (!values || values.length < 2) return null;

  const plotW = WIDTH - PAD * 2;
  const plotH = HEIGHT - PAD * 2;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  const points = values.map((v, i) => ({
    x: PAD + (i / (values.length - 1)) * plotW,
    y: PAD + plotH - ((v - min) / range) * plotH,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const baseline = (PAD + plotH).toFixed(1);
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${baseline} L ${points[0].x.toFixed(1)} ${baseline} Z`;
  const last = points[points.length - 1];

  return (
    <svg className="sparkline" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
      <path d={areaPath} fill={color} opacity="0.1" stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r="2" fill={color} />
    </svg>
  );
}
