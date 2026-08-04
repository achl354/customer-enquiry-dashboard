import { useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Compact part-to-whole bar — a single track divided into colored segments
 * by share, with an always-visible legend row per segment underneath.
 * Replaces the status donut: per the dataviz reference this project
 * follows, a stacked bar is the actual default for part-to-whole (donut
 * is a deprioritized, small-segment-count carve-out), so this is the more
 * appropriate form here.
 *
 * `data`: [{ key, label, value, color }]. Pass `linkTo(key)` to make each
 * legend row drill through to a filtered queue view (BarList's same
 * convention). A native `title` on each segment carries the hover detail
 * — no custom tooltip, since the always-visible legend already shows
 * every value; hover/focus is a convenience, not the only way to see a
 * number.
 */
export function StackedBar({ data, linkTo }) {
  const [hoverKey, setHoverKey] = useState(null);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const visible = data.filter((d) => d.value > 0);
  if (total === 0 || visible.length === 0) return null;

  return (
    <div className="stacked-bar-chart">
      <div className="stacked-bar-track">
        {visible.map((d) => (
          <div
            key={d.key}
            className={`stacked-bar-segment${hoverKey === d.key ? ' stacked-bar-segment-hovered' : ''}`}
            style={{ width: `${(d.value / total) * 100}%`, background: d.color }}
            title={`${d.label}: ${d.value.toLocaleString()} (${Math.round((d.value / total) * 100)}%)`}
            tabIndex={0}
            onMouseEnter={() => setHoverKey(d.key)}
            onMouseLeave={() => setHoverKey(null)}
            onFocus={() => setHoverKey(d.key)}
            onBlur={() => setHoverKey(null)}
          />
        ))}
      </div>
      <ul className="chart-legend">
        {visible.map((d) => {
          const rowContent = (
            <>
              <span className="legend-swatch" style={{ background: d.color }} />
              <span className="chart-legend-label">{d.label}</span>
              <span className="chart-legend-value">
                {d.value.toLocaleString()} ({Math.round((d.value / total) * 100)}%)
              </span>
            </>
          );
          const className = `legend-item chart-legend-item${hoverKey === d.key ? ' chart-legend-item-hovered' : ''}${linkTo ? ' chart-legend-item-link' : ''}`;
          return (
            <li
              key={d.key}
              className={className}
              onMouseEnter={() => setHoverKey(d.key)}
              onMouseLeave={() => setHoverKey(null)}
            >
              {linkTo ? <Link to={linkTo(d.key)}>{rowContent}</Link> : rowContent}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
