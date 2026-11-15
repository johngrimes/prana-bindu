// prana-bindu's own icon set: simple 24×24 stroke drawings (no third-party assets).

const PATHS: Record<string, string> = {
  inbox: "M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M4 13h4.5l1 2h5l1-2H20",
  projects: "M4 6h6l2 2h8v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M8 13h8 M8 16h5",
  tags: "M3.5 12.5V4.5h8l9 9-8 8z M8 8.5h.01",
  forecast: "M4 6.5h16v13H4z M4 10.5h16 M8.5 4v4 M15.5 4v4 M8 14h2 M11 14h2 M14 14h2 M8 17h2",
  flagged: "M6 21V4 M6 4.5c4-2 7 2 12 0v9c-5 2-8-2-12 0",
  review: "M4.5 12a7.5 7.5 0 0 1 13-5.1 M19.5 12a7.5 7.5 0 0 1-13 5.1 M17.5 3.5v3.5H14 M6.5 20.5V17H10 M10 12l1.5 1.5L14.5 10",
  completed: "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z M8 12.3l2.7 2.7L16 9.6",
  changed: "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z M12 7.5V12l3 2",
  search: "M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13z M15.5 15.5L20 20",
  menu: "M4 7h16 M4 12h16 M4 17h16",
  sidebar: "M4 5h16v14H4z M9.5 5v14",
  sliders: "M4 7h10 M18 7h2 M4 17h4 M12 17h8 M16 5v4 M10 15v4 M4 12h6 M14 12h6",
  broom: "M14 3l-4 9 M7 12h8l2 9H5z M9 16v5 M13 16v5",
  plus: "M12 5v14 M5 12h14",
  undo: "M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3",
  inspector: "M4 5h16v14H4z M14.5 5v14 M16.5 9h1.5 M16.5 12h1.5",
  more: "M5.5 12h.01 M12 12h.01 M18.5 12h.01",
  close: "M6 6l12 12 M18 6L6 18",
  "chevron-right": "M10 6l6 6-6 6",
  "chevron-down": "M6 10l6 6 6-6",
  "chevron-left": "M14 6l-6 6 6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  flag: "M6 21V4 M6 4.5c4-2 7 2 12 0v9c-5 2-8-2-12 0",
  note: "M6 3.5h8l4 4v13H6z M14 3.5v4h4 M9 12h6 M9 15.5h6",
  paperclip: "M16.5 7.5l-7 7a2 2 0 0 0 2.8 2.8l7.4-7.4a4 4 0 0 0-5.6-5.6l-7.4 7.4a6 6 0 0 0 8.5 8.5l5.3-5.3",
  trash: "M4.5 6.5h15 M9 6.5V4h6v2.5 M6.5 6.5l1 13.5h9l1-13.5 M10 10v6.5 M14 10v6.5",
  gear: "M12 9a3 3 0 1 1 0 6a3 3 0 0 1 0-6z M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.1-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2.1 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.1 1.2L10 21h4l.5-2.6a7 7 0 0 0 2.1-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z",
  logout: "M14 4h5v16h-5 M10 8l-4 4 4 4 M6 12h10",
  help: "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6 M12 17h.01",
  folder: "M3.5 6.5h6l2 2h9v10.5h-17z",
  "project-parallel": "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z M8 9.5h8 M8 12h8 M8 14.5h8",
  "project-sequential": "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z M8.5 8.5l3.5 3.5-3.5 3.5 M12.5 8.5l3.5 3.5-3.5 3.5",
  "project-single": "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z M8.5 9h.01 M11 9h5 M8.5 12h.01 M11 12h5 M8.5 15h.01 M11 15h5",
  tag: "M3.5 12.5V4.5h8l9 9-8 8z M8 8.5h.01",
  grip: "M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01",
  calendar: "M4 6.5h16v13H4z M4 10.5h16 M8.5 4v4 M15.5 4v4",
  clock: "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z M12 7.5V12l3 2",
  repeat: "M17 2.5l3 3-3 3 M4 11.5v-1a5 5 0 0 1 5-5h11 M7 21.5l-3-3 3-3 M20 12.5v1a5 5 0 0 1-5 5H4",
  bell: "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0",
  download: "M12 4v11 M7.5 10.5L12 15l4.5-4.5 M5 19.5h14",
  upload: "M12 15V4 M7.5 8.5L12 4l4.5 4.5 M5 19.5h14",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  key: "M8 11a4 4 0 1 1 0 .01z M11.5 13.5L20 5 M17 8l2.5 2.5 M14.5 10.5l2 2",
  edit: "M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4",
  star: "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z",
  duplicate: "M8 8h12v12H8z M4 16V4h12 M14 11v6 M11 14h6",
  "arrow-up": "M12 19V5 M6 11l6-6 6 6",
  "arrow-down": "M12 5v14 M6 13l6 6 6-6",
  "arrow-right": "M5 12h14 M13 6l6 6-6 6",
  globe: "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z M3.5 12h17 M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z",
  sun: "M12 8a4 4 0 1 1 0 8a4 4 0 0 1 0-8z M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4",
  moon: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z",
  eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M12 9.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5z",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6z",
  heart: "M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z",
  home: "M4 11l8-6.5 8 6.5 M6 9.5V20h12V9.5 M10 20v-5h4v5",
  briefcase: "M4 8h16v11H4z M9 8V5.5h6V8 M4 13h16",
  book: "M5 4.5h10a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z M5 17a3 3 0 0 1 3-3h10",
  cart: "M3.5 4.5h2.5l2 11h10l2-8H7 M9.5 19.5h.01 M16.5 19.5h.01",
  phone: "M7 3.5h4l1 4.5-2.5 1.5a11 11 0 0 0 5 5l1.5-2.5 4.5 1v4c0 1-1 2-2 2A16 16 0 0 1 5 5.5c0-1 1-2 2-2z",
  leaf: "M5 19C5 9 11 5 20 4.5 19.5 13 15 19 5 19z M5 19l8-8",
  target: "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z M12 8a4 4 0 1 1 0 8a4 4 0 0 1 0-8z M12 11.5h.01",
  coffee: "M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16 M8.5 3.5v2.5 M12 3.5v2.5",
  mail: "M3.5 6h17v12h-17z M3.5 6.5l8.5 6.5 8.5-6.5",
  bulb: "M9 17.5h6 M10 20.5h4 M12 3.5a6 6 0 0 1 3.5 10.9V17h-7v-2.6A6 6 0 0 1 12 3.5z",
  list: "M9 7h11 M9 12h11 M9 17h11 M4.5 7h.01 M4.5 12h.01 M4.5 17h.01",
  layers: "M12 4l8.5 4.5L12 13 3.5 8.5z M3.5 12.5L12 17l8.5-4.5 M3.5 16.5L12 21l8.5-4.5",
  pause: "M9 6v12 M15 6v12",
  "external": "M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  image: "M4 5h16v14H4z M8.5 9.5h.01 M20 15l-5-5-9 9",
  file: "M6 3.5h8l4 4v13H6z M14 3.5v4h4",
};

/** Fixed icon set offered for custom perspectives (docs/spec.md §1.2). */
export const PERSPECTIVE_ICONS = [
  "layers",
  "star",
  "bolt",
  "heart",
  "home",
  "briefcase",
  "book",
  "cart",
  "phone",
  "sun",
  "moon",
  "leaf",
  "target",
  "coffee",
  "mail",
  "bulb",
  "list",
  "eye",
  "flag",
  "calendar",
] as const;

export type IconName = keyof typeof PATHS | (string & {});

export function Icon({
  name,
  size = 20,
  className,
  filled = false,
  strokeWidth = 1.8,
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  filled?: boolean;
  strokeWidth?: number;
  title?: string;
}) {
  const d = PATHS[name] ?? PATHS.layers;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}

/** Brand mark: a ring with a point at its centre (bindu). */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="#f3e9d2" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="3.5" fill="var(--gold)" />
    </svg>
  );
}
