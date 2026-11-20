// LECTURE DE L'ÉCRAN `/usage` DE CLAUDE CODE (sonde d'usage, usage-probe.ts) — fonctions pures.
//
// `claude -p '/usage'` rend un texte : on n'en garde QUE la ligne d'abonnement et les lignes « Current … » ; la suite
// (« What's contributing to your usage? ») cite des chemins locaux, des skills et des serveurs MCP : jamais gardée.
//
//   You are currently using your subscription to power your Claude Code usage
//   Current week (all models): 27% used · resets Nov 25, 6:59pm (Europe/Paris)
//   Current week (Fable): 28% used · resets Nov 25, 6:59pm (Europe/Paris)
//
// « Current session » (fenêtre de 5 h) est lue de la même façon quand elle est là. Un écran sans aucune de ces lignes
// n'est pas deviné : `windows` vide, et l'appelant le dit (`error:format`).

export type WindowKind = 'five_hour' | 'weekly_all' | 'weekly_scoped';
export interface UsageWindow { kind: WindowKind; model: string | null; percent: number; resetsText: string; resetsAt: number | null }
export interface UsageScreen { subscription: boolean; windows: UsageWindow[] }

const LINE = /^\s*Current\s+(session|week\s*\(([^)]+)\))\s*:\s*(\d+(?:\.\d+)?)\s*%\s*used(?:\s*[·•-]\s*resets\s+(.+?))?\s*$/i;
const SUBSCRIPTION = /using your subscription/i;

/** Les fenêtres de quota d'un écran `/usage`. */
export function parseUsageScreen(text: string, now: number): UsageScreen {
  const windows: UsageWindow[] = [];
  let subscription = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (SUBSCRIPTION.test(line)) { subscription = true; continue; }
    const m = LINE.exec(line);
    if (!m) continue;
    const scope = (m[2] ?? '').trim();
    const kind: WindowKind = m[1]!.toLowerCase() === 'session' ? 'five_hour' : /^all models$/i.test(scope) ? 'weekly_all' : 'weekly_scoped';
    const resetsText = (m[4] ?? '').trim();
    windows.push({ kind, model: kind === 'weekly_scoped' ? scope : null, percent: Number(m[3]), resetsText, resetsAt: resetsText ? parseResets(resetsText, now) : null });
  }
  return { subscription, windows };
}

/** Lignes gardées d'un écran (abonnement et « Current … ») : ce qu'on conserve pour corriger une lecture ratée. */
export function keptLines(text: string): string[] {
  return String(text ?? '').split(/\r?\n/).filter((l) => SUBSCRIPTION.test(l) || /^\s*Current\s/i.test(l)).map((l) => l.trim()).slice(0, 20);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESETS = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?$/i;

/** Décalage (ms) du fuseau `tz` à l'instant `utcMs` ; lève si le fuseau est inconnu. */
function tzOffset(tz: string, utcMs: number): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - utcMs;
}
/** Heure murale (année, mois 0-11, jour, heure, minute) du fuseau `tz` ⇒ instant UTC. */
function wallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - tzOffset(tz, guess);
  return guess - tzOffset(tz, first);
}
/** Date du jour (année, mois, jour) dans le fuseau `tz`. */
function todayIn(tz: string, now: number): [number, number, number] {
  const local = new Date(now + tzOffset(tz, now));
  return [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
}

/**
 * « Nov 25, 6:59pm (Europe/Paris) » ⇒ instant. Sans date (« 6:59pm (Europe/Paris) ») : aujourd'hui, ou demain si
 * l'heure est passée. L'année n'est pas écrite : la prochaine occurrence (une remise est toujours à venir, à un jour
 * près). Sans fuseau : celui de la machine. Illisible ou fuseau inconnu ⇒ null (le texte reste affichable).
 */
export function parseResets(text: string, now: number): number | null {
  const m = RESETS.exec(String(text ?? '').trim());
  if (!m) return null;
  const tz = (m[6] ?? Intl.DateTimeFormat().resolvedOptions().timeZone).trim();
  let h = Number(m[3]); const mi = Number(m[4] ?? 0); const ap = (m[5] ?? '').toLowerCase();
  if (h > 23 || mi > 59 || (ap && (h < 1 || h > 12))) return null;
  if (ap === 'pm' && h < 12) h += 12; else if (ap === 'am' && h === 12) h = 0;
  try {
    const [y, mo, d] = todayIn(tz, now);
    if (m[1]) {
      const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); const day = Number(m[2]);
      if (month < 0 || day < 1 || day > 31) return null;
      let t = wallToUtc(tz, y, month, day, h, mi);
      if (t < now - 86_400_000) t = wallToUtc(tz, y + 1, month, day, h, mi);
      return t;
    }
    let t = wallToUtc(tz, y, mo, d, h, mi);
    if (t < now) t = wallToUtc(tz, y, mo, d + 1, h, mi);
    return t;
  } catch { return null; }
}
