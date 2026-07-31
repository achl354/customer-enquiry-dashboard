import { categoryLabel, priorityLabel, statusLabel } from '../taxonomy';

export function PriorityBadge({ priority }) {
  return <span className={`badge priority-${priority.toLowerCase()}`}>{priorityLabel(priority)}</span>;
}

export function StatusBadge({ status }) {
  return <span className={`badge status-${status.toLowerCase()}`}>{statusLabel(status)}</span>;
}

export function CategoryPill({ category }) {
  return <span className="category-pill">{categoryLabel(category)}</span>;
}
