// Invite occupée : un message tapé mais jamais parti ne doit plus bloquer une session sans le dire.
// Faux pilote, dossier temporaire : aucune console réelle.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Actions, submitLine } from '../src/actions.ts';
import { draftHolds, promptDraft } from '../src/prompt.ts';
import type { Dashboard } from '../src/state.ts';

const BAR = '─'.repeat(40);
const screen = (...box: string[]): string => ['● réponse de la session', '', BAR, ...box, BAR, '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
const STUCK = screen('❯ mets à jour avec mon profil :', '  https://example.com/profil/', '');

describe('promptDraft', () => {
  test('invite vide', () => { expect(promptDraft(screen('❯ '), null)).toBe(''); });
  test('proposition de prompt : ce n\'est pas un texte resté', () => { expect(promptDraft(screen('❯ ouvre la PR'), 'ouvre la PR')).toBe(''); });
  test('texte resté, replié sur plusieurs lignes', () => { expect(promptDraft(STUCK, null)).toBe('mets à jour avec mon profil :\nhttps://example.com/profil/'); });
  test('aucune invite à l\'écran (dialogue)', () => {
    expect(promptDraft([BAR, ' Question ?', '❯ 1. Oui', '  2. Non', '', 'Enter to select · Esc to cancel'].join('\n'), null)).toBeNull();
    expect(promptDraft(null, null)).toBeNull();
  });
  test('un cadre plus haut dans l\'écran ne compte pas : la DERNIÈRE invite fait foi', () => {
    expect(promptDraft([BAR, '❯ ancien', BAR, 'suite', BAR, '❯ ', BAR].join('\n'), null)).toBe('');
  });
});

describe('draftHolds', () => {
  test('le texte tapé est encore là, même replié au milieu d\'un mot', () => {
    expect(draftHolds('mets à jour avec mon profil :\nhttps://example.com/pro\nfil/', 'mets à jour avec mon profil : https://example.com/profil/')).toBe(true);
  });
  test('invite vide ou autre texte : parti', () => {
    expect(draftHolds('', 'bonjour')).toBe(false);
    expect(draftHolds('autre chose', 'bonjour')).toBe(false);
  });
});

describe('submitLine', () => {
  test('barre oblique inverse finale retirée (elle changerait Entrée en retour à la ligne)', () => {
    expect(submitLine('voir https://example.com/profil/\\')).toBe('voir https://example.com/profil/');
    expect(submitLine('a \\ \\\n')).toBe('a');
    expect(submitLine('C:\\dossier\\fichier')).toBe('C:\\dossier\\fichier');
    expect(submitLine('\\')).toBe('');
  });
});

const PID = 4242;
type Call = { op: string; args: Record<string, unknown> };
let dir: string, calls: Call[], onScreen: string, status: string;
const actions = (): Actions => {
  const a = new Actions({
    sf: (name: string) => join(dir, name),
    openSessions: async () => [{ pid: PID, sessionId: 'sess-1', title: 'essai', status }],
    setSeen: () => undefined,
    driver: { call: async (op: string, args: Record<string, unknown>) => { calls.push({ op, args }); return op === 'read' ? onScreen : 0; } },
  } as unknown as Dashboard);
  a.settleMs = 0;
  return a;
};
const typed = (): Call[] => calls.filter((c) => c.op !== 'read');

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sd-prompt-')); calls = []; onScreen = screen('❯ '); status = 'idle'; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('envoi vérifié', () => {
  test('la barre oblique inverse finale n\'est pas tapée', async () => {
    expect(await actions().send(PID, 'voir https://example.com/profil/\\')).toBeNull();
    expect(typed()).toEqual([{ op: 'send', args: { pid: PID, line: 'voir https://example.com/profil/' } }]);
  });
  test('texte resté dans l\'invite après Entrée : l\'envoi n\'est pas annoncé réussi', async () => {
    onScreen = STUCK;
    expect(await actions().send(PID, 'mets à jour avec mon profil : https://example.com/profil/')).toMatch(/pas parti/);
  });
  test('invite vidée après Entrée : envoyé', async () => {
    expect(await actions().send(PID, 'bonjour')).toBeNull();
  });
});

describe('touches sur une session inactive', () => {
  test('texte attendu encore à l\'écran : accepté (envoyer ou vider l\'invite occupée)', async () => {
    onScreen = STUCK;
    expect(await actions().keys(PID, [{ k: 'Esc' }, { k: 'Esc' }], 'mets à jour avec mon profil :')).toBeNull();
    expect(typed()).toEqual([{ op: 'sendKeys', args: { pid: PID, items: ['\u0001Esc', '\u0001Esc'] } }]);
  });
  test('sans texte attendu : refusé, aucune touche à l\'aveugle', async () => {
    expect(await actions().keys(PID, [{ k: 'Enter' }], '')).toBe("la session n'attend plus de réponse (statut idle)");
    expect(calls).toEqual([]);
  });
  test('texte attendu disparu : refusé', async () => {
    expect(await actions().keys(PID, [{ k: 'Enter' }], 'mets à jour')).toMatch(/n'est plus à l'écran/);
    expect(typed()).toEqual([]);
  });
  test('session au travail : toujours refusé', async () => {
    status = 'busy'; onScreen = STUCK;
    expect(await actions().keys(PID, [{ k: 'Esc' }], 'mets à jour')).toBe("la session n'attend plus de réponse (statut busy)");
    expect(calls).toEqual([]);
  });
});
