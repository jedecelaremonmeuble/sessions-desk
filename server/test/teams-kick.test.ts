// Remise dès que la session se libère (src/teams-kick.ts) : la passe du veilleur est relancée sans attendre les 2 min.
import { describe, expect, test } from 'vitest';
import { DeliveryKick, linkedPending, type KickSummary } from '../src/teams-kick.ts';

const none = (): Set<string> => new Set();
const replied: KickSummary = { sessions: { s1: [{ status: 'replied' }] } };
const open: KickSummary = { sessions: { s1: [{ status: 'open' }] } };

describe('DeliveryKick', () => {
  test('session au travail puis au repos, réponse reçue non remise : relance', () => {
    const k = new DeliveryKick(15000);
    expect(k.check([{ sessionId: 's1', status: 'busy' }], replied, none, 1000)).toBe(false);
    expect(k.check([{ sessionId: 's1', status: 'idle' }], replied, none, 2000)).toBe(true);
  });
  test('« shell » (commande en arrière-plan) compte comme au repos', () => {
    const k = new DeliveryKick(15000);
    k.check([{ sessionId: 's1', status: 'busy' }], replied, none, 1000);
    expect(k.check([{ sessionId: 's1', status: 'shell' }], replied, none, 2000)).toBe(true);
  });
  test('restée au repos : une seule relance, pas une par seconde', () => {
    const k = new DeliveryKick(15000);
    k.check([{ sessionId: 's1', status: 'busy' }], replied, none, 1000);
    expect(k.check([{ sessionId: 's1', status: 'idle' }], replied, none, 2000)).toBe(true);
    expect(k.check([{ sessionId: 's1', status: 'idle' }], replied, none, 60000)).toBe(false);
  });
  test('rien n’attend la session (attente encore ouverte) : pas de relance', () => {
    const k = new DeliveryKick(15000);
    k.check([{ sessionId: 's1', status: 'busy' }], open, none, 1000);
    expect(k.check([{ sessionId: 's1', status: 'idle' }], open, none, 2000)).toBe(false);
  });
  test('fil confié en échec : relance ; fichier des fils lu seulement à la libération', () => {
    const k = new DeliveryKick(15000);
    let reads = 0;
    const linked = (): Set<string> => { reads++; return new Set(['s1']); };
    k.check([{ sessionId: 's1', status: 'busy' }], null, linked, 1000);
    expect(reads).toBe(0);
    expect(k.check([{ sessionId: 's1', status: 'idle' }], null, linked, 2000)).toBe(true);
    expect(reads).toBe(1);
  });
  test('démarrage du serveur, session déjà au repos avec une réponse en attente : relance', () => {
    expect(new DeliveryKick(15000).check([{ sessionId: 's1', status: 'idle' }], replied, none, 1000)).toBe(true);
  });
  test('libération pendant l’écart minimal : relance différée, pas perdue', () => {
    const k = new DeliveryKick(15000);
    const two: KickSummary = { sessions: { s1: [{ status: 'replied' }], s2: [{ status: 'replied' }] } };
    k.check([{ sessionId: 's1', status: 'busy' }, { sessionId: 's2', status: 'busy' }], two, none, 0);
    expect(k.check([{ sessionId: 's1', status: 'idle' }, { sessionId: 's2', status: 'busy' }], two, none, 1000)).toBe(true);
    expect(k.check([{ sessionId: 's1', status: 'idle' }, { sessionId: 's2', status: 'idle' }], two, none, 5000)).toBe(false);
    expect(k.check([{ sessionId: 's1', status: 'idle' }, { sessionId: 's2', status: 'idle' }], two, none, 16000)).toBe(true);
    expect(k.check([{ sessionId: 's1', status: 'idle' }, { sessionId: 's2', status: 'idle' }], two, none, 40000)).toBe(false);
  });
});

describe('linkedPending', () => {
  test('seuls les fils dont la dernière remise a échoué', () => {
    const links = { v: 1, chats: { a: { sessionId: 's1', lastError: 'session busy' }, b: { sessionId: 's2', lastError: null }, c: { sessionId: 's3' } } };
    expect([...linkedPending(links)]).toEqual(['s1']);
  });
  test('fichier absent ou illisible : aucun', () => {
    expect(linkedPending(null).size).toBe(0);
    expect(linkedPending({ chats: 'x' }).size).toBe(0);
  });
});
