// Proposition de prompt COUPÉE à l'écran (« … ») : le serveur n'en connaît pas la fin, il ne peut donc pas la taper.
// « Lancer » l'accepte dans le terminal (Tab, puis Entrée) — après avoir revérifié qu'elle est encore à l'écran.
// Faux pilote, dossier temporaire : aucune console réelle.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Actions } from '../src/actions.ts';
import type { Dashboard } from '../src/state.ts';

const PID = 4242;
type Call = { op: string; args: Record<string, unknown> };
let dir: string, calls: Call[], onScreen: string | null, status: string;
const actions = (): Actions => new Actions({
  sf: (name: string) => join(dir, name),
  openSessions: async () => [{ pid: PID, sessionId: 'sess-1', title: 'essai', status }],
  setSeen: () => undefined,
  driver: { call: async (op: string, args: Record<string, unknown>) => { calls.push({ op, args }); return op === 'suggestion' ? onScreen : 0; } },
} as unknown as Dashboard);
const sent = (): Call[] => calls.filter((c) => c.op !== 'suggestion');
const log = (): Record<string, unknown> => JSON.parse(readFileSync(join(dir, 'sessions-dashboard-sent.jsonl'), 'utf8').trim().split('\n').at(-1)!) as Record<string, unknown>;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sd-cut-')); calls = []; onScreen = null; status = 'idle'; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('proposition coupée à l\'écran', () => {
  test('encore à l\'écran : acceptée dans le terminal (Tab, Entrée), jamais tapée', async () => {
    onScreen = 'prépare un message pour demander la sour…';
    expect(await actions().send(PID, onScreen, true, true)).toBeNull();
    expect(sent()).toEqual([{ op: 'sendKeys', args: { pid: PID, items: ['\u0001Tab', '\u0001Enter'] } }]);
    expect(log()).toMatchObject({ pid: PID, code: 0, text: onScreen, suggested: true, cut: true });
  });
  test('plus à l\'écran, ou changée : refusée, aucune touche', async () => {
    expect(await actions().send(PID, 'ouvre la PR et…', true)).toBe("plus de proposition à l'écran");
    onScreen = 'ouvre la PR et lance…';
    expect(await actions().send(PID, 'ouvre la PR et…', true)).toBe("la proposition a changé à l'écran");
    expect(sent()).toEqual([]);
  });
  test('session au travail : refusée, aucune touche', async () => {
    status = 'busy'; onScreen = 'ouvre la PR et…';
    expect(await actions().send(PID, onScreen, true, true)).toBe("la session n'est pas inactive (statut busy)");
    expect(calls).toEqual([]);
  });
  test('proposition entière : tapée comme avant', async () => {
    onScreen = 'ouvre la PR et lance la CI';
    expect(await actions().send(PID, onScreen, true)).toBeNull();
    expect(sent()).toEqual([{ op: 'send', args: { pid: PID, line: onScreen } }]);
    expect(log()).not.toHaveProperty('cut');
  });
  test('un message ordinaire qui finit par « … » reste un message tapé', async () => {
    expect(await actions().send(PID, 'à suivre…')).toBeNull();
    expect(sent()).toEqual([{ op: 'send', args: { pid: PID, line: 'à suivre…' } }]);
  });
});
