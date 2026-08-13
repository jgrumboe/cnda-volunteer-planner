/** Time helpers. Everything internally is "minutes from midnight". */

/** Parse "9:00", "09:00", "0900" or "9.00" into minutes. Returns null if unparseable. */
export function parseClock(raw: string): number | null {
  const s = raw.trim();
  let m = /^(\d{1,2})[:.h](\d{2})$/.exec(s);
  if (m) return clamp(+m[1] * 60 + +m[2]);
  m = /^(\d{1,2})$/.exec(s);
  if (m) return clamp(+m[1] * 60);
  m = /^(\d{2})(\d{2})$/.exec(s);
  if (m) return clamp(+m[1] * 60 + +m[2]);
  return null;
}

function clamp(v: number): number | null {
  return v >= 0 && v <= 24 * 60 ? v : null;
}

export interface TimeRange {
  start: number;
  end: number;
}

/**
 * Parse a range like "12:00-15:00", "08:00 – 13:00" or "9-17".
 * Accepts hyphen, en dash and em dash.
 */
export function parseTimeRange(raw: string): TimeRange | null {
  if (!raw) return null;
  const parts = String(raw).split(/\s*[-–—]\s*/);
  if (parts.length !== 2) return null;
  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (start === null || end === null) return null;
  if (end <= start) return null;
  return { start, end };
}

export function fmtClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function fmtRange(r: TimeRange): string {
  return `${fmtClock(r.start)}-${fmtClock(r.end)}`;
}

/** Half-open overlap: touching ranges (17:00 end / 17:00 start) do NOT overlap. */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function durationHours(r: TimeRange): number {
  return (r.end - r.start) / 60;
}
