// CARTES de questions que l'orchestrateur adresse à l'opérateur (module « launcher », clé `cardsApi`) : lues et
// RÉPONDUES depuis la page, comme le dialogue d'une session. Tout passe par une commande externe, configurée hors
// dépôt, qui tient seule le jeton et l'adresse du système de tickets — ce serveur ne voit ni l'un ni l'autre :
//   <cardsApi> pending                                  → { token, cards: [...], errors, more }
//   <cardsApi> cards <ticket>                           → { token, cards: [...] }
//   <cardsApi> answer <ticket> <carte> --answers-file f → { ok, note } | { ok: false, error, gone? }
// Chaque commande répond par UNE ligne JSON (la dernière de sa sortie). La vérité d'une carte est le ticket : la
// commande le relit, et relit encore juste avant de répondre.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nowMs } from './util.ts';

type Obj = Record<string, unknown>;
export interface CardsModule { cardsApi: string; python: string }
const TICKET_RE = /^[1-9]\d{0,8}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_OTHER = 2000;

/** Corps de POST /api/launcher/answer, réduit à ce que la commande reçoit — PURE. null = demande invalide. */
export function answerBody(j: unknown): { hd: string; card: string; answers: Obj[] } | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const b = j as Obj;
  const hd = typeof b.hd === 'number' ? String(b.hd) : b.hd, card = typeof b.card === 'number' ? String(b.card) : b.card;
  if (typeof hd !== 'string' || !TICKET_RE.test(hd) || typeof card !== 'string' || !TICKET_RE.test(card)) return null;
  if (!Array.isArray(b.answers) || b.answers.length < 1 || b.answers.length > 8) return null;
  const answers: Obj[] = [];
  for (const a of b.answers as unknown[]) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    const x = a as Obj;
    if (typeof x.questionId !== 'string' || !ID_RE.test(x.questionId)) return null;
    const selected = x.selected ?? [];
    if (!Array.isArray(selected) || selected.length > 8 || selected.some((s) => typeof s !== 'string' || !ID_RE.test(s))) return null;
    if (x.other !== undefined && x.other !== null && typeof x.other !== 'string') return null;
    const other = typeof x.other === 'string' ? x.other.trim() : '';
    if (other.length > MAX_OTHER) return null;
    if (selected.length || other) answers.push({ questionId: x.questionId, selected, other: other || null });
  }
  return answers.length ? { hd, card, answers } : null;
}

function resolveApi(env: NodeJS.ProcessEnv, mod: CardsModule | null): { api: string } | { error: string } {
  const api = env.SD_LAUNCHER_CARDS_API || mod?.cardsApi || '';
  if (!api) return { error: 'cartes non configurées (modules.launcher.cardsApi)' };
  if (!existsSync(api)) return { error: `commande des cartes introuvable (${api})` };
  return { api };
}

function run(args: string[], timeout: number, env: NodeJS.ProcessEnv, mod: CardsModule | null): Promise<Obj> {
  const r = resolveApi(env, mod);
  if ('error' in r) return Promise.resolve({ error: r.error });
  return new Promise((done) => {
    execFile(env.SD_LAUNCHER_PYTHON || mod?.python || 'python', ['-X', 'utf8', r.api, ...args],
      { cwd: dirname(r.api), windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 16 << 20, env: { ...env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout) => {
        const last = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
        let v: unknown = null; try { v = JSON.parse(last); } catch { v = null; }
        if (v && typeof v === 'object' && !Array.isArray(v)) { done(v as Obj); return; }
        const code = (err as NodeJS.ErrnoException | null)?.code;
        done({ error: code === 'ENOENT' ? 'cartes illisibles : python introuvable' : err ? 'cartes illisibles : la commande a échoué' : 'cartes illisibles' });
      });
  });
}

/** Les cartes ouvertes d'UN ticket, relues à l'instant (pas de cache : c'est ce qu'on affiche avant de répondre). */
export function lookupCards(hd: string, env: NodeJS.ProcessEnv = process.env, mod: CardsModule | null = null): Promise<Obj> {
  if (!TICKET_RE.test(hd)) return Promise.resolve({ error: 'demande invalide' });
  return run(['cards', hd], 30000, env, mod);
}

/** Répond à une carte : { ok: true, note } ou { ok: false, error, gone? }. Les réponses voyagent par un fichier
 *  temporaire (jamais en argument), retiré ensuite. */
export async function answerCard(j: unknown, env: NodeJS.ProcessEnv = process.env, mod: CardsModule | null = null): Promise<Obj> {
  const b = answerBody(j);
  if (!b) return { ok: false, error: 'demande invalide' };
  const dir = mkdtempSync(join(tmpdir(), 'sd-answer-'));
  try {
    const file = join(dir, 'answers.json');
    writeFileSync(file, JSON.stringify({ answers: b.answers }), 'utf8');
    const r = await run(['answer', b.hd, b.card, '--answers-file', file], 60000, env, mod);
    if (r.ok === true) return r;
    return { ok: false, error: typeof r.error === 'string' && r.error ? r.error : 'réponse refusée', ...(r.gone ? { gone: true } : {}) };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fichier temporaire */ } }
}

/** Les cartes ouvertes de TOUS les tickets, pour la liste et les alertes. La vue ne les attend jamais : elle reçoit le
 *  dernier relevé, et un relevé de plus d'une minute (15 s tant que la commande dit qu'il lui reste des tickets à
 *  relire) est rafraîchi en arrière-plan. */
export class CardsFeed {
  #value: Obj = { token: 'unknown', cards: [], errors: [] };
  #at = 0;
  #busy = false;
  readonly #env: NodeJS.ProcessEnv;
  readonly #mod: CardsModule | null;
  /** Appelé après chaque relevé d'arrière-plan : la vue qui porte les cartes ne doit pas rester sur son cache. */
  readonly #onRefresh: (() => void) | null;
  constructor(mod: CardsModule | null, env: NodeJS.ProcessEnv = process.env, onRefresh: (() => void) | null = null) { this.#mod = mod; this.#env = env; this.#onRefresh = onRefresh; }
  get configured(): boolean { return !!(this.#env.SD_LAUNCHER_CARDS_API || this.#mod?.cardsApi); }
  invalidate(): void { this.#at = 0; }
  /** Retire tout de suite une carte répondue : la page ne la repropose pas en attendant le relevé suivant. */
  drop(hd: string, card: string): void {
    const cards = Array.isArray(this.#value.cards) ? (this.#value.cards as Obj[]) : [];
    this.#value = { ...this.#value, cards: cards.filter((c) => !(String(c.hd) === hd && String(c.id) === card)) };
    this.#at = 0;
  }
  async refresh(): Promise<Obj> {
    if (!this.configured) return this.#value = { token: 'off', cards: [], errors: [] };
    const v = await run(['pending'], 120000, this.#env, this.#mod);
    this.#at = nowMs();
    if (Array.isArray(v.cards)) this.#value = v;
    else this.#value = { ...this.#value, error: typeof v.error === 'string' ? v.error : 'cartes illisibles' };
    return this.#value;
  }
  current(): Obj {
    if (!this.configured) return { token: 'off', cards: [], errors: [] };
    const maxAge = Number(this.#value.more ?? 0) > 0 ? 15000 : 60000;
    if (!this.#busy && nowMs() - this.#at > maxAge) {
      this.#busy = true;
      void this.refresh().catch(() => undefined).finally(() => { this.#busy = false; this.#onRefresh?.(); });
    }
    return this.#value;
  }
}
