// BROUILLONS DE NOUVELLE SESSION — le formulaire « Nouvelle session » enregistré sans être lancé : dossier, premier
// message, pièces jointes, tags, modèle, branche neuve, session source. Gardés sur le poste (un fichier d'état, comme
// les favoris) : la page les retrouve d'un navigateur à l'autre, téléphone compris. Rien n'est contrôlé ici au-delà de
// la forme : le lancement refait TOUS les contrôles de /api/new (dossier proposé, modèle, branche, tags), car un
// brouillon peut attendre des jours et le poste changer entre-temps. Lancé avec succès, le brouillon disparaît.
import { randomUUID } from 'node:crypto';
import { fileSize, mtimeMs, readJson, setContentAtomic } from './util.ts';
import { T } from './i18n.ts';

export interface DraftTag { axis: string; v: string }
export interface DraftAttachment { name: string; path: string; img: boolean; size: number; pasted: number }
export interface Draft {
  id: string; cwd: string; prompt: string; model: string; branch: string;
  forkFrom: string; forkTitle: string; tags: DraftTag[]; attachments: DraftAttachment[];
  createdAt: number; updatedAt: number;
}

export const MAX_DRAFTS = 50;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown, max: number): string | null => (v === undefined || v === null ? '' : typeof v === 'string' && v.length <= max ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Forme d'un brouillon reçu de la page (ou relu du fichier) : texte borné, listes bornées. Erreur lisible sinon. */
export function cleanDraft(raw: unknown): Omit<Draft, 'id' | 'createdAt' | 'updatedAt'> | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return T('brouillon : objet attendu', 'draft: an object is expected');
  const o = raw as Record<string, unknown>;
  const cwd = str(o.cwd, 400), prompt = str(o.prompt, 20000), model = str(o.model, 80), branch = str(o.branch, 80);
  const forkFrom = str(o.forkFrom, 36), forkTitle = str(o.forkTitle, 200);
  if (cwd === null) return T('dossier invalide', 'invalid folder');
  if (prompt === null) return T('premier message trop long', 'first message too long');
  if (model === null || branch === null) return T('modèle ou branche invalide', 'invalid model or branch');
  if (forkFrom === null || (forkFrom && !ID.test(forkFrom)) || forkTitle === null) return T('session source invalide', 'invalid source session');
  const tagsRaw = o.tags ?? [], attRaw = o.attachments ?? [];
  if (!Array.isArray(tagsRaw) || tagsRaw.length > 8) return T('tags : 8 au plus', 'tags: 8 at most');
  if (!Array.isArray(attRaw) || attRaw.length > 20) return T('pièces jointes : 20 au plus', 'attachments: 20 at most');
  const tags: DraftTag[] = [];
  for (const t of tagsRaw) {
    const r = (t !== null && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const axis = str(r.axis, 20), v = str(r.v, 60);
    if (!axis || !v) return T('tag invalide', 'invalid tag');
    tags.push({ axis, v });
  }
  const attachments: DraftAttachment[] = [];
  for (const a of attRaw) {
    const r = (a !== null && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    const name = str(r.name, 200), path = str(r.path, 500);
    if (!name || !path) return T('pièce jointe invalide', 'invalid attachment');
    attachments.push({ name, path, img: r.img === true, size: num(r.size), pasted: num(r.pasted) });
  }
  if (!cwd && !prompt.trim() && !attachments.length && !forkFrom) return T('brouillon vide', 'empty draft');
  return { cwd, prompt, model, branch, forkFrom, forkTitle, tags, attachments };
}

/** Fichier des brouillons (liste, du plus récemment modifié au plus ancien). Relu s'il a changé (autre serveur du poste). */
export class Drafts {
  readonly file: string;
  #list: Draft[] = [];
  #stamp = '';
  readonly now: () => number;
  readonly newId: () => string;

  constructor(file: string, now: () => number = Date.now, newId: () => string = randomUUID) {
    this.file = file; this.now = now; this.newId = newId; this.#reload();
  }

  #reload(): void {
    const stamp = mtimeMs(this.file) + ':' + fileSize(this.file);
    if (stamp === this.#stamp) return;
    this.#stamp = stamp;
    const j = readJson(this.file);
    const out: Draft[] = [];
    for (const x of Array.isArray(j) ? j : []) {
      const o = (x ?? {}) as Record<string, unknown>;
      const c = cleanDraft(o);
      if (typeof c === 'string' || typeof o.id !== 'string' || !ID.test(o.id)) continue;   // ligne abîmée : ignorée, pas fatale
      out.push({ id: o.id, ...c, createdAt: num(o.createdAt), updatedAt: num(o.updatedAt) });
    }
    this.#list = out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  #write(): void {
    setContentAtomic(this.file, JSON.stringify(this.#list));
    this.#stamp = mtimeMs(this.file) + ':' + fileSize(this.file);
  }

  list(): Draft[] { this.#reload(); return this.#list.map((d) => ({ ...d, tags: d.tags.map((t) => ({ ...t })), attachments: d.attachments.map((a) => ({ ...a })) })); }

  /** Crée (sans id) ou remplace (id d'un brouillon existant). Un id inconnu crée un brouillon neuf : l'ancien a pu être
   *  lancé ou supprimé d'un autre navigateur entre-temps — on ne perd pas ce qui vient d'être tapé. */
  save(raw: unknown): { id: string } | { error: string } {
    const c = cleanDraft(raw);
    if (typeof c === 'string') return { error: c };
    this.#reload();
    const want = typeof (raw as Record<string, unknown>).id === 'string' ? String((raw as Record<string, unknown>).id) : '';
    const i = want && ID.test(want) ? this.#list.findIndex((d) => d.id === want) : -1;
    const at = this.now();
    if (i >= 0) {
      const d = { ...this.#list[i]!, ...c, updatedAt: at };
      this.#list.splice(i, 1); this.#list.unshift(d);
      this.#write(); return { id: d.id };
    }
    if (this.#list.length >= MAX_DRAFTS) return { error: T(`${MAX_DRAFTS} brouillons au plus : supprime ou lance les anciens`, `${MAX_DRAFTS} drafts at most: delete or launch the old ones`) };
    const d: Draft = { id: this.newId(), ...c, createdAt: at, updatedAt: at };
    this.#list.unshift(d); this.#write();
    return { id: d.id };
  }

  /** Retire un brouillon ; faux s'il n'existait plus (déjà lancé ou supprimé ailleurs). */
  remove(id: string): boolean {
    this.#reload();
    const i = this.#list.findIndex((d) => d.id === id);
    if (i < 0) return false;
    this.#list.splice(i, 1); this.#write();
    return true;
  }
}
