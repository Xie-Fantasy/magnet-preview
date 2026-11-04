import type { CSSProperties } from 'react';

const paths = {
  magnet: 'M5 4v9a7 7 0 0 0 14 0V4M5 8h4M15 8h4M9 4v9a3 3 0 0 0 6 0V4',
  scan: 'M8 3H4v4M16 3h4v4M4 17v4h4M20 17v4h-4M4 12h16',
  tools: 'M4 5h16M4 12h16M4 19h16M8 3v4M16 10v4M10 17v4',
  page: 'M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 12h8M8 16h5',
  library: 'M4 4v16M8 4v16M12 4v16M16 4l4 15',
  back: 'm10 5-7 7 7 7M3 12h18',
  previous: 'm14 6-6 6 6 6',
  next: 'm10 6 6 6-6 6',
  cache: 'M4 6h16v12H4V6ZM4 10h16M16 14h1',
  image: 'M3 5h18v14H3V5ZM5 17l5-4 3 2 3-3 3 3M9 9h.01',
  check: 'm5 12 4 4L19 6',
  warning: 'm12 3 10 18H2L12 3ZM12 9v5M12 17h.01',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z',
} as const;

export function Icon({
  name,
  style,
}: {
  name: keyof typeof paths;
  style?: CSSProperties;
}) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={style}
    >
      <path
        d={paths[name]}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="popup-wordmark">
      <Icon name="magnet" />
      <span className="wordmark-text">
        magnet<span className="wordmark-slash">/</span>preview
      </span>
    </span>
  );
}
