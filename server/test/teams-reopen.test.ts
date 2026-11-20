// Réveil d'une session FERMÉE quand la réponse qu'elle attend arrive : réouverture, puis remise du texte à une passe
// suivante. Le serveur est simulé (liste des sessions, envoi, réouverture) ; aucun appel réseau, aucune vraie session.
import { describe, expect, test } from 'vitest';
import { makeDeliver, type DeliverIo, type OpenSession, type Wait } from '../src/teams-watcher.ts';

const T0 = 1795080000000, MIN = 60_000;
const SID = '11111111-2222-3333-4444-555555555555';
const wait = (extra: Partial<Wait> = {}): Wait => ({
  v: 1, sessionId: SID, chatId: '19:abc@thread.v2', messageId: '1795080000000', sentAt: T0, excerpt: 'Une question ?', cwd: 'C:\\x', status: 'replied', ...extra,
});

/** Serveur simulé : `open` = sessions listées par /api/state ; les appels sont journalisés. */
function server(open: OpenSession[] | null, reopenAnswer: string | null = null) {
  const calls = { reopen: [] as string[], send: [] as { pid: string | number; text: string }[] };
  const io: DeliverIo = {
    sessions: async () => (open === null ? null : open.map((s) => ({ ...s }))),
    send: async (pid, text) => { calls.send.push({ pid, text }); return null; },
    reopen: async (sid) => { calls.reopen.push(sid); return reopenAnswer; },
  };
  return { io, calls };
}
const pass = (io: DeliverIo, all: Wait[], now: number) => { const res = { reopened: 0 }; return { deliver: makeDeliver(io, all, now, res), res }; };

describe('réveil d\'une session fermée', () => {
  test('session fermée : la réponse la rouvre, rien n\'est envoyé tant qu\'elle n\'a pas démarré', async () => {
    const { io, calls } = server([]);
    const { deliver, res } = pass(io, [wait()], T0);
    const d = await deliver(wait(), 'réponse de Camille');
    expect(d.ok).toBe(false);
    expect(calls.reopen).toEqual([SID]);
    expect(calls.send).toEqual([]);
    expect(res.reopened).toBe(1);
    expect(d.w).toMatchObject({ reopenedAt: T0, reopens: 1, lastError: 'réouverture en cours' });
  });

  test('passe suivante, session rouverte et prête : la réponse est injectée et les compteurs remis à zéro', async () => {
    const before = wait({ reopenedAt: T0, reopens: 1, lastError: 'réouverture en cours' });
    const { io, calls } = server([{ sessionId: SID, pid: 4242, status: 'idle' }]);
    const { deliver } = pass(io, [before], T0 + 2 * MIN);
    const d = await deliver(before, 'réponse de Camille');
    expect(d.ok).toBe(true);
    expect(calls.reopen).toEqual([]);
    expect(calls.send).toEqual([{ pid: 4242, text: 'réponse de Camille' }]);
    expect(d.w).toMatchObject({ reopens: 0, reopenedAt: undefined, lastError: null });
  });

  test('rouverte mais encore au démarrage : on attend, sans rouvrir une seconde fois', async () => {
    const before = wait({ reopenedAt: T0, reopens: 1 });
    const { io, calls } = server([{ sessionId: SID, pid: 4242, status: 'busy' }]);
    const d = await pass(io, [before], T0 + 2 * MIN).deliver(before, 'x');
    expect(d.ok).toBe(false);
    expect(calls.reopen).toEqual([]);
    expect(d.w.lastError).toBe('session busy');
  });

  test('pas encore listée moins de 15 min après la réouverture : on ne rouvre pas', async () => {
    const before = wait({ reopenedAt: T0, reopens: 1 });
    const { io, calls } = server([]);
    const d = await pass(io, [before], T0 + 14 * MIN).deliver(before, 'x');
    expect(calls.reopen).toEqual([]);
    expect(d.w).toMatchObject({ reopens: 1, lastError: 'réouverture en cours' });
  });

  test('deux réponses pour la même session fermée dans une passe : UN seul onglet rouvert', async () => {
    const a = wait(), b = wait({ chatId: '19:def@thread.v2', messageId: '1795080000001' });
    const { io, calls } = server([]);
    const { deliver, res } = pass(io, [a, b], T0);
    const da = await deliver(a, 'réponse A');
    const db = await deliver(b, 'réponse B');
    expect(calls.reopen).toEqual([SID]);
    expect(res.reopened).toBe(1);
    expect(da.w.reopens).toBe(1);
    expect(db.w).toMatchObject({ lastError: 'réouverture en cours' });
    expect(db.w.reopens ?? 0).toBe(0);
  });

  test('la fenêtre vaut pour la session : une autre attente rouverte à la passe précédente suffit', async () => {
    const a = wait({ reopenedAt: T0, reopens: 1 }), b = wait({ chatId: '19:def@thread.v2', messageId: '1795080000001' });
    const { io, calls } = server([]);
    const d = await pass(io, [a, b], T0 + 2 * MIN).deliver(b, 'réponse B');
    expect(calls.reopen).toEqual([]);
    expect(d.w.lastError).toBe('réouverture en cours');
  });

  test('deux réouvertures sans démarrage : on s\'arrête et on le dit', async () => {
    const before = wait({ reopenedAt: T0, reopens: 2, lastError: 'réouverture en cours' });
    const { io, calls } = server([]);
    const d = await pass(io, [before], T0 + 16 * MIN).deliver(before, 'x');
    expect(calls.reopen).toEqual([]);
    expect(d.w.lastError).toBe('session fermée (rouverte deux fois sans démarrer)');
  });

  test('réouverture refusée par le serveur : la cause reste affichée, même au plafond', async () => {
    const { io } = server([], 'dossier de lancement introuvable');
    const first = await pass(io, [wait()], T0).deliver(wait(), 'x');
    expect(first.w).toMatchObject({ reopens: 1, lastError: 'réouverture impossible : dossier de lancement introuvable' });
    const second = await pass(io, [first.w], T0 + 16 * MIN).deliver(first.w, 'x');
    expect(second.w.reopens).toBe(2);
    const capped = await pass(io, [second.w], T0 + 32 * MIN).deliver(second.w, 'x');
    expect(capped.w.lastError).toBe('réouverture impossible : dossier de lancement introuvable');
  });

  test('session réapparue entre la liste et la réouverture : pas compté comme une tentative', async () => {
    const { io } = server([], 'session déjà ouverte');
    const { deliver, res } = pass(io, [wait()], T0);
    const d = await deliver(wait(), 'x');
    expect(res.reopened).toBe(0);
    expect(d.w).toMatchObject({ reopenedAt: T0, lastError: 'réouverture en cours' });
    expect(d.w.reopens ?? 0).toBe(0);
  });

  test('serveur injoignable : rien n\'est rouvert sur une liste vide qui ne veut rien dire', async () => {
    const { io, calls } = server(null);
    const d = await pass(io, [wait()], T0).deliver(wait(), 'x');
    expect(calls.reopen).toEqual([]);
    expect(d.w.lastError).toBe('serveur 8765 injoignable');
  });

  test('automate (claude -p) : jamais rouvert ni alimenté', async () => {
    const { io, calls } = server([{ sessionId: SID, pid: 7, status: 'idle', headless: true }]);
    const d = await pass(io, [wait()], T0).deliver(wait(), 'x');
    expect(calls).toEqual({ reopen: [], send: [] });
    expect(d.ok).toBe(false);
  });
});
