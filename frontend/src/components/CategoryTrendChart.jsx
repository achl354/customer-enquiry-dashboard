import { useState } from 'react';

const WIDTH = 600;
const HEIGHT = 170;
const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 8;
const BAR_GAP_RATIO = 0.25;

/**
 * Stacked bar per period (day/week/month), segmented and colored by
 * category, with a shared legend below — "how has the category mix
 * varied over time," not just a single-snapshot total. Bar-layout logic
 * (slots/gaps) matches NetDiffChart; the Y-axis-label-as-HTML-overlay
 * fix (not SVG <text>, which distorts under preserveAspectRatio="none")
 * matches DualTrendChart — see the comments there for why.
 *
 * `data`: [{ [xKey]: string, categories: { [seriesKey]: number } }]
 * `series`: [{ key, label, color }] in stacking order (bottom to top) —
 * pass a small, fixed list (the caller decides which categories get their
 * own color vs. get folded into an "Other" bucket; this component just
 * draws whatever series it's given).
 */
export function CategoryTrendChart({ data, xKey, series, xFormat }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const fmtX = xFormat || ((v) => v);
  if (!data || data.length === 0 || series.length === 0) return null;

  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const totals = data.map((d) => series.reduce((sum, s) => sum + (d.categories[s.key] || 0), 0));
  const max = Math.max(...totals, 1);
  const yTicks = [0, max / 2, max];

  const slotW = plotW / data.length;
  const barW = slotW * (1 - BAR_GAP_RATIO);
  const xFor = (i) => PAD_LEFT + i * slotW + (slotW - barW) / 2;
  const yFor = (v) => PAD_TOP + plotH - (v / max) * plotH;

  const hovered = hoverIndex != null ? data[hoverIndex] : null;
  const hoveredCenterX = hoverIndex != null ? xFor(hoverIndex) + barW / 2 : null;

  return (
    <div className="trend-chart category-trend-chart">
      <div className="trend-chart-plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
          {yTicks.map((v) => (
            <line key={v} x1={PAD_LEFT} y1={yFor(v).toFixed(1)} x2={WIDTH - PAD_RIGHT} y2={yFor(v).toFixed(1)} stroke="var(--gridline)" strokeWidth="1" />
          ))}
          {data.map((d, i) => {
            let cumulative = 0;
            return series.map((s) => {
              const value = d.categories[s.key] || 0;
              const y0 = yFor(cumulative);
              cumulative += value;
              const y1 = yFor(cumulative);
              if (value <= 0) return null;
              return (
                <rect
                  key={s.key}
                  x={xFor(i)}
                  y={y1}
                  width={barW}
                  height={Math.max(y0 - y1, 0.5)}
                  fill={s.color}
                  opacity={hoverIndex === i ? 1 : 0.85}
                  onMouseEnter={() => setHoverIndex(i)}
                  onMouseLeave={() => setHoverIndex(null)}
                />
              );
            });
          })}
        </svg>
        <div className="trend-chart-yaxis" style={{ width: `${((PAD_LEFT - 2) / WIDTH) * 100}%` }}>
          {yTicks.map((v) => (
            <span key={v} style={{ top: `${(yFor(v) / HEIGHT) * 100}%` }}>{Math.round(v).toLocaleString()}</span>
          ))}
        </div>
      </div>
      <div className="trend-chart-axis">
        <span>{fmtX(data[0][xKey])}</span>
        <span>{fmtX(data[Math.floor(data.length / 2)][xKey])}</span>
        <span>{fmtX(data[data.length - 1][xKey])}</span>
      </div>
      {hovered && (
        <div className="trend-chart-tooltip" style={{ left: `${(hoveredCenterX / WIDTH) * 100}%` }}>
          <div>{fmtX(hovered[xKey])}</div>
          {series
            .filter((s) => (hovered.categories[s.key] || 0) > 0)
            .map((s) => (
              <div key={s.key}>
                <span className="legend-swatch" style={{ background: s.color }} />
                {s.label}: <strong>{hovered.categories[s.key]}</strong>
              </div>
            ))}
        </div>
      )}
      <ul className="chart-legend category-trend-legend">
        {series.map((s) => (
          <li key={s.key} className="legend-item chart-legend-item">
            <span className="legend-swatch" style={{ background: s.color }} />
            <span className="chart-legend-label">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
