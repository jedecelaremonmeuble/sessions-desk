// Page : fonctions PURES des automates (automationGroups, automationCard), extraites de app.js et exécutées seules.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');   // poste en autocrlf : fins de ligne CRLF
function extract(name: string, sig: string): (...a: unknown[]) => any {
  const m = new RegExp(`\\nfunction ${name}\\(${sig}\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(js);
  if (!m) throw new Error(`${name} introuvable dans la page`);
  return new Function(`${m[0]}; return ${name};`)() as (...a: unknown[]) => any;
}
const automationGroups = extract('automationGroups', 'autos, open');
const automationCard = extract('automationCard', 'a, now');

const NOW = Date.UTC(2026, 10, 20, 14, 0); const M = 60000;
const pass = (o: Record<string, unknown>) => ({ run: 'r', at: NOW - 60 * M, status: 'ok', level: 'ok', summary: 's', minutes: 2, costUsd: null, sessionId: null, files: [], quiet: false, dryRun: false, hasDir: true, ...o });
const auto = (o: Record<string, unknown>) => ({ id: 'menage', label: 'Ménage', icon: '🧹', present: true, files: true, everyMinutes: 60, orders: [], running: null, passes: [], quietToday: 0, last: null, next: null,
  week: { count: 0, failures: 0, warnings: 0, costUsd: null, costAvg: null, lastFailure: null }, ...o });

describe('automationGroups', () => {
  test('un groupe par automate ; passe en cours en tête, absorbe sa session ; couleurs selon la santé de la passe', () => {
    const a = auto({
      running: { run: 'r3', sessionId: 'live', pid: 42, at: NOW - 5 * M },
      passes: [pass({ run: 'r3', summary: 'déjà écrite' }), pass({ run: 'r2', level: 'error', status: 'failed' }), pass({ run: 'r1', status: 'dry-run' }), pass({ run: 'r0', level: 'warn', status: 'conflict' }), pass({ run: 'rok' })],
    });
    const open = [{ sessionId: 'live', pid: 42, headless: true, model: 'claude-opus-5-5', tokens: 900 }, { sessionId: 'autre', pid: 7, headless: true }, { sessionId: 'manuelle', pid: 42, headless: false }];
    const g = automationGroups([a, auto({ id: 'vide', label: 'Vide', icon: '' })], open);
    expect(g.groups.map((x: any) => [x.key, x.title, x.states[0]])).toEqual([['automation:menage', '🧹 Ménage', 'auto:menage'], ['automation:vide', 'Vide', 'auto:vide']]);
    expect([...g.absorbed]).toEqual(['live']);
    expect(g.items.map((i: any) => [i.key, i.look])).toEqual([['pass:menage:r3', 'busy'], ['pass:menage:r2', 'waiting'], ['pass:menage:r1', 'idle'], ['pass:menage:r0', 'ask'], ['pass:menage:rok', 'done']]);
    expect(g.items[0]).toMatchObject({ running: true, sessionId: 'live', model: 'claude-opus-5-5', tokens: 900, pass: null });
  });
  test('sans module : rien', () => {
    expect(automationGroups(undefined, [])).toMatchObject({ groups: [], items: [] });
  });
});

describe('automationCard', () => {
  test('dernière passe, prochaine, 7 jours, dernier échec ; couleur de la dernière passe', () => {
    const c = automationCard(auto({
      last: pass({ at: NOW - 12 * M, summary: '🟠 dégradé · nouveau', dryRun: true, status: 'dry-run' }), next: NOW + 48 * M,
      week: { count: 80, failures: 9, warnings: 0, costUsd: 120.5, costAvg: 2.41, lastFailure: pass({ at: NOW - 3 * 60 * M, summary: 'récap impossible' }) },
    }), NOW);
    expect(c.look).toBe('done');
    expect(c.title).toBe('🧹 Ménage');
    expect(c.summary).toBe('🟠 dégradé · nouveau');
    expect(Object.fromEntries(c.lines)).toEqual({
      'dernière passe': 'il y a 12 min · à blanc', prochaine: 'dans 48 min',
      '7 jours': `80 passes · 9 échecs · ${(120.5).toLocaleString('fr-FR')} $ (${(2.41).toLocaleString('fr-FR')} $ par passe)`,
      'dernier échec': 'il y a 3 h 00 : récap impossible',
    });
  });
  test('en cours, en retard, en erreur, sans historique', () => {
    expect(automationCard(auto({ running: { at: NOW - 2 * M }, last: pass({ level: 'error' }) }), NOW).look).toBe('busy');
    const late = automationCard(auto({ last: pass({ at: NOW - 3 * 60 * M }), next: NOW + 30 * M, late: true }), NOW);
    expect(late.look).toBe('ask');
    expect(Object.fromEntries(late.lines)).toMatchObject({ 'en retard': 'aucune passe depuis 3 h 00 — la tâche planifiée tourne toutes les 60 min' });
    expect(Object.fromEntries(late.lines).prochaine).toBeUndefined();
    expect(automationCard(auto({ last: pass({ level: 'error', status: 'failed' }), late: true }), NOW).look).toBe('waiting');
    const none = automationCard(auto({ present: false }), NOW);
    expect(none).toMatchObject({ look: 'idle', summary: 'aucune passe sur 8 jours' });
    expect(none.lines[0][0]).toBe('historique');
  });
});
