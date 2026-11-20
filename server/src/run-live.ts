// CE QUE FAIT UN RUN EN COURS (claude -p, sans terminal) — lu dans le transcript du run (stream-json, une ligne par
// événement), puisqu'il n'y a pas d'écran à lire. On en tire : l'outil en cours (appel sans résultat), la description
// que Claude Code lui a donnée (`task_started`), le dernier texte de Claude, la liste de tâches s'il en tient une, le
// nombre d'outils appelés et l'heure du dernier mouvement. Lecture INCRÉMENTALE : seuls les octets ajoutés depuis la
// passe précédente sont relus (un run de dev dépasse vite plusieurs Mo, l'état est demandé toutes les 2 s).
// Le même parseur lit un transcript de session Claude Code (.jsonl du dossier projects) : mêmes `assistant`/`user`.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { netTrim } from './util.ts';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && netTrim(v).length ? netTrim(v) : null);
const oneLine = (s: string, max: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length <= max ? t : t.slice(0, max - 1) + '…'; };

export interface LiveTool { id: string; name: string; label: string; since: number | null; inner: LiveTool | null }
export interface LiveTodos { done: number; total: number; current: string | null }
/** `partial` : le transcript était trop gros pour être relu en entier ; `tools` ne compte alors que la fin (« ≥ N »). */
export interface RunLive { lastAt: number | null; now: LiveTool | null; text: string | null; tools: number; partial: boolean; todos: LiveTodos | null }

/** Libellé d'un appel d'outil : la description si Claude en a donné une, sinon la commande, le fichier, le motif… */
export function toolLabel(name: string, input: unknown): string {
  if (isObj(input)) {
    for (const k of ['description', 'command', 'file_path', 'pattern', 'path', 'url', 'query', 'skill', 'prompt']) {
      const v = str(input[k]);
      if (v) return oneLine(k === 'file_path' || k === 'path' ? v.replace(/^.*[\\/]/, '') : v, 140);
    }
  }
  return name;
}

interface Pending { id: string; name: string; label: string; since: number | null; parent: string | null; seq: number }
/** État accumulé ligne après ligne. Pur : `feed` ne touche à rien d'autre que lui. */
export class LiveState {
  #pending = new Map<string, Pending>();
  #seq = 0;
  tools = 0;
  text: string | null = null;
  todos: LiveTodos | null = null;
  lastAt: number | null = null;
  partial = false;

  feed(line: string): void {
    if (!line.trim()) return;
    let e: unknown; try { e = JSON.parse(line); } catch { return; }
    if (!isObj(e)) return;
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (!isNaN(ts)) this.lastAt = ts;
    const parent = str(e.parent_tool_use_id);
    if (e.type === 'system' && e.subtype === 'task_started') {
      // Description donnée par Claude Code à la commande lancée (« Regenerate swagger and inspect diff »).
      const p = this.#pending.get(String(e.tool_use_id ?? '')); const d = str(e.description);
      if (p && d) p.label = oneLine(d, 140);
      return;
    }
    const msg = isObj(e.message) ? e.message : null;
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    if (e.type === 'assistant') {
      for (const c of content) {
        if (!isObj(c)) continue;
        if (c.type === 'tool_use' && typeof c.id === 'string') {
          const name = String(c.name ?? '?');
          this.#pending.set(c.id, { id: c.id, name, label: toolLabel(name, c.input), since: isNaN(ts) ? null : ts, parent, seq: ++this.#seq });
          if (!parent) this.tools++;
          if (name === 'TodoWrite' && isObj(c.input) && Array.isArray(c.input.todos)) this.todos = todosOf(c.input.todos);
        } else if (c.type === 'text' && !parent) {
          const t = str(c.text); if (t) this.text = oneLine(t, 280);
        }
      }
    } else if (e.type === 'user') {
      for (const c of content) if (isObj(c) && c.type === 'tool_result') this.#pending.delete(String(c.tool_use_id ?? ''));
    }
  }

  /** L'outil en cours au niveau de la conversation principale (le plus récent), et, si c'est un sous-agent, le sien. */
  now(): LiveTool | null {
    let top: Pending | null = null;
    for (const p of this.#pending.values()) if (!p.parent && (!top || p.seq > top.seq)) top = p;
    if (!top) return null;
    let inner: Pending | null = null;
    for (const p of this.#pending.values()) if (p.parent === top.id && (!inner || p.seq > inner.seq)) inner = p;
    const view = (p: Pending, i: LiveTool | null): LiveTool => ({ id: p.id, name: p.name, label: p.label, since: p.since, inner: i });
    return view(top, inner ? view(inner, null) : null);
  }

  snapshot(): RunLive { return { lastAt: this.lastAt, now: this.now(), text: this.text, tools: this.tools, partial: this.partial, todos: this.todos }; }
}

export function todosOf(list: unknown[]): LiveTodos {
  let done = 0, current: string | null = null;
  for (const t of list) {
    if (!isObj(t)) continue;
    if (t.status === 'completed') done++;
    else if (t.status === 'in_progress' && !current) current = str(t.activeForm) ?? str(t.content);
  }
  return { done, total: list.length, current: current ? oneLine(current, 140) : null };
}

/** Au premier passage, on ne relit que la fin d'un gros transcript : un outil en cours est forcément récent. */
export const FIRST_READ = 16 * 1024 * 1024;
interface Entry { pos: number; rest: Buffer; skipFirst: boolean; state: LiveState }
const cache = new Map<string, Entry>();

/** Lecture incrémentale du transcript `file` ; null s'il est absent ou illisible. On ne décode que jusqu'au dernier
 *  saut de ligne : une ligne en cours d'écriture (et un caractère UTF-8 à moitié écrit) attend la passe suivante. */
export function runLive(file: string, firstRead = FIRST_READ): RunLive | null {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return null; }
  try {
    const st = fstatSync(fd);
    let c = cache.get(file);
    if (!c || st.size < c.pos) {
      // Nouveau fichier, ou fichier tronqué/réécrit : on repart de zéro. Lu par la fin, la 1re ligne est coupée.
      const pos = Math.max(0, st.size - firstRead);
      c = { pos, rest: Buffer.alloc(0), skipFirst: pos > 0, state: new LiveState() };
      c.state.partial = pos > 0;
      cache.set(file, c);
    }
    if (st.size > c.pos) {
      const buf = Buffer.alloc(st.size - c.pos);
      let off = 0;
      while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, c.pos + off); if (n <= 0) break; off += n; }
      c.pos += off;
      const all = Buffer.concat([c.rest, buf.subarray(0, off)]);
      const nl = all.lastIndexOf(0x0a);
      if (nl >= 0) {
        c.rest = Buffer.from(all.subarray(nl + 1));
        const lines = all.subarray(0, nl).toString('utf8').split('\n');
        if (c.skipFirst) { lines.shift(); c.skipFirst = false; }
        for (const l of lines) c.state.feed(l);
      } else c.rest = all;
    }
    const snap = c.state.snapshot();
    // Les événements stream-json ne sont pas tous horodatés : la date du fichier dit le dernier mouvement réel.
    if (snap.lastAt == null || st.mtimeMs > snap.lastAt) snap.lastAt = Math.round(st.mtimeMs);
    return snap;
  } catch { return null; } finally { closeSync(fd); }
}
