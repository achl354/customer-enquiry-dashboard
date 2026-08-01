// Shimmer placeholders shaped like the real layout, so the first paint
// isn't a blank page while data is still in flight.

function Bone({ width, height = 14, style }) {
  return <div className="skeleton-bone" style={{ width, height, ...style }} />;
}

export function OverviewSkeleton() {
  return (
    <div>
      <h2>Team overview</h2>

      <div className="stat-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="stat-tile" key={i}>
            <div className="stat-tile-header">
              <Bone width={15} height={15} style={{ borderRadius: 4 }} />
              <Bone width={90} height={11} />
            </div>
            <Bone width={64} height={30} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>

      <div className="panel">
        <Bone width={160} height={16} style={{ marginBottom: 14 }} />
        <Bone width="100%" height={140} />
      </div>

      <div className="chart-grid">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="panel" key={i}>
            <Bone width={140} height={16} style={{ marginBottom: 16 }} />
            {Array.from({ length: 5 }).map((__, j) => (
              <Bone key={j} width="100%" height={18} style={{ marginBottom: 10 }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function QueueSkeleton() {
  return (
    <div className="skeleton-table">
      {Array.from({ length: 8 }).map((_, i) => (
        <div className="skeleton-table-row" key={i}>
          <Bone width={90} />
          <Bone width={140} />
          <Bone width="35%" />
          <Bone width={80} />
          <Bone width={70} />
          <Bone width={90} />
          <Bone width={100} />
        </div>
      ))}
    </div>
  );
}
