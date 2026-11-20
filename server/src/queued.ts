// MESSAGES EN FILE — un message tapé pendant que la session travaille (« Mettre en file », ou dans le terminal) n'entre
// dans history.jsonl, d'où viennent les « Derniers prompts », qu'une fois pris par Claude Code. En attendant, seul le
// transcript le connaît, par des lignes « queue-operation » :
//   · enqueue  (content)          : ajouté en fin de file ;
//   · dequeue  (sans content)     : la TÊTE de file est prise au tour suivant ;
//   · remove   (content, reason)  : retiré nommément (absorbé en cours de tour, rappelé dans l'invite par ↑…).
// On rejoue ces opérations sur la fenêtre lue pour savoir ce qui attend encore. Les notifications que Claude Code met
// lui-même en file (<task-notification>…) comptent pour l'ordre mais ne s'affichent pas : ce ne sont pas tes messages.

export interface QueuedPrompt { at: string | null; text: string }

interface Op { operation?: unknown; content?: unknown; timestamp?: unknown }

const shown = (t: string): boolean => !t.trimStart().startsWith('<');

/** Messages encore en file, du plus ancien au plus récent, d'après les lignes du transcript (dans l'ordre). */
export function pendingQueue(lines: readonly string[]): QueuedPrompt[] {
  const q: { at: string | null; text: string | null }[] = [];
  for (const l of lines) {
    if (!l.startsWith('{"type":"queue-operation"')) continue;
    let o: Op;
    try { o = JSON.parse(l) as Op; } catch { continue; }
    const text = typeof o.content === 'string' ? o.content : null;
    if (o.operation === 'enqueue') q.push({ at: typeof o.timestamp === 'string' ? o.timestamp : null, text });
    else if (o.operation === 'dequeue') q.shift();
    else if (o.operation === 'remove') { const i = text == null ? -1 : q.findIndex((x) => x.text === text); if (i >= 0) q.splice(i, 1); }
  }
  return q.filter((x): x is QueuedPrompt => x.text != null && shown(x.text)).map((x) => ({ at: x.at, text: x.text.slice(0, 400) }));
}
