import { Link } from 'react-router-dom';

/**
 * Horizontal bar list for a single-series magnitude-by-category chart.
 * One hue for every bar (nominal categories, no natural order) unless
 * `colorFor` is passed to map a bar to a semantic status color.
 *
 * Pass `linkTo(key)` to make each bar drill through to a filtered queue
 * view (e.g. category/status, which already have exact-match filters on
 * the Queue page) — omit it for data with no matching filter yet (e.g.
 * facility/assignee, which only have a loose text-search fallback so far).
 */
export function BarList({ data, colorFor, linkTo }) {
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div>
      {data.map((d) => {
        const rowContent = (
          <>
            <div className="bar-label">{d.label}</div>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: `${(d.value / max) * 100}%`,
                  background: colorFor ? colorFor(d.key) : 'var(--series-1)',
                }}
              />
            </div>
            <div className="bar-value">{d.value}</div>
          </>
        );

        return linkTo ? (
          <Link to={linkTo(d.key)} className="bar-row bar-row-link" key={d.key} title={`${d.label}: ${d.value}`}>
            {rowContent}
          </Link>
        ) : (
          <div className="bar-row" key={d.key} title={`${d.label}: ${d.value}`}>
            {rowContent}
          </div>
        );
      })}
    </div>
  );
}
