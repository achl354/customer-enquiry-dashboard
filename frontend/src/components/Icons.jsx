// Small hand-rolled icon set (stroke-based, 20x20, currentColor) — avoids
// pulling in an icon library dependency for a handful of glyphs.
const common = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export function IconGrid(props) {
  return (
    <svg {...common} {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function IconInbox(props) {
  return (
    <svg {...common} {...props}>
      <path d="M3 12h4.5l1.5 3h6l1.5-3H21" />
      <path d="M5 12 6.5 5.5A1.5 1.5 0 0 1 8 4.3h8a1.5 1.5 0 0 1 1.5 1.2L19 12" />
      <rect x="3" y="12" width="18" height="7" rx="1.5" />
    </svg>
  );
}

export function IconAlertTriangle(props) {
  return (
    <svg {...common} {...props}>
      <path d="M12 3.5 21.5 20H2.5Z" />
      <line x1="12" y1="9.5" x2="12" y2="13.5" />
      <line x1="12" y1="16.3" x2="12" y2="16.5" />
    </svg>
  );
}

export function IconClock(props) {
  return (
    <svg {...common} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

export function IconSparkle(props) {
  return (
    <svg {...common} {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8.5 14 12l-2 3.5L10 12Z" />
    </svg>
  );
}

export function IconEye(props) {
  return (
    <svg {...common} {...props}>
      <path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconLayers(props) {
  return (
    <svg {...common} {...props}>
      <path d="M12 3 2.5 8 12 13l9.5-5Z" />
      <path d="M2.5 13 12 18l9.5-5" />
      <path d="M2.5 18 12 23l9.5-5" />
    </svg>
  );
}

export function IconDot(props) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" {...props}>
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  );
}

export function IconSun(props) {
  return (
    <svg {...common} {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8l1.8-1.8M18 6l1.8-1.8" />
    </svg>
  );
}

export function IconMoon(props) {
  return (
    <svg {...common} {...props}>
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

export function IconSearch(props) {
  return (
    <svg {...common} {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="20" y1="20" x2="15.3" y2="15.3" />
    </svg>
  );
}

export function IconMonitor(props) {
  return (
    <svg {...common} {...props}>
      <rect x="3" y="4" width="18" height="13" rx="1.5" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function IconRefresh(props) {
  return (
    <svg {...common} {...props}>
      <path d="M4 4v5h5" />
      <path d="M20 20v-5h-5" />
      <path d="M4.6 15A8 8 0 0 0 19 16.5M19.4 9A8 8 0 0 0 5 7.5" />
    </svg>
  );
}

export function IconUser(props) {
  return (
    <svg {...common} {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" />
    </svg>
  );
}
