// CONVERSATION COMPLÈTE (/api/transcript?id=<sessionId>[&before=<octet>|&after=<octet>]) — portage de Front.Transcript
// et Front.TranscriptLine. Tranches d'1 Mo depuis la fin ; jamais la réflexion, ni les entrées techniques, ni les
// sous-agents. Lecture à l'octet près : start/end sont des positions d'octets du fichier, comme dans la façade C#.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { netTrim, netTrimEnd } from './util.ts';

export const CHUNK = 1024 * 1024;
const MAX_READ = 64 * 1024 * 1024;
const RX_CMD_NAME = /<command-name>([^<]*)<\/command-name>/;
const RX_CMD_ARGS = /<command-args>([^<]*)<\/command-args>/s;
const RX_STDOUT = /^<local-command-std(out|err)>(.*)<\/local-command-std(out|err)>$/s;
const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** Cut : « […] (1 234 caractères de plus) », nombre au format N0 de la culture courante. */
export function cut(s: string | null | undefined, max: number): string {
  const v = s ?? '';
  return v.length <= max ? v : v.slice(0, max) + ' […] (' + nf.format(v.length - max) + ' caractères de plus)';
}
type J = unknown;
const isObj = (e: J): e is Record<string, J> => e !== null && typeof e === 'object' && !Array.isArray(e);
/** Prop : texte, « true », sinon null. */
function prop(e: J, name: string): string | null {
  if (!isObj(e) || !(name in e)) return null;
  const v = e[name];
  return typeof v === 'string' ? v : v === true ? 'true' : null;
}
const blank = (s: string | null): boolean => s === null || netTrim(s).length === 0;

function toolSummary(input: J): string {
  const parts: string[] = [];
  for (const k of ['description', 'command', 'file_path', 'pattern', 'path', 'url', 'query', 'skill', 'subagent_type', 'prompt', 'old_string']) {
    const v = prop(input, k);
    if (!blank(v)) { parts.push(cut(netTrim(v!), k === 'command' ? 600 : 240)); if (parts.length === 2) break; }
  }
  if (parts.length) return parts.join('\n');
  // input absent : JsonElement par défaut, GetRawText lève — la route répond 500, comme la façade.
  if (input === undefined) throw new Error('outil sans input');
  return cut(JSON.stringify(input), 300);
}
function resultText(content: J): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let sb = '';
  for (const b of content) { const t = prop(b, 'type'); if (t === 'text') sb += (prop(b, 'text') ?? '') + '\n'; else if (t === 'image') sb += '[image]\n'; }
  return netTrimEnd(sb);
}

/** `o` : provenance d'un message « user » qui ne vient PAS de la personne — 'task' (fin d'une tâche de fond, injectée par
 *  Claude Code) ou 'sdk' (consigne d'un lancement sans terminal, `claude -p`). Absent : tapé ou collé dans la session. */
export interface Item { at: string; r: string; t: string; n?: string; e?: true; o?: 'task' | 'sdk' }
function item(out: Item[], at: string | null, role: string, text: string | null, name: string | null, err: boolean, origin: 'task' | 'sdk' | null = null): void {
  const it: Item = { at: at ?? '', r: role, t: text ?? '' };
  if (name !== null) it.n = name;
  if (err) it.e = true;
  if (origin !== null) it.o = origin;
  out.push(it);
}
/** Provenance d'une ligne « user », telle que Claude Code l'écrit (`origin.kind`, `promptSource`) ; null = la personne. */
function userOrigin(r: Record<string, J>): 'task' | 'sdk' | null {
  if (prop(r.origin, 'kind') === 'task-notification') return 'task';
  return prop(r, 'promptSource') === 'sdk' ? 'sdk' : null;
}

/** Une ligne du transcript → 0..n éléments affichables. */
export function transcriptLine(line: string, out: Item[]): void {
  let r: J;
  try { r = JSON.parse(line); } catch { return; }
  const type = prop(r, 'type');
  if ((type !== 'user' && type !== 'assistant') || prop(r, 'isSidechain') === 'true') return;
  const o = r as Record<string, J>;
  const msg = o.message;
  if (!isObj(msg) || !('content' in msg)) return;
  const content = msg.content;
  const at = prop(r, 'timestamp');
  const origin = type === 'user' ? userOrigin(o) : null;
  if (prop(r, 'isCompactSummary') === 'true') { item(out, at, 'summary', cut(resultText(content), 4000), null, false); return; }
  if (prop(r, 'isMeta') === 'true') return;
  if (typeof content === 'string') {
    let s = content;
    if (type === 'user') {
      if (s.startsWith('<local-command-caveat>')) return;
      const m = RX_CMD_NAME.exec(s);
      if (m) { const a = RX_CMD_ARGS.exec(s); s = netTrim(m[1] + ' ' + (a ? a[1] : '')); }
      else {
        const so = RX_STDOUT.exec(netTrim(s));
        if (so) { if (netTrim(so[2]!).length > 0) item(out, at, 'result', cut(netTrim(so[2]!), 1500), null, so[1] === 'err'); return; }
      }
    }
    if (netTrim(s).length > 0) item(out, at, type, cut(s, 30000), null, false, origin);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    switch (prop(b, 'type')) {
      case 'text': { const s = prop(b, 'text'); if (!blank(s)) item(out, at, type, cut(s, 30000), null, false, origin); break; }
      case 'image': item(out, at, type, '[image jointe]', null, false); break;
      case 'tool_use': item(out, at, 'tool', toolSummary(isObj(b) ? b.input : undefined), prop(b, 'name') ?? 'outil', false); break;
      case 'tool_result': {
        const s = isObj(b) && 'content' in b ? resultText(b.content) : '';
        item(out, at, 'result', cut(netTrim(s), 1500), null, prop(b, 'is_error') === 'true'); break;
      }
    }
  }
}

/** long.TryParse */
function tryLong(s: string | null): number | null { return s !== null && /^\s*[+-]?\d+\s*$/.test(s) ? Number(s.trim()) : null; }

export function readTranscript(file: string, beforeQ: string | null, afterQ: string | null): Record<string, unknown> {
  const afterN = tryLong(afterQ); const forward = afterN !== null; const before = tryLong(beforeQ) ?? 0; const after = afterN ?? 0;
  const fd = openSync(file, 'r');
  let buf: Buffer; let from: number; let to: number; let size: number;
  try {
    size = fstatSync(fd).size;
    if (forward) {
      if (after > size || size - after > 4 * CHUNK) return { reset: true, size };
      from = after; to = size;
    } else {
      to = before > 0 && before <= size ? before : size; from = Math.max(0, to - CHUNK);
    }
    for (;;) {
      buf = Buffer.alloc(to - from);
      let got = 0;
      while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, from + got); if (n <= 0) break; got += n; }
      if (got < buf.length) buf = buf.subarray(0, got);
      if (forward || from === 0 || to - from >= MAX_READ) break;
      const nl = buf.indexOf(10), last = buf.lastIndexOf(10);
      if (nl >= 0 && nl < last) break;
      from = Math.max(0, to - Math.min(MAX_READ, (to - from) * 4));
    }
  } finally { closeSync(fd); }
  let s0 = 0;
  if (!forward && from > 0) { const nl = buf.indexOf(10); s0 = nl < 0 ? buf.length : nl + 1; }
  const lastNl = buf.lastIndexOf(10); const e0 = lastNl < s0 ? s0 : lastNl + 1;
  const items: Item[] = [];
  let i = s0;
  while (i < e0) {
    let j = buf.indexOf(10, i); if (j < 0 || j > e0) j = e0;
    if (j > i) transcriptLine(buf.toString('utf8', i, j), items);
    i = j + 1;
  }
  return { items, start: from + s0, end: from + e0, size };
}
