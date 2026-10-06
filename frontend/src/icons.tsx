import type { ReactNode } from 'react'

const svg = (size: number, children: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const Icon = {
  printer: (s = 22) => svg(s, <><path d="M7 9V4h10v5" /><rect x="3.5" y="9" width="17" height="8" rx="2.5" /><path d="M7 14h10v6H7z" /></>),
  box: (s = 22) => svg(s, <><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /></>),
  clock: (s = 22) => svg(s, <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  sliders: (s = 22) => svg(s, <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>),
  refresh: (s = 22) => svg(s, <><path d="M20 11a8 8 0 0 0-14-4L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14 4l2-2" /><path d="M20 20v-5h-5" /></>),
  user: (s = 22) => svg(s, <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>),
  chevron: (s = 20) => svg(s, <path d="M9 6l6 6-6 6" />),
  up: (s = 20) => svg(s, <path d="M6 15l6-6 6 6" />),
  down: (s = 20) => svg(s, <path d="M6 9l6 6 6-6" />),
  back: (s = 22) => svg(s, <path d="M15 6l-6 6 6 6" />),
  more: (s = 20) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
    </svg>
  ),
  // Žurnāls entry types
  // Used = line going down, received = line going up, moved = two arrows passing each other, defect = warning sign
  trendDown: (s = 18) => svg(s, <><path d="M3 7l6 6 4-4 7.5 7.5" /><path d="M21 11v6h-6" /></>),
  trendUp: (s = 18) => svg(s, <><path d="M3 17l6-6 4 4 7.5-7.5" /><path d="M15 7h6v6" /></>),
  swap: (s = 18) => svg(s, <><path d="M7 5L4 8l3 3" /><path d="M4 8h12.5a3.5 3.5 0 0 1 3.5 3.5" /><path d="M17 13l3 3-3 3" /><path d="M20 16H7.5A3.5 3.5 0 0 1 4 12.5" /></>),
  hazard: (s = 18) => svg(s, <><path d="M12 4.5l8.5 14.5h-17z" /><path d="M12 10v4.5" /><path d="M12 17.2v.01" /></>),
  tune: (s = 18) => svg(s, <><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /></>),
  plus: (s = 18) => svg(s, <><path d="M12 5v14M5 12h14" /></>),
  info: (s = 20) => svg(s, <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5v.01" /></>),
  search: (s = 20) => svg(s, <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>),
  pencil: (s = 14) => svg(s, <><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>),
  trash: (s = 18) => svg(s, <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>),
  // Custom order: the "Kārtot" button and the drag handle on each row
  sort: (s = 18) => svg(s, <><path d="M7 4v16M4 7l3-3 3 3" /><path d="M17 20V4M14 17l3 3 3-3" /></>),
  grip: (s = 20) => svg(s, <path d="M5 9h14M5 15h14" />),
  alert: (s = 12) => svg(s, <><path d="M12 5.5v8" /><path d="M12 18.5v.01" /></>),
  // "On order" marker on a toner row
  cart: (s = 14) => svg(s, <><path d="M2.5 4h2.6l2.3 10.5h10.2l1.9-7.5H6.2" /><circle cx="9.5" cy="18.8" r="1.3" /><circle cx="16.5" cy="18.8" r="1.3" /></>),
  // Show / hide a password
  eye: (s = 18) => svg(s, <><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>),
  eyeOff: (s = 18) => svg(s, <><path d="M4 4l16 16" /><path d="M9.6 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.3 7.6A17 17 0 0 0 2.5 12s3.5 6.5 9.5 6.5c1.4 0 2.6-.3 3.7-.8" /><path d="M9.9 9.9a2.8 2.8 0 0 0 4 4" /></>),
  bell: (s = 22) => svg(s, <><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>),
  mail: (s = 18) => svg(s, <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3.5 7.5l8.5 6 8.5-6" /></>),
  clip: (s = 16) => svg(s, <path d="M19 11.5l-7.4 7.4a4.6 4.6 0 0 1-6.5-6.5l8-8a3.1 3.1 0 0 1 4.4 4.4l-7.8 7.8a1.6 1.6 0 0 1-2.3-2.3l7-7" />),
  check: (s = 12) => svg(s, <path d="M5 12.5l4.5 4.5L19 7.5" />),
  close: (s = 20) => svg(s, <path d="M6 6l12 12M18 6L6 18" />),
}
