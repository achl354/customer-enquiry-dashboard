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
 *
 * Pass `format(value)` when the displayed value needs a unit (e.g. "11.5h")
 * — bar width is always computed from the raw numeric `d.value`, so a
 * formatted string never distorts the chart itself, only the printed label.
 *
 * Pass `renderAction(key)` to append a small per-row action (e.g. the Top
 * facilities panel's "Reclassify" button) as a 4th column — `linkTo` and
 * `renderAction` are mutually exclusive (a row can't be both a whole-row
 * link and contain its own clickable button; nesting a button inside an
 * anchor is invalid HTML), so `renderAction` wins if both are somehow
 * passed. Omit it and layout is identical to before this existed.
 */
export function BarList({ data, colorFor, linkTo, format, renderAction }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const fmt = format || ((v) => v);
  const hasActions = Boolean(renderAction);

  return (
    <div className={`bar-list${hasActions ? ' bar-list-with-actions' : ''}`}>
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
            <div className="bar-value">{fmt(d.value)}</div>
            {hasActions && <div className="bar-action">{renderAction(d.key)}</div>}
          </>
        );

        if (hasActions) {
          return (
            <div className="bar-row" key={d.key} title={`${d.label}: ${fmt(d.value)}`}>
              {rowContent}
            </div>
          );
        }

        return linkTo ? (
          <Link to={linkTo(d.key)} className="bar-row bar-row-link" key={d.key} title={`${d.label}: ${fmt(d.value)}`}>
            {rowContent}
          </Link>
        ) : (
          <div className="bar-row" key={d.key} title={`${d.label}: ${fmt(d.value)}`}>
            {rowContent}
          </div>
        );
      })}
    </div>
  );
}
