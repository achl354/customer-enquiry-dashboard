import { useState } from 'react';

const WIDTH = 600;
const HEIGHT = 56;
const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 4;
const PAD_BOTTOM = 4;
const BAR_GAP_RATIO = 0.25; // fraction of each bar's slot left as a gap

/**
 * Net received-minus-resolved per period, as a small diverging bar strip
 * beneath the main volume chart — a different *kind* of measure than raw
 * counts (it can be negative, and its sign carries meaning), so it gets
 * its own baseline-crossing chart rather than a third line jammed onto
 * DualTrendChart's shared axis (matching the same "two measures of
 * different scale -> two charts" reasoning the Backlog panel already
 * follows for the same underlying tension).
 *
 * Bars above the zero line (received > resolved that period, backlog
 * growing) use the warning color; below (resolved > received, backlog
 * shrinking) use the good color — a rising problem reads as "up", a
 * clearing one as "down".
 *
 * `data`: [{ [xKey]: string, received: number, resolved: number }] — same
 * rows the volume panel already fetched; net is computed here rather than
 * requiring a separate endpoint.
 */
export function NetDiffChart({ data, xKey, xFormat }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const fmtX = xFormat || ((v) => v);
  if (!data || data.length === 0) return null;

  const nets = data.map((d) => d.received - d.resolved);
  const maxAbs = Math.max(...nets.map((n) => Math.abs(n)), 1);

  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const zeroY = PAD_TOP + plotH / 2;
  const halfH = plotH / 2;

  const slotW = plotW / data.length;
  const barW = slotW * (1 - BAR_GAP_RATIO);

  const heightFor = (n) => (Math.abs(n) / maxAbs) * halfH;
  const xFor = (i) => PAD_LEFT + i * slotW + (slotW - barW) / 2;

  const hovered = hoverIndex != null ? { row: data[hoverIndex], net: nets[hoverIndex] } : null;
  const hoveredCenterX = hoverIndex != null ? xFor(hoverIndex) + barW / 2 : null;

  return (
    <div className="trend-chart net-diff-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
        <text x={PAD_LEFT - 6} y={zeroY + 3} textAnchor="end" className="trend-chart-ytick">0</text>
        <line x1={PAD_LEFT} y1={zeroY} x2={WIDTH - PAD_RIGHT} y2={zeroY} stroke="var(--gridline)" strokeWidth="1" />
        {nets.map((n, i) => {
          const h = heightFor(n);
          const isGrowing = n > 0;
          const y = isGrowing ? zeroY - h : zeroY;
          return (
            <rect
              key={data[i][xKey]}
              x={xFor(i)}
              y={y}
              width={barW}
              height={Math.max(h, 1)}
              rx="2"
              fill={isGrowing ? 'var(--status-warning)' : 'var(--status-good)'}
              opacity={hoverIndex === i ? 1 : 0.75}
              onMouseEnter={() => setHoverIndex(i)}
              onMouseLeave={() => setHoverIndex(null)}
            />
          );
        })}
      </svg>
      <div className="trend-chart-axis">
        <span>{fmtX(data[0][xKey])}</span>
        <span>{fmtX(data[Math.floor(data.length / 2)][xKey])}</span>
        <span>{fmtX(data[data.length - 1][xKey])}</span>
      </div>
      {hovered && (
        <div className="trend-chart-tooltip" style={{ left: `${(hoveredCenterX / WIDTH) * 100}%` }}>
          <div>{fmtX(hovered.row[xKey])}</div>
          <div>
            Net: <strong>{hovered.net > 0 ? '+' : ''}{hovered.net.toLocaleString()}</strong>
            {' '}({hovered.net > 0 ? 'backlog growing' : hovered.net < 0 ? 'backlog shrinking' : 'flat'})
          </div>
        </div>
      )}
    </div>
  );
}
