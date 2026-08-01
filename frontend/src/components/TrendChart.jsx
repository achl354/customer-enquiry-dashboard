import { useState } from 'react';

const WIDTH = 600;
const HEIGHT = 160;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 8;

function formatDate(d) {
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Single-series daily volume trend — a plain SVG line+area chart with a
 * hover crosshair, no charting library needed for one series this simple.
 */
export function TrendChart({ data }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const max = Math.max(...data.map((d) => d.count), 1);

  const points = data.map((d, i) => ({
    x: PAD_LEFT + (data.length === 1 ? 0 : (i / (data.length - 1)) * plotW),
    y: PAD_TOP + plotH - (d.count / max) * plotH,
    ...d,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const baseline = (PAD_TOP + plotH).toFixed(1);
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${baseline} L ${points[0].x.toFixed(1)} ${baseline} Z`;

  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let closest = 0;
    let closestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - relX);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    });
    setHoverIndex(closest);
  }

  const hovered = hoverIndex != null ? points[hoverIndex] : null;

  return (
    <div className="trend-chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <line x1={PAD_LEFT} y1={baseline} x2={WIDTH - PAD_RIGHT} y2={baseline} stroke="var(--gridline)" strokeWidth="1" />
        <path d={areaPath} fill="var(--series-1)" opacity="0.08" stroke="none" />
        <path d={linePath} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {hovered && (
          <>
            <line x1={hovered.x} y1={PAD_TOP} x2={hovered.x} y2={baseline} stroke="var(--axis)" strokeWidth="1" />
            <circle cx={hovered.x} cy={hovered.y} r="4" fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth="2" />
          </>
        )}
      </svg>
      <div className="trend-chart-axis">
        <span>{formatDate(data[0].date)}</span>
        <span>{formatDate(data[Math.floor(data.length / 2)].date)}</span>
        <span>{formatDate(data[data.length - 1].date)}</span>
      </div>
      {hovered && (
        <div className="trend-chart-tooltip" style={{ left: `${(hovered.x / WIDTH) * 100}%` }}>
          <strong>{hovered.count}</strong> on {formatDate(hovered.date)}
        </div>
      )}
    </div>
  );
}
