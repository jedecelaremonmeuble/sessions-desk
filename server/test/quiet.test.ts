// Tours sans nouveauté (src/quiet.ts) : ce qui ne doit PAS ramener une session dans « À traiter ».
import { describe, expect, test } from 'vitest';
import { isRelance, lastNewsAt } from '../src/quiet.ts';

let clock = Date.parse('2026-11-20T10:00:00.000Z');
const ts = (): string => new Date((clock += 1000)).toISOString();
const line = (o: Record<string, unknown>): string => JSON.stringify({ parentUuid: 'p', isSidechain: false, ...o, timestamp: ts() });
const you = (text: string): string => line({ type: 'user', promptSource: 'typed', turnOrigin: 'human', message: { role: 'user', content: text } });
const wake = (text = 'SURVEILLANCE du chat'): string => line({ type: 'user', isMeta: true, promptSource: 'system', wakeupSource: 'schedule_wakeup', scheduledTaskId: 't1', turnOrigin: 'scheduled', message: { role: 'user', content: text } });
const task = (): string => line({ type: 'user', promptSource: 'system', turnOrigin: 'task_notification', message: { role: 'user', content: '<task-notification> <task-id>b1</task-id>' } });
const tool = (): string => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] } });
const result = (): string => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const says = (text: string): string => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const at = (l: string): number => Date.parse(JSON.parse(l).timestamp);
const RELANCE = '🔔 Relance Teams 1/2 — pas de réponse de « Alice » depuis 19/11 16:20, à ton message « … » (chatId 19:x).';

describe('le dernier tour compte', () => {
  test('ton message, une tâche de fond, la réponse d\'un collègue', () => {
    expect(lastNewsAt([you('go'), tool(), result(), says('Fait.')])).toBeNull();
    expect(lastNewsAt([you('go'), says('Lancé.'), task(), says('Le déploiement est fini.')])).toBeNull();
    expect(lastNewsAt([you('go'), says('Envoyé.'), you('💬 Réponse Teams de Alice (chat « Alice ») : « oui »'), says('Alice valide.')])).toBeNull();
  });
  test('un réveil programmé qui dit AUTRE CHOSE qu\'au tour d\'avant', () => {
    expect(lastNewsAt([you('surveille'), says('Je surveille.'), wake(), tool(), result(), says('Rien de nouveau.')])).toBeNull();
    expect(lastNewsAt([wake(), says('Rien de nouveau.'), wake(), says('Bob a répondu : il valide.')])).toBeNull();
  });
  test('transcript vide, illisible, ou réveil seul dans la fenêtre lue', () => {
    expect(lastNewsAt([])).toBeNull();
    expect(lastNewsAt(['{ pas du json', '{"type":"ai-title","aiTitle":"x"}'])).toBeNull();
    expect(lastNewsAt([wake(), says('Rien de nouveau.')])).toBeNull();
  });
});

describe('tours sans nouveauté', () => {
  test('réveils à réponse identique : la fin du PREMIER « rien de nouveau » fait foi', () => {
    const first = says('Rien de nouveau dans le chat.');
    const l = [you('surveille'), says('Je surveille.'), wake(), tool(), result(), first, wake(), tool(), result(), says('Rien de nouveau  dans le chat.'), wake(), says('Rien de nouveau dans le chat.')];
    expect(lastNewsAt(l)).toEqual({ at: at(first), why: 'réveil' });
  });
  test('relance du veilleur : la fin du tour d\'avant fait foi, même enveloppée en texte collé', () => {
    const before = says('Message envoyé à Alice.');
    expect(lastNewsAt([you('envoie'), before, you(RELANCE), tool(), result(), says('Relance envoyée.')])).toEqual({ at: at(before), why: 'relance' });
    expect(lastNewsAt([you('envoie'), before, you('<pasted_content id="6db1"> ' + RELANCE + ' </pasted_content>'), says('Relance envoyée.')])).toEqual({ at: at(before), why: 'relance' });
  });
  test('rien qui compte dans la fenêtre lue : 0', () => {
    expect(lastNewsAt([you(RELANCE), says('Relance envoyée.')])).toEqual({ at: 0, why: 'relance' });
  });
  test('les sous-agents ne comptent pas', () => {
    const before = says('Envoyé.');
    const side = JSON.stringify({ parentUuid: 'p', isSidechain: true, type: 'user', timestamp: ts(), message: { content: 'cherche' } });
    expect(lastNewsAt([you('envoie'), before, you(RELANCE), side, says('Relance envoyée.')])).toEqual({ at: at(before), why: 'relance' });
  });
});

test('isRelance', () => {
  expect(isRelance(RELANCE)).toBe(true); expect(isRelance('  🔔 Relance email 2/2 — …')).toBe(true);
  expect(isRelance('💬 Réponse Teams de Alice')).toBe(false); expect(isRelance('parle-moi de 🔔 Relance Teams')).toBe(false);
});
