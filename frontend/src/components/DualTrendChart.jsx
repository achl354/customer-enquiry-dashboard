import { useState } from 'react';

const WIDTH = 600;
const HEIGHT = 160;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 8;

/**
 * Two-series line+area trend chart — e.g. received vs. resolved over time.
 * Unlike the single-series TrendChart, two series always need a legend
 * (never rely on color alone for identity) and both values show together
 * on hover rather than one at a time.
 *
 * `data`: [{ [xKey]: string, [seriesA.key]: number, [seriesB.key]: number }]
 * `seriesA`/`seriesB`: { key, label, color }
 * `xFormat`/`format`: optional formatters for the axis label and values.
 */
export function DualTrendChart({ data, xKey, seriesA, seriesB, xFormat, format }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const fmtX = xFormat || ((v) => v);
  const fmtV = format || ((v) => v.toLocaleString());
  // Matches BarList/TrendChart's own empty-data guard.
  if (!data || data.length === 0) return null;

  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const max = Math.max(...data.map((d) => Math.max(d[seriesA.key], d[seriesB.key])), 1);

  const xFor = (i) => PAD_LEFT + (data.length === 1 ? 0 : (i / (data.length - 1)) * plotW);
  const yFor = (v) => PAD_TOP + plotH - (v / max) * plotH;

  const pathFor = (key) =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(d[key]).toFixed(1)}`).join(' ');

  const baseline = (PAD_TOP + plotH).toFixed(1);
  const areaFor = (key) => {
    const line = pathFor(key);
    return `${line} L ${xFor(data.length - 1).toFixed(1)} ${baseline} L ${xFor(0).toFixed(1)} ${baseline} Z`;
  };

  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let closest = 0;
    let closestDist = Infinity;
    data.forEach((_, i) => {
      const dist = Math.abs(xFor(i) - relX);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    });
    setHoverIndex(closest);
  }

  const hovered = hoverIndex != null ? data[hoverIndex] : null;
  const hoveredX = hoverIndex != null ? xFor(hoverIndex) : null;

  return (
    <div className="trend-chart">
      <div className="trend-chart-legend">
        <span className="legend-item"><span className="legend-swatch" style={{ background: seriesA.color }} />{seriesA.label}</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: seriesB.color }} />{seriesB.label}</span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <line x1={PAD_LEFT} y1={baseline} x2={WIDTH - PAD_RIGHT} y2={baseline} stroke="var(--gridline)" strokeWidth="1" />
        <path d={areaFor(seriesA.key)} fill={seriesA.color} opacity="0.08" stroke="none" />
        <path d={pathFor(seriesA.key)} fill="none" stroke={seriesA.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d={areaFor(seriesB.key)} fill={seriesB.color} opacity="0.08" stroke="none" />
        <path d={pathFor(seriesB.key)} fill="none" stroke={seriesB.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {hovered && (
          <>
            <line x1={hoveredX} y1={PAD_TOP} x2={hoveredX} y2={baseline} stroke="var(--axis)" strokeWidth="1" />
            <circle cx={hoveredX} cy={yFor(hovered[seriesA.key])} r="4" fill={seriesA.color} stroke="var(--surface-1)" strokeWidth="2" />
            <circle cx={hoveredX} cy={yFor(hovered[seriesB.key])} r="4" fill={seriesB.color} stroke="var(--surface-1)" strokeWidth="2" />
          </>
        )}
      </svg>
      <div className="trend-chart-axis">
        <span>{fmtX(data[0][xKey])}</span>
        <span>{fmtX(data[Math.floor(data.length / 2)][xKey])}</span>
        <span>{fmtX(data[data.length - 1][xKey])}</span>
      </div>
      {hovered && (
        <div className="trend-chart-tooltip" style={{ left: `${(hoveredX / WIDTH) * 100}%` }}>
          <div>{fmtX(hovered[xKey])}</div>
          <div><span className="legend-swatch" style={{ background: seriesA.color }} />{seriesA.label}: <strong>{fmtV(hovered[seriesA.key])}</strong></div>
          <div><span className="legend-swatch" style={{ background: seriesB.color }} />{seriesB.label}: <strong>{fmtV(hovered[seriesB.key])}</strong></div>
        </div>
      )}
    </div>
  );
}
