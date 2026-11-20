// Page : suggestionMode (bandeau « mode dégradé » des propositions de prompt), extraite de app.js et exécutée seule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');   // poste en autocrlf : fins de ligne CRLF
const m = /\nfunction suggestionMode\(quota, setting, now\) \{[\s\S]*?\n\}\n/.exec(js);
if (!m) throw new Error('suggestionMode introuvable dans la page');
const suggestionMode = new Function(`${m[0]}; return suggestionMode;`)() as (q: unknown, s: unknown, now: number) => any;

const NOW = Date.UTC(2026, 10, 20, 14, 0); const DAY = 86400000;
const account = (o: Record<string, unknown>) => ({ status: 'ok', active: false, weeklyResetsAt: NOW + DAY, limits: [], ...o });
const limit = (pct: number, severity = 'normal') => ({ kind: 'weekly', pct, active: true, severity, resetsAt: NOW + DAY });

describe('suggestionMode', () => {
  test('un AUTRE compte épuisé ne déclenche rien : seul le compte connecté compte', () => {
    const q = [account({ active: true, limits: [limit(13)] }), account({ limits: [limit(100, 'exceeded')] })];
    expect(suggestionMode(q, null, NOW)).toBeNull();
  });
  test('compte connecté épuisé : bandeau', () => {
    const q = [account({ active: true, limits: [limit(100, 'exceeded')] }), account({ limits: [limit(10)] })];
    expect(suggestionMode(q, null, NOW)).toMatchObject({ level: 'waiting', back: NOW + DAY });
  });
  test('compte connecté en alerte, non forcé : bandeau', () => {
    const q = [account({ active: true, limits: [limit(92, 'warning')] })];
    expect(suggestionMode(q, null, NOW)?.text).toContain('ne propose plus');
  });
  test('compte connecté inconnu : on retombe sur tous les comptes', () => {
    const q = [account({ limits: [limit(13)] }), account({ limits: [limit(100, 'exceeded')] })];
    expect(suggestionMode(q, null, NOW)).toMatchObject({ level: 'waiting' });
  });
});
