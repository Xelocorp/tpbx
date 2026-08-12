// Local call log for the Recents tab. Entries come from finished calls and are
// persisted in localStorage so history survives restarts. Capped so the file
// never grows unbounded.

export interface LogEntry {
  id: number;
  peer: string;
  direction: "in" | "out";
  outcome: "answered" | "rejected" | "missed" | "failed";
  durationSec: number;
  at: number; // epoch ms
}

const KEY = "xelovoice.calllog";
const CAP = 200;

export function loadLog(): LogEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as LogEntry[];
  } catch {
    /* ignore */
  }
  return [];
}

export function addLog(entry: Omit<LogEntry, "id">): LogEntry[] {
  const list = loadLog();
  list.unshift({ ...entry, id: Date.now() + Math.floor(performance.now()) });
  const capped = list.slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(capped));
  } catch {
    /* ignore */
  }
  return capped;
}

export function clearLog(): LogEntry[] {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return [];
}

export interface LogGroup {
  label: string;
  items: LogEntry[];
}

// group buckets entries into Today / Yesterday / a date label, newest first.
export function groupLog(list: LogEntry[]): LogGroup[] {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = today - 86400000;

  const groups: LogGroup[] = [];
  const index = new Map<string, LogGroup>();
  for (const e of list) {
    const day = startOfDay(new Date(e.at));
    let label: string;
    if (day === today) label = "TODAY";
    else if (day === yesterday) label = "YESTERDAY";
    else label = new Date(e.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    let g = index.get(label);
    if (!g) {
      g = { label, items: [] };
      index.set(label, g);
      groups.push(g);
    }
    g.items.push(e);
  }
  return groups;
}

export function fmtDur(sec: number): string {
  if (!sec) return "0s";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
