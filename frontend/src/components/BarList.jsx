/**
 * Horizontal bar list for a single-series magnitude-by-category chart.
 * One hue for every bar (nominal categories, no natural order) unless
 * `colorFor` is passed to map a bar to a semantic status color.
 */
export function BarList({ data, colorFor }) {
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div>
      {data.map((d) => (
        <div className="bar-row" key={d.key} title={`${d.label}: ${d.value}`}>
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
        </div>
      ))}
    </div>
  );
}
