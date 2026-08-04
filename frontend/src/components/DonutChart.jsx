import { useState } from 'react';
import { Link } from 'react-router-dom';

const SIZE = 200;
const CENTER = SIZE / 2;
const RADIUS = 74; // stroke-path radius; ring thickness is STROKE_WIDTH below
const STROKE_WIDTH = 32;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// A visible gap between adjacent segments, same idea as the "surface gap"
// standard for stacked bars — trimmed off the trailing end of each
// segment's dash length so segments never touch, without drawing a border
// (a stroke adds data-weight ink that isn't data).
const GAP = 3;

/**
 * Part-to-whole donut for a small (<= ~6), unordered set of categories —
 * status mix, here. A legend row per segment is always rendered (never
 * gated behind hover — see dataviz's interaction rules), each showing its
 * own count and share; hovering or focusing a segment additionally shows a
 * tooltip and highlights that segment. `data`: [{ key, label, value,
 * color }]. Segments with value 0 are skipped entirely (a 0-length arc is
 * still real DOM/hover surface for nothing).
 *
 * Pass `linkTo(key)` to make each legend row (not the arc itself — a
 * clickable SVG arc is a worse hit target than the row already sitting
 * next to it) drill through to a filtered queue view, same convention as
 * BarList.
 */
export function DonutChart({ data, centerLabel = 'Total', linkTo }) {
  const [hoverKey, setHoverKey] = useState(null);
  const [pointer, setPointer] = useState(null);

  const total = data.reduce((sum, d) => sum + d.value, 0);
  const visible = data.filter((d) => d.value > 0);
  if (total === 0 || visible.length === 0) return null;

  let cumulative = 0;
  const segments = visible.map((d) => {
    const fraction = d.value / total;
    const rawLength = fraction * CIRCUMFERENCE;
    const offset = cumulative;
    cumulative += rawLength;
    return {
      ...d,
      fraction,
      dashArray: `${Math.max(0, rawLength - GAP)} ${CIRCUMFERENCE}`,
      dashOffset: -offset,
    };
  });

  function handlePointer(e, key) {
    const rect = e.currentTarget.closest('.donut-chart').getBoundingClientRect();
    setHoverKey(key);
    setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  const hovered = hoverKey ? segments.find((s) => s.key === hoverKey) : null;

  return (
    <div className="donut-chart">
      <div className="donut-chart-body">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="donut-chart-svg">
          <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
            <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" stroke="var(--gridline)" strokeWidth={STROKE_WIDTH} />
            {segments.map((s) => (
              <circle
                key={s.key}
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                stroke={s.color}
                strokeWidth={STROKE_WIDTH}
                strokeDasharray={s.dashArray}
                strokeDashoffset={s.dashOffset}
                strokeLinecap="butt"
                tabIndex={0}
                role="img"
                aria-label={`${s.label}: ${s.value} (${Math.round(s.fraction * 100)}%)`}
                className={`donut-segment${hoverKey === s.key ? ' donut-segment-hovered' : ''}`}
                onMouseMove={(e) => handlePointer(e, s.key)}
                onMouseLeave={() => setHoverKey(null)}
                onFocus={(e) => handlePointer(e, s.key)}
                onBlur={() => setHoverKey(null)}
              />
            ))}
          </g>
          <text x={CENTER} y={CENTER - 6} textAnchor="middle" className="donut-center-value">
            {total.toLocaleString()}
          </text>
          <text x={CENTER} y={CENTER + 14} textAnchor="middle" className="donut-center-label">
            {centerLabel}
          </text>
        </svg>
        {hovered && pointer && (
          <div className="trend-chart-tooltip donut-chart-tooltip" style={{ left: pointer.x, top: pointer.y }}>
            <div>
              <span className="legend-swatch" style={{ background: hovered.color }} />
              {hovered.label}: <strong>{hovered.value.toLocaleString()}</strong> ({Math.round(hovered.fraction * 100)}%)
            </div>
          </div>
        )}
      </div>
      <ul className="donut-legend">
        {visible.map((d) => {
          const rowContent = (
            <>
              <span className="legend-swatch" style={{ background: d.color }} />
              <span className="donut-legend-label">{d.label}</span>
              <span className="donut-legend-value">
                {d.value.toLocaleString()} ({Math.round((d.value / total) * 100)}%)
              </span>
            </>
          );
          const className = `legend-item donut-legend-item${hoverKey === d.key ? ' donut-legend-item-hovered' : ''}${linkTo ? ' donut-legend-item-link' : ''}`;
          return (
            <li key={d.key} className={className}>
              {linkTo ? <Link to={linkTo(d.key)}>{rowContent}</Link> : rowContent}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
