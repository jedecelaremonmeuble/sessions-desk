// Vue par conversation (teams-watcher.ts, lot 9) : tous les chats actifs, « à toi de répondre », « à voir », pointage « Vu ».
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  conversationCounts, conversationRows, conversationsView, convFromPreview, defaultConversations, markConversationSeen, mentionsOwner, runConversations, saveWait, setOwner, writeSummary,
  type ConvChat, type ConvState, type InboundState, type Wait,
} from '../src/teams-watcher.ts';

const ME = 'me-id', OTHER = 'other-id';
const T0 = Date.UTC(2026, 10, 20, 10, 0), MIN = 60_000, DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const preview = (o: Record<string, unknown> = {}) => ({ id: '1001', createdDateTime: iso(T0), messageType: 'message', body: { contentType: 'html', content: '<p>Tu peux regarder la facture ?</p>' }, from: { user: { id: OTHER, displayName: 'Camille MARTIN' } }, ...o });
const chat = (o: Partial<ConvChat> = {}): ConvChat => ({ label: 'Camille MARTIN', type: 'oneOnOne', webUrl: 'https://teams.example.com/c1', lastId: '1001', lastAt: T0, lastFrom: 'Camille MARTIN', who: 'other', excerpt: 'Tu peux regarder la facture ?', ack: false, mention: false, ...o });
const state = (chats: Record<string, ConvChat>, since = T0 - DAY): ConvState => ({ v: 1, since, at: T0 + MIN, chats });
const wait = (o: Partial<Wait> = {}): Wait => ({ v: 1, sessionId: 'sess-1', chatId: 'c1', messageId: '900', sentAt: T0 - 30 * MIN, excerpt: 'question', cwd: null, status: 'open', ...o });
const NOW = T0 + 5 * MIN;

describe('dernier message d’un chat', () => {
  beforeEach(() => setOwner('Alex Durand'));
  test('message d’un collègue : extrait, auteur ; politesse reconnue', () => {
    expect(convFromPreview(preview(), ME)).toMatchObject({ lastId: '1001', lastAt: T0, lastFrom: 'Camille MARTIN', who: 'other', excerpt: 'Tu peux regarder la facture ?', ack: false, mention: false });
    expect(convFromPreview(preview({ body: { contentType: 'html', content: '<p>Merci beaucoup !</p>' } }), ME)).toMatchObject({ ack: true });
  });
  test('le sien, une application, une image, un message supprimé', () => {
    expect(convFromPreview(preview({ from: { user: { id: ME, displayName: 'Alex Durand' } } }), ME)).toMatchObject({ who: 'me', ack: false });
    expect(convFromPreview(preview({ from: { application: { displayName: 'Robot' } } }), ME)).toMatchObject({ who: 'app', lastFrom: 'Robot' });
    expect(convFromPreview(preview({ body: { contentType: 'html', content: '<img src="x">' } }), ME)).toMatchObject({ excerpt: '(image)' });
    expect(convFromPreview(preview({ isDeleted: true }), ME)).toMatchObject({ excerpt: '(message supprimé)' });
  });
  test('rien à répondre : remerciement sans question, message supprimé ; « merci de … » et une question restent des demandes', () => {
    const ack = (content: string) => convFromPreview(preview({ body: { contentType: 'html', content } }), ME)!.ack;
    expect(ack('Hello Alex, merci beaucoup pour les accès tout fonctionne parfaitement !')).toBe(true);
    expect(ack('Ha yes dans la config, je suis allé vérifier, merci !')).toBe(true);
    expect(ack('Merci de me rappeler avant midi')).toBe(false);
    expect(ack('Merci ! Tu as des nouvelles sur les macros ?')).toBe(false);
    expect(convFromPreview(preview({ isDeleted: true }), ME)).toMatchObject({ ack: true });
    expect(convFromPreview(preview({ body: { contentType: 'html', content: '<img src="x">' } }), ME)).toMatchObject({ ack: false });
  });
  test('expéditeur mis en sourdine (compte de service qui notifie) : traité comme une application', () => {
    expect(convFromPreview(preview({ from: { user: { id: 'svc', displayName: 'Robot Tickets' } } }), ME, ['robot tickets'])).toMatchObject({ who: 'app', ack: false });
    expect(convFromPreview(preview({ from: { user: { id: ME, displayName: 'Robot Tickets' } } }), ME, ['robot tickets'])).toMatchObject({ who: 'me' });
  });
  test('un événement système ou un aperçu vide ne remplace pas le dernier vrai message', () => {
    expect(convFromPreview(preview({ messageType: 'systemEventMessage' }), ME)).toBeNull();
    expect(convFromPreview(null, ME)).toBeNull();
    expect(convFromPreview({ id: '1' }, ME)).toBeNull();
  });
  test('mention de l’utilisateur : la balise <at> porte son prénom', () => {
    expect(mentionsOwner('<p><at id="0">Alex Durand</at> tu valides ?</p>')).toBe(true);
    expect(mentionsOwner('<p><at id="0">Camille MARTIN</at> tu valides ?</p>')).toBe(false);
    expect(mentionsOwner('<p>Alex tu valides ?</p>')).toBe(false);
    expect(convFromPreview(preview({ body: { contentType: 'html', content: '<at id="0">Alex</at> ton avis ?' } }), ME)).toMatchObject({ mention: true });
  });
});

describe('lignes de la vue', () => {
  test('1:1, dernier mot au collègue, aucune session : à toi de répondre, et à voir', () => {
    const [r] = conversationRows(state({ c1: chat() }), undefined, [], undefined, NOW);
    expect(r).toMatchObject({ chatId: 'c1', by: 'other', ball: 'reply', unseen: true, sessions: [] });
  });
  test('politesse : rien à répondre, mais à voir ; groupe : à répondre seulement si mentionné', () => {
    expect(conversationRows(state({ c1: chat({ ack: true }) }), undefined, [], undefined, NOW)[0]).toMatchObject({ ball: null, unseen: true });
    expect(conversationRows(state({ c1: chat({ type: 'group' }) }), undefined, [], undefined, NOW)[0]).toMatchObject({ ball: null, unseen: true });
    expect(conversationRows(state({ c1: chat({ type: 'group', mention: true }) }), undefined, [], undefined, NOW)[0]).toMatchObject({ ball: 'reply' });
  });
  test('avant la première passe : réputé vu, mais « à toi de répondre » reste calculé', () => {
    const [r] = conversationRows(state({ c1: chat() }, T0 + MIN), undefined, [], undefined, NOW);
    expect(r).toMatchObject({ unseen: false, ball: 'reply' });
  });
  test('pointage : « Vu » éteint à voir ET à répondre ; un message plus récent les rallume', () => {
    expect(conversationRows(state({ c1: chat() }), { v: 1, chats: { c1: T0 } }, [], undefined, NOW)[0]).toMatchObject({ unseen: false, ball: null });
    expect(conversationRows(state({ c1: chat({ lastAt: T0 + MIN }) }), { v: 1, chats: { c1: T0 } }, [], undefined, NOW)[0]).toMatchObject({ unseen: true, ball: 'reply' });
  });
  test('son propre message : à jour ; celui d’une session en son nom : à voir, session liée', () => {
    expect(conversationRows(state({ c1: chat({ who: 'me', lastId: '555' }) }), undefined, [], undefined, NOW)[0]).toMatchObject({ by: 'me', unseen: false, ball: null });
    const w = wait({ messageId: '1001', sentAt: T0 });
    expect(conversationRows(state({ c1: chat({ who: 'me' }) }), undefined, [w], undefined, NOW)[0])
      .toMatchObject({ by: 'session', unseen: true, ball: 'waiting', sessions: [{ sessionId: 'sess-1', role: 'wait', at: T0 }] });
  });
  test('le collègue a répondu à une session : la session a reçu ce message', () => {
    const w = wait({ status: 'injected', replies: [{ id: '1001', at: T0, from: 'Camille MARTIN', text: 'oui', files: [] }] });
    expect(conversationRows(state({ c1: chat() }), undefined, [w], undefined, NOW)[0]).toMatchObject({ ball: 'session', unseen: true, sessions: [{ sessionId: 'sess-1', role: 'past' }] });
  });
  test('demande entrante confiée à une session : jusqu’au dernier message remis seulement', () => {
    const inb = (upTo: number): InboundState => ({ v: 1, since: 0, opened: [], chats: { c1: { handledAt: upTo, sessionId: 'sess-in', openedAt: T0 + 2 * MIN, sessionUpTo: upTo } } });
    expect(conversationRows(state({ c1: chat() }), undefined, [], inb(T0), NOW)[0]).toMatchObject({ ball: 'session', sessions: [{ sessionId: 'sess-in', role: 'inbound' }] });
    expect(conversationRows(state({ c1: chat({ lastAt: T0 + 3 * MIN }) }), undefined, [], inb(T0), NOW)[0]).toMatchObject({ ball: 'reply' });
  });
  test('une application : listée, jamais à voir ; les attentes d’email ne lient rien', () => {
    expect(conversationRows(state({ c1: chat({ who: 'app' }) }), undefined, [wait()], undefined, NOW)[0]).toMatchObject({ by: 'app', unseen: false, ball: null });
    expect(conversationRows(state({ c1: chat() }), undefined, [wait({ channel: 'mail' })], undefined, NOW)[0]!.sessions).toEqual([]);
  });
  test('ordre : à répondre, puis à voir, puis à jour — le plus récent d’abord ; hors fenêtre écarté ; compteurs', () => {
    const rows = conversationRows(state({
      ok: chat({ who: 'me', lastAt: T0 + 2 * MIN }), vu: chat({ ack: true, lastAt: T0 - MIN }), rep: chat({ lastAt: T0 - 2 * MIN }), vu2: chat({ type: 'group', lastAt: T0 }),
      vieux: chat({ lastAt: T0 - 20 * DAY }),
    }), undefined, [], undefined, NOW);
    expect(rows.map((r) => r.chatId)).toEqual(['rep', 'vu2', 'vu', 'ok']);
    expect(conversationCounts(rows, 7)).toEqual({ reply: 1, unseen: 2, total: 4, at: 7 });
  });
});

describe('passe et fichiers', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-')); setOwner('Alex Durand'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = { conversations: { ...defaultConversations, enabled: true } };
  const readState = () => JSON.parse(readFileSync(join(dir, '_conversations.json'), 'utf8')) as ConvState;
  function graphOf(pages: Record<string, unknown>, calls: string[] = []) {
    return async <T>(path: string): Promise<T> => {
      calls.push(path);
      const hit = Object.entries(pages).find(([k]) => path.startsWith(k));
      if (!hit) throw new Error(`Graph 404 sur ${path}`);
      return hit[1] as T;
    };
  }
  const LIST = '/me/chats?$expand=lastMessagePreview';

  test('liste les chats de la fenêtre, lit le nom une seule fois, s’arrête au premier trop ancien', async () => {
    const calls: string[] = [];
    const graph = graphOf({
      [LIST]: { value: [
        { id: 'c1', chatType: 'oneOnOne', webUrl: 'https://teams.example.com/c1', lastMessagePreview: preview() },
        { id: 'g1', chatType: 'group', topic: 'Projet facture', lastMessagePreview: preview({ id: '1000', createdDateTime: iso(T0 - MIN) }) },
        { id: 'c9', chatType: 'oneOnOne', lastMessagePreview: preview({ id: '998', createdDateTime: iso(T0 - 2 * MIN), from: { user: { id: ME, displayName: 'Alex Durand' } } }) },
        { id: 'h1', chatType: 'group', topic: 'Masqué', viewpoint: { isHidden: true }, lastMessagePreview: preview({ id: '999' }) },
        { id: 'old', chatType: 'oneOnOne', lastMessagePreview: preview({ id: '1', createdDateTime: iso(T0 - 30 * DAY) }) },
        { id: 'jamais', chatType: 'oneOnOne', lastMessagePreview: preview({ id: '2' }) },
      ] },
      '/chats/c9?$expand=members': { members: [{ userId: ME, displayName: 'Alex Durand' }, { userId: OTHER, displayName: 'Camille MARTIN' }] },
    }, calls);
    expect(await runConversations(dir, cfg, ME, graph, { dryRun: false, now: NOW })).toEqual({ listed: 3, errors: [] });
    const st = readState();
    expect(st.since).toBe(NOW);
    expect(Object.keys(st.chats)).toEqual(['c1', 'g1', 'c9']);
    // 1:1 : le nom vient du dernier message de l'autre ; si le dernier mot est le sien, des membres — lus une seule fois.
    expect(st.chats.c9).toMatchObject({ label: 'Camille MARTIN', who: 'me' });
    expect(calls.filter((c) => c.startsWith('/chats/'))).toEqual(['/chats/c9?$expand=members']);
    expect(st.chats.c1).toMatchObject({ label: 'Camille MARTIN', type: 'oneOnOne', webUrl: 'https://teams.example.com/c1', who: 'other', lastId: '1001' });
    expect(st.chats.g1).toMatchObject({ label: 'Projet facture', type: 'group' });
    // Deuxième passe : le nom est déjà connu, le départ ne bouge pas.
    calls.length = 0;
    await runConversations(dir, cfg, ME, graph, { dryRun: false, now: NOW + 2 * MIN });
    expect(calls.filter((c) => c.startsWith('/chats/'))).toEqual([]);
    expect(readState()).toMatchObject({ since: NOW, at: NOW + 2 * MIN });
  });
  test('page suivante suivie ; événement système : le dernier vrai message est gardé', async () => {
    const graph = graphOf({
      [LIST]: { value: [{ id: 'c1', chatType: 'oneOnOne', topic: 'A', lastMessagePreview: preview() }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=x' },
      '/me/chats?$skiptoken=x': { value: [{ id: 'c2', chatType: 'meeting', topic: 'Point hebdo', lastMessagePreview: preview({ id: '1002' }) }] },
    });
    expect((await runConversations(dir, cfg, ME, graph, { dryRun: false, now: NOW })).listed).toBe(2);
    expect(readState().chats.c2).toMatchObject({ type: 'meeting' });
    const sys = graphOf({ [LIST]: { value: [{ id: 'c1', chatType: 'oneOnOne', topic: 'A', lastMessagePreview: preview({ id: '2000', createdDateTime: iso(T0 + MIN), messageType: 'systemEventMessage' }) }] } });
    await runConversations(dir, cfg, ME, sys, { dryRun: false, now: NOW + 2 * MIN });
    expect(readState().chats.c1).toMatchObject({ lastId: '1001', lastAt: T0 });
  });
  test('Graph en échec ou passe à blanc : l’état d’avant est gardé', async () => {
    const ok = graphOf({ [LIST]: { value: [{ id: 'c1', chatType: 'oneOnOne', topic: 'A', lastMessagePreview: preview() }] } });
    await runConversations(dir, cfg, ME, ok, { dryRun: false, now: NOW });
    const res = await runConversations(dir, cfg, ME, graphOf({}), { dryRun: false, now: NOW + 2 * MIN });
    expect(res.errors).toHaveLength(1);
    expect(readState().at).toBe(NOW);
    await runConversations(dir, cfg, ME, ok, { dryRun: true, now: NOW + 4 * MIN });
    expect(readState().at).toBe(NOW);
  });

  test('vue, résumé et pointage : « Vu » porte l’heure du message affiché, « * » pointe tout, « unseen » remet à voir', () => {
    expect(conversationsView(dir, NOW)).toBeNull();
    expect(markConversationSeen(dir, 'c1', 'seen', T0, NOW)).toBe('vue par conversation éteinte');
    writeFileSync(join(dir, '_conversations.json'), JSON.stringify(state({ c1: chat(), c2: chat({ type: 'group', lastAt: T0 + MIN }), c3: chat({ lastAt: T0 + 2 * MIN }) })));
    saveWait(dir, wait({ chatId: 'c2' }));
    writeSummary(dir, NOW);
    const summary = () => JSON.parse(readFileSync(join(dir, '_summary.json'), 'utf8')) as { conversations?: unknown };
    expect(summary().conversations).toEqual({ reply: 2, unseen: 1, total: 3, at: T0 + MIN });
    expect(conversationsView(dir, NOW)!.rows.map((r) => [r.chatId, r.ball, r.unseen])).toEqual([['c3', 'reply', true], ['c1', 'reply', true], ['c2', null, true]]);

    expect(markConversationSeen(dir, 'inconnu', 'seen', T0, NOW)).toBe('conversation introuvable');
    expect(markConversationSeen(dir, 'c1', 'efface', T0, NOW)).toBe('action inconnue');
    expect(markConversationSeen(dir, 'c1', 'seen', T0, NOW)).toBeNull();
    expect(summary().conversations).toMatchObject({ reply: 1, unseen: 1 });
    // c3 affiché à T0 alors que son dernier message est plus récent : il reste à voir.
    expect(markConversationSeen(dir, 'c3', 'seen', T0, NOW)).toBeNull();
    expect(conversationsView(dir, NOW)!.rows.find((r) => r.chatId === 'c3')).toMatchObject({ ball: 'reply', unseen: true });
    expect(markConversationSeen(dir, '*', 'seen', NOW, NOW)).toBeNull();
    expect(summary().conversations).toMatchObject({ reply: 0, unseen: 0, total: 3 });
    expect(markConversationSeen(dir, 'c1', 'unseen', 0, NOW)).toBeNull();
    expect(conversationsView(dir, NOW)!.rows[0]).toMatchObject({ chatId: 'c1', ball: 'reply', unseen: true });
  });
});
