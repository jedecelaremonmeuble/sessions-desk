// Messages en file (src/queued.ts) : ce qui attend encore d'être pris par Claude Code.
import { describe, expect, test } from 'vitest';
import { pendingQueue } from '../src/queued.ts';

let clock = Date.parse('2026-11-20T10:00:00.000Z');
const op = (operation: string, content?: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'queue-operation', operation, timestamp: new Date((clock += 1000)).toISOString(), sessionId: 's1', ...(content == null ? {} : { content }), ...extra });
const user = (text: string): string => JSON.stringify({ parentUuid: 'p', type: 'user', message: { role: 'user', content: text } });

describe('pendingQueue', () => {
  test('un message mis en file et pas encore pris est en attente', () => {
    const q = pendingQueue([user('go'), op('enqueue', 'prépare la synthèse')]);
    expect(q.map((x) => x.text)).toEqual(['prépare la synthèse']);
    expect(q[0]!.at).toMatch(/^2026-11-20T/);
  });
  test('pris au tour suivant (dequeue = tête de file) : plus en attente', () => {
    expect(pendingQueue([op('enqueue', 'a'), op('enqueue', 'b'), op('dequeue')]).map((x) => x.text)).toEqual(['b']);
  });
  test('absorbé en cours de tour ou rappelé dans l’invite (remove nommé) : plus en attente', () => {
    expect(pendingQueue([op('enqueue', 'a'), op('enqueue', 'b'), op('remove', 'a', { reason: 'absorbed_mid_turn' })]).map((x) => x.text)).toEqual(['b']);
  });
  test('les notifications que Claude Code met en file comptent pour l’ordre mais ne s’affichent pas', () => {
    const n = '<task-notification>\n<task-id>b1</task-id>';
    expect(pendingQueue([op('enqueue', n), op('enqueue', 'mon message')]).map((x) => x.text)).toEqual(['mon message']);
    expect(pendingQueue([op('enqueue', n), op('enqueue', 'mon message'), op('dequeue')]).map((x) => x.text)).toEqual(['mon message']);
  });
  test('fenêtre coupée : un dequeue sans enqueue lu, une ligne illisible ou un remove inconnu ne cassent rien', () => {
    expect(pendingQueue([op('dequeue'), '{"type":"queue-operation", cassé', op('remove', 'inconnu'), op('enqueue', 'x')]).map((x) => x.text)).toEqual(['x']);
  });
  test('rien en file', () => {
    expect(pendingQueue([user('go')])).toEqual([]);
  });
});
