// QUESTIONS MISES DE CÔTÉ — ce que la session avait demandé avant que la personne choisisse « Chat about this ».
// Ce choix ferme le dialogue du terminal : plus rien à lire à l'écran, et la page perdait d'un coup les questions et
// leurs options, au moment précis où l'on veut en discuter. Elles restent dans le transcript (l'appel AskUserQuestion
// et son refus « The user wants to clarify these questions ») : on les y relit pour que la page les garde sous les yeux.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface ParkedOption { label: string; description: string }
export interface ParkedQuestion { header: string; question: string; multi: boolean; options: ParkedOption[] }
/** `replies` : messages de la personne depuis la mise de côté (0 = elle n'a encore rien écrit). */
export interface Parked { id: string; replies: number; questions: ParkedQuestion[] }

const TAIL = 1024 * 1024;
const MARK = 'The user wants to clarify these questions';
type J = unknown;
const isObj = (e: J): e is Record<string, J> => e !== null && typeof e === 'object' && !Array.isArray(e);
const str = (v: J, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function questionsOf(input: J): ParkedQuestion[] {
  const out: ParkedQuestion[] = [];
  const qs = isObj(input) && Array.isArray(input.questions) ? input.questions : [];
  for (const q of qs.slice(0, 8)) {
    if (!isObj(q)) continue;
    const question = str(q.question, 2000); if (!question) continue;
    const options: ParkedOption[] = [];
    for (const o of (Array.isArray(q.options) ? q.options : []).slice(0, 8)) {
      if (!isObj(o)) continue;
      const label = str(o.label, 200); if (label) options.push({ label, description: str(o.description, 1000) });
    }
    out.push({ header: str(q.header, 60), question, multi: q.multiSelect === true, options });
  }
  return out;
}
function resultText(content: J): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join('\n');
}

/** Les lignes d'un transcript, dans l'ordre → les questions mises de côté et encore d'actualité, sinon null. Pur.
 *  Une nouvelle question posée par la session les remplace : c'est alors le dialogue du terminal qui fait foi. */
export function parkedFromLines(lines: Iterable<string>): Parked | null {
  let asked: { id: string; questions: ParkedQuestion[] } | null = null; let parked: Parked | null = null;
  for (const line of lines) {
    if (!line.includes('AskUserQuestion') && !line.includes('"user"')) continue;
    let r: J; try { r = JSON.parse(line); } catch { continue; }
    if (!isObj(r) || r.isSidechain === true || !isObj(r.message)) continue;
    const content = r.message.content;
    if (r.type === 'assistant') {
      for (const b of Array.isArray(content) ? content : []) {
        if (!isObj(b) || b.type !== 'tool_use' || b.name !== 'AskUserQuestion' || typeof b.id !== 'string') continue;
        asked = { id: b.id, questions: questionsOf(b.input) }; parked = null;
      }
      continue;
    }
    if (r.type !== 'user' || r.isMeta === true || r.isCompactSummary === true) continue;
    let typed = typeof content === 'string' && !!content.trim() && !content.trimStart().startsWith('<');
    for (const b of Array.isArray(content) ? content : []) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) typed = true;
      if (b.type !== 'tool_result' || !asked || b.tool_use_id !== asked.id) continue;
      if (b.is_error === true && asked.questions.length && resultText(b.content).includes(MARK)) parked = { id: asked.id, replies: 0, questions: asked.questions };
      asked = null;
    }
    // Un message injecté (fin d'une tâche de fond, consigne d'un lancement sans terminal) n'est pas une réponse.
    const injected = (isObj(r.origin) && r.origin.kind === 'task-notification') || r.promptSource === 'sdk';
    if (typed && parked && !injected) parked.replies++;
  }
  return parked;
}

const cache = new Map<string, { size: number; mtimeMs: number; v: Parked | null }>();
/** Lit la fin du transcript (1 Mo) ; relu seulement quand le fichier a changé. Illisible : null. */
export function parkedQuestions(file: string): Parked | null {
  let fd: number; try { fd = openSync(file, 'r'); } catch { return null; }
  try {
    const st = fstatSync(fd); const hit = cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.v;
    const from = Math.max(0, st.size - TAIL); let buf = Buffer.alloc(st.size - from); let got = 0;
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, from + got); if (n <= 0) break; got += n; }
    buf = buf.subarray(0, got);
    const lines = buf.toString('utf8').split('\n');
    if (from > 0) lines.shift();   // première ligne coupée par la fenêtre
    const v = parkedFromLines(lines);
    if (cache.size > 200) cache.clear();
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, v });
    return v;
  } catch { return null; } finally { closeSync(fd); }
}
