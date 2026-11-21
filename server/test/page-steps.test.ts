// Étapes d'un run dans son détail : le journal `steps.json` d'une étape scriptée de l'orchestrateur (la livraison —
// pas de session, donc pas de conversation) et les `steps` de la recette. Fonctions PURES d'app.js, extraites du
// fichier servi — la page n'est pas un module.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const js = readFileSync(fileURLToPath(new URL('../../page/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
function grab(name: string): string {
  const m = js.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n'));
  if (!m) throw new Error(name + ' introuvable dans la page');
  return m[0];
}
const icons = js.match(/\nconst STEP_ICON = .*\n/);
if (!icons) throw new Error('STEP_ICON introuvable dans la page');
type Row = { status: string; icon: string; title: string; detail: string | null; time: string | null };
type Res = { look: string; title: string; lines: string[]; rows: Row[]; live?: boolean; pr: number | null };
type Fns = { stepRows: (steps: unknown, now: number) => Row[]; stepsResult: (j: unknown, now: number) => Res | null;
  runResult: (report: unknown, verdict: unknown, steps: unknown, now: number) => Res | null;
  runAuxWant: (c: unknown, names: string[], now: number) => string[] };
const fns = new Function("const T = (fr, en) => fr; const ago = ms => Math.round(ms / 60000) + ' min';" + icons[0]
  + ['stepRows', 'stepsResult', 'runResult', 'runAuxWant'].map(grab).join('\n')
  + '\nreturn { stepRows, stepsResult, runResult, runAuxWant };')() as Fns;

const t0 = Date.parse('2030-01-01T10:00:00Z'), iso = (min: number) => new Date(t0 + min * 60000).toISOString();
const delivering = { kind: 'delivery', updatedAt: iso(6), outcome: null, steps: [
  { key: 'pr', title: 'État de la PR', status: 'ok', startedAt: iso(0), endedAt: iso(0), detail: 'tête abcdef1234' },
  { key: 'rebase', title: 'Rebase', status: 'ok', startedAt: iso(0), endedAt: iso(2) },
  { key: 'check-backend', title: 'Contrôles backend', status: 'running', startedAt: iso(2) },
  { key: 'merge', title: 'Squash-merge', status: 'pending' }] };

describe('étapes d’un run', () => {
  test('stepRows : statut, durée d’une étape finie, « depuis » pour celle en cours', () => {
    const rows = fns.stepRows(delivering.steps, t0 + 9 * 60000);
    expect(rows.map((r) => r.status)).toEqual(['ok', 'ok', 'running', 'pending']);
    expect(rows.map((r) => r.time)).toEqual([null, '2 min', 'depuis 7 min', null]);
    expect(rows[0]!.detail).toBe('tête abcdef1234');
    expect(fns.stepRows(null, t0)).toEqual([]);
    expect(fns.stepRows([null, 'x', {}], t0)).toEqual([]);
  });
  test('stepRows : une étape de recette conforme ne répète pas son constat, une étape en échec le dit', () => {
    const rows = fns.stepRows([{ title: 'Ouvrir la liste', status: 'ok', observed: 'La liste s’ouvre' },
      { title: 'Enregistrer', status: 'ko', observed: 'Erreur 500' }, { title: 'Recharger', status: 'bloque', observed: 'Non atteint' }], t0);
    expect(rows.map((r) => [r.status, r.detail])).toEqual([['ok', null], ['ko', 'Erreur 500'], ['warn', 'Non atteint']]);
  });
  test('stepsResult : en cours, le titre nomme l’étape du moment et le journal reste à relire', () => {
    const r = fns.stepsResult(delivering, t0 + 9 * 60000)!;
    expect(r.look).toBe('busy');
    expect(r.title).toBe('🚚 Livraison en cours · 2/4 étapes — Contrôles backend');
    expect(r.live).toBe(true);
  });
  test('stepsResult : refusée, mergée, en production', () => {
    const refused = { ...delivering, outcome: 'refused', steps: [delivering.steps[0], { key: 'rebase', title: 'Rebase', status: 'ko', detail: 'conflit' }, { key: 'merge', title: 'Squash-merge', status: 'skipped' }] };
    const r = fns.stepsResult(refused, t0)!;
    expect([r.look, r.title, r.live]).toEqual(['waiting', '❌ Livraison non faite · 1/3 étapes — Rebase', false]);
    const merged = { ...delivering, outcome: 'merged', steps: [{ key: 'merge', title: 'Squash-merge', status: 'ok' }, { key: 'pipeline', title: 'Pipeline', status: 'running', startedAt: iso(5) }] };
    expect(fns.stepsResult(merged, t0 + 6 * 60000)).toMatchObject({ look: 'busy', title: '🚚 Mergée — déploiement en cours · 1/2 étapes — Pipeline', live: true });
    const red = { ...merged, steps: [merged.steps[0], { key: 'pipeline', title: 'Pipeline', status: 'ko' }, { key: 'production', title: 'Image', status: 'pending' }] };
    expect(fns.stepsResult(red, t0 + 6 * 60000)).toMatchObject({ look: 'waiting', live: true });
    const live = { ...merged, outcome: 'in-production', steps: [{ key: 'merge', title: 'Squash-merge', status: 'ok' }, { key: 'production', title: 'Image', status: 'ok' }] };
    expect(fns.stepsResult(live, t0)).toMatchObject({ look: 'done', title: '🚀 Livrée, en production · 2/2 étapes', live: false });
  });
  test('stepsResult : un journal muet depuis trois jours n’est plus relu, un journal vide ou illisible ne donne rien', () => {
    expect(fns.stepsResult(delivering, t0 + 73 * 3600000)!.live).toBe(false);
    expect(fns.stepsResult({ steps: [] }, t0)).toBeNull();
    expect(fns.stepsResult({ steps: 'x' }, t0)).toBeNull();
    expect(fns.stepsResult(null, t0)).toBeNull();
  });
  test('runResult : le rapport de production et le verdict de recette priment, le journal sert sinon', () => {
    expect(fns.runResult({ verdict: 'in-production', pr: 12 }, null, delivering, t0)!.title).toBe('🚀 En production');
    const recette = fns.runResult(null, { verdict: 'ok', summary: 'Conforme', steps: [{ title: 'A', status: 'ok' }] }, null, t0)!;
    expect([recette.title, recette.lines, recette.rows.length]).toEqual(['✅ Recette OK · 1 étape', ['Conforme'], 1]);
    expect(fns.runResult(null, null, delivering, t0)!.title).toMatch(/^🚚 Livraison en cours/);
    expect(fns.runResult(null, null, null, t0)).toBeNull();
  });
  test('runAuxWant : tout une fois, puis le seul journal — toutes les 5 s, tant qu’il vit', () => {
    const names = ['diff.patch', 'steps.json', 'verdict.json'];
    expect(fns.runAuxWant(undefined, names, t0)).toEqual(['verdict.json', 'steps.json']);
    expect(fns.runAuxWant(undefined, ['diff.patch'], t0)).toEqual([]);
    const now = t0 + 9 * 60000, read = { at: now - 6000, busy: false, steps: delivering };
    expect(fns.runAuxWant(read, names, now)).toEqual(['steps.json']);
    expect(fns.runAuxWant({ ...read, at: now - 2000 }, names, now)).toEqual([]);          // lu il y a 2 s
    expect(fns.runAuxWant({ ...read, busy: true }, names, now)).toEqual([]);              // lecture en cours
    expect(fns.runAuxWant({ ...read, steps: { ...delivering, outcome: 'refused' } }, names, now)).toEqual([]);   // terminé : plus rien à relire
    expect(fns.runAuxWant({ at: now - 6000, busy: false }, ['verdict.json'], now)).toEqual([]);                   // recette : pas de journal
    expect(fns.runAuxWant({ at: now - 6000, busy: false }, names, now)).toEqual(['steps.json']);                  // journal apparu après la 1re lecture
  });
});
