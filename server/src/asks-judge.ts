// JUGE « attend l’utilisateur ? » : à la fin d'un tour, un petit modèle lit la fin du dernier message d'une session et dit si
// elle attend quelque chose de l'utilisateur (décision, go, mot à taper, essai à faire, proposition à accepter) ou si
// c'est un compte rendu / une attente de tiers. Il remplace l'heuristique `asks()` de la page, qui rate les formes
// non prévues (« I'll do it when you give the go », « Une fois ces deux essais faits, je… », « Je peux regarder… ») et
// rangeait ces sessions « à relire » — puis dans ⏳ Attente Teams si elles avaient aussi écrit à un collègue.
//
// Un appel par (session, fin de message) : verdict mis en cache en mémoire et sur disque, la page garde `asks()` tant
// qu'il n'est pas là (ou si le modèle échoue : quota épuisé, réseau). Appels asynchrones, au plus 2 à la fois — le
// serveur ne se bloque jamais dessus. Serveur en écriture seulement, hors --no-background (tests).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export interface AskVerdict { v: boolean; why: string; at: number }
interface Entry { key: string; verdict?: AskVerdict; fails: number; nextTry: number }

export const ASK_PROMPT_VERSION = 3;
/** Question posée au modèle. Pure : testée. */
export function askPrompt(reply: string): string {
  return [
    'Tu tries des sessions de travail. Entre les balises <message>, la FIN du dernier message qu\'un assistant de code a écrit à son utilisateur.',
    'Question : QUI doit agir maintenant pour que le travail avance ? Ne juge que le texte entre les balises.',
    '"utilisateur" si le message lui pose une question, lui demande un go / un accord / une validation, lui dit quoi taper,',
    'lui demande de faire un essai ou une action, ou lui propose quelque chose à accepter ou refuser (« je peux … »).',
    '"tiers" si la suite attend seulement la réponse d\'une autre personne nommée (collègue), sans rien demander à l\'utilisateur.',
    '"personne" si c\'est un compte rendu de travail fini, ou si ce qui reste est seulement mentionné pour plus tard.',
    'Si le message demande quelque chose à l\'utilisateur ET attend un tiers, réponds "utilisateur".',
    'Réponds UNIQUEMENT par une ligne JSON, la raison d\'abord : {"raison": "<10 mots au plus>", "qui": "utilisateur"|"tiers"|"personne"}',
    '',
    '<message>',
    reply.slice(-1200).replace(/<\/?message>/gi, ''),
    '</message>',
  ].join('\n');
}
/** Lit la réponse du modèle. Pure : testée. undefined = illisible. */
export function parseAskAnswer(out: string | undefined): { v: boolean; why: string } | undefined {
  if (!out) return undefined;
  const m = /\{[\s\S]*?\}/.exec(out); if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { qui?: unknown; raison?: unknown };
    if (j.qui !== 'utilisateur' && j.qui !== 'tiers' && j.qui !== 'personne') return undefined;
    return { v: j.qui === 'utilisateur', why: (j.qui === 'utilisateur' ? '' : j.qui + ' : ') + String(j.raison ?? '').slice(0, 120) };
  } catch { return undefined; }
}
export const askKey = (sessionId: string, reply: string): string =>
  sessionId + ':' + createHash('sha1').update(ASK_PROMPT_VERSION + '\n' + reply.trim()).digest('hex').slice(0, 16);

/** `claude -p` sur le petit modèle, ASYNCHRONE (le serveur ne doit pas attendre). Mêmes options que l'étiqueteur. */
export function claudeAskAsync(exe: string, model: string): (prompt: string) => Promise<string | undefined> {
  return (prompt) => new Promise((ok) => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
    const child = execFile(exe, ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--output-format', 'json', '--max-budget-usd', '0.20', '--max-turns', '1'],
    { encoding: 'utf8', timeout: 120000, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) { ok(undefined); return; }
      try { const j = JSON.parse(out) as { is_error?: unknown; result?: unknown }; ok(j.is_error ? undefined : typeof j.result === 'string' ? j.result : undefined); }
      catch { ok(undefined); }
    });
    child.stdin?.end(prompt, 'utf8');
  });
}

export class AskJudge {
  private entries = new Map<string, Entry>();
  private running = 0;
  private queue: { key: string; reply: string }[] = [];
  private dirty = false;
  private file: string;
  private ask: (prompt: string) => Promise<string | undefined>;
  private opts: { maxConcurrent?: number; now?: () => number };
  constructor(file: string, ask: (prompt: string) => Promise<string | undefined>, opts: { maxConcurrent?: number; now?: () => number } = {}) {
    this.file = file; this.ask = ask; this.opts = opts;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, AskVerdict>;
      for (const [key, verdict] of Object.entries(j)) this.entries.set(key, { key, verdict, fails: 0, nextTry: 0 });
    } catch { /* pas encore de fichier */ }
  }
  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }
  /** Verdict connu pour cette fin de message, sinon null — et la question part en arrière-plan. */
  verdict(sessionId: string, reply: string | null): AskVerdict | null {
    if (!reply || !reply.trim()) return null;
    const key = askKey(sessionId, reply);
    let e = this.entries.get(key);
    if (e?.verdict) return e.verdict;
    if (!e) { e = { key, fails: 0, nextTry: 0 }; this.entries.set(key, e); }
    if (e.fails < 3 && e.nextTry <= this.now() && !this.queue.some((q) => q.key === key)) { this.queue.push({ key, reply }); this.pump(); }
    return null;
  }
  private pump(): void {
    const max = this.opts.maxConcurrent ?? 2;
    while (this.running < max && this.queue.length) {
      const job = this.queue.shift()!; const e = this.entries.get(job.key); if (!e) continue;
      e.nextTry = this.now() + 10 * 60000;        // pas de relance pendant l'appel ; un échec réessaie dans 10 min
      this.running++;
      this.ask(askPrompt(job.reply)).then((out) => {
        const r = parseAskAnswer(out);
        if (r) { e.verdict = { ...r, at: this.now() }; this.dirty = true; this.save(); } else e.fails++;
      }).catch(() => { e.fails++; }).finally(() => { this.running--; this.pump(); });
    }
  }
  /** Garde les 400 verdicts les plus récents. */
  private save(): void {
    if (!this.dirty) return; this.dirty = false;
    const done = [...this.entries.values()].filter((e) => e.verdict).sort((a, b) => b.verdict!.at - a.verdict!.at).slice(0, 400);
    const keep = new Set(done.map((e) => e.key));
    for (const k of [...this.entries.keys()]) if (!keep.has(k) && this.entries.get(k)!.verdict) this.entries.delete(k);
    try { const tmp = this.file + '.tmp'; writeFileSync(tmp, JSON.stringify(Object.fromEntries(done.map((e) => [e.key, e.verdict])))); renameSync(tmp, this.file); }
    catch { /* le cache mémoire suffit */ }
  }
}
