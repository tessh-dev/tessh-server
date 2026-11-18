// Named 16×16 line icons (stroke follows the text colour) and the Apple logo.
// The Apple path is from Simple Icons (CC0).
const line = (shapes: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;

export const icons = {
  mail: line('<rect x="2" y="3.5" width="12" height="9" rx="2"/><path d="m2.5 5 5.5 4 5.5-4"/>'),
  globe: line('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 1.8 2.8 3.8 2.8 6S10 12.2 8 14C6 12.2 5.2 10.2 5.2 8S6 3.8 8 2z"/>'),
  lock: line('<rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  copy: line('<rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 5.5V4.5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1"/>'),
  server: line('<rect x="2" y="2.5" width="12" height="4.5" rx="1.5"/><rect x="2" y="9" width="12" height="4.5" rx="1.5"/><path d="M4.5 4.8h.01M4.5 11.3h.01"/>'),
  cloud: line('<path d="M4.5 12.5a3 3 0 0 1-.4-5.97A4 4 0 0 1 11.8 6.2 3.2 3.2 0 0 1 11.5 12.5z"/>'),
  plus: line('<path d="M8 3v10M3 8h10"/>'),
  gear: line('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>'),
  grid: line('<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="9" width="4.5" height="4.5" rx="1.2"/>'),
  people: line('<circle cx="6" cy="5.5" r="2.3"/><path d="M1.8 13c.3-2.3 2-3.5 4.2-3.5s3.9 1.2 4.2 3.5"/><path d="M10.5 3.6a2.3 2.3 0 0 1 0 4.3M12 9.7c1.4.5 2.2 1.6 2.4 3.3"/>'),
  list: line('<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>'),
  signout: line('<path d="M6.5 2.5h-2a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2M10 5l3 3-3 3M13 8H6"/>'),
  chevron: line('<path d="m6 3.5 4.5 4.5L6 12.5"/>'),
  chevronDown: line('<path d="m3.5 6 4.5 4.5L12.5 6"/>'),
  apple:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path transform="scale(.6667)" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
} as const;

export type IconName = keyof typeof icons;
