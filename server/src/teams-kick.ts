// REMISE DÈS QUE LA SESSION SE LIBÈRE — une réponse Teams (ou un message d'un fil confié) arrivée pendant que la
// session travaille est mise de côté (« pas encore transmise (session busy) ») et remise par la passe SUIVANTE du
// veilleur, une tâche planifiée qui ne tourne que toutes les 2 min. Entre la fin du tour et cette passe, la page
// montre une session au repos — souvent avec une proposition de prompt à l'écran — et une réponse qui ne lui parvient
// pas : on croit l'envoi bloqué. Le serveur voit, lui, la session se libérer à la seconde près : il relance alors une
// passe tout de suite.

const FREE = new Set(['idle', 'shell']);

export interface KickSession { sessionId: string; status: string | null }
export interface KickSummary { sessions?: Record<string, { status: string }[]> }

/** Décision pure : faut-il relancer une passe maintenant ? Une transition « au travail → au repos » d'une session
 *  qu'une remise attend (réponse reçue non remise, ou fil confié en échec). Un démarrage du serveur (statut précédent
 *  inconnu) compte aussi : une session déjà au repos avec une remise en attente n'a pas à attendre. Écart minimal entre
 *  deux relances : le veilleur a son propre verrou, mais inutile de le lancer en rafale. */
export class DeliveryKick {
  readonly minGapMs: number;
  #prev = new Map<string, string>();
  #last = -Infinity;
  /** Libération vue pendant l'écart minimal : la relance n'est pas perdue, elle part à la fin de l'écart. */
  #due = false;
  constructor(minGapMs = 15000) { this.minGapMs = minGapMs; }

  check(sessions: readonly KickSession[], summary: KickSummary | null, linked: () => ReadonlySet<string>, now: number): boolean {
    let pending: ReadonlySet<string> | null = null;   // fils confiés : lus seulement si une session se libère
    const seen = new Set<string>();
    for (const s of sessions) {
      const sid = s.sessionId, st = (s.status ?? '').toLowerCase();
      seen.add(sid);
      const before = this.#prev.get(sid);
      this.#prev.set(sid, st);
      if (!FREE.has(st) || (before !== undefined && FREE.has(before))) continue;
      const waiting = (summary?.sessions?.[sid] ?? []).some((w) => w.status === 'replied') || (pending ??= linked()).has(sid);
      if (waiting) this.#due = true;
    }
    for (const sid of [...this.#prev.keys()]) if (!seen.has(sid)) this.#prev.delete(sid);
    if (!this.#due || now - this.#last < this.minGapMs) return false;
    this.#due = false; this.#last = now;
    return true;
  }
}

/** Sessions dont un fil confié (_links.json) attend une remise : la dernière tentative a échoué. */
export function linkedPending(links: unknown): Set<string> {
  const out = new Set<string>();
  const chats = (links && typeof links === 'object' ? (links as { chats?: unknown }).chats : null);
  if (!chats || typeof chats !== 'object') return out;
  for (const l of Object.values(chats as Record<string, { sessionId?: unknown; lastError?: unknown }>)) {
    if (l && typeof l.sessionId === 'string' && typeof l.lastError === 'string' && l.lastError) out.add(l.sessionId);
  }
  return out;
}
