// Page : navigation par l'adresse — routeUrl / routeParse (écran ↔ adresse) et navStep (que faire de l'historique),
// extraites de app.js et exécutées seules.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');   // poste en autocrlf : fins de ligne CRLF
function extract(name: string, sig: string): (...a: any[]) => any {
  const m = new RegExp(`\\nfunction ${name}\\(${sig}\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(js);
  if (!m) throw new Error(`${name} introuvable dans la page`);
  return new Function(`${m[0]}; return ${name};`)() as (...a: any[]) => any;
}
const routeUrl = extract('routeUrl', 'r');
const routeParse = extract('routeParse', 'search');
const navStep = extract('navStep', 'st, stack, url, replace');

describe('routeUrl / routeParse', () => {
  test('vue d’ensemble : adresse vide', () => {
    expect(routeUrl({ sel: '' })).toBe('');
    expect(routeParse('')).toEqual({});
  });
  test('une session, un run, une passe : ?sel=<clé>, aller-retour sans perte', () => {
    for (const sel of ['3f2a-uuid', 'run:2026-11-20_HD-1_dev', 'pass:sante:14-00']) {
      const url = routeUrl({ sel });
      expect(routeParse(url)).toEqual({ sel });
    }
  });
  test('un écran : ?view=, la session sélectionnée ne s’y ajoute pas', () => {
    expect(routeUrl({ view: 'board', q: '' })).toBe('?view=board');
    for (const view of ['board', 'launcher', 'chats', 'new', 'bc']) expect(routeParse(routeUrl({ view }))).toEqual({ view });
  });
  test('la recherche garde ses mots, accents et espaces compris', () => {
    const url = routeUrl({ view: 'find', q: 'déploiement à chaud' });
    expect(routeParse(url)).toEqual({ view: 'find', q: 'déploiement à chaud' });
  });
  test('une vue inconnue retombe sur la session, ou la vue d’ensemble', () => {
    expect(routeParse('?view=nimporte&sel=abc')).toEqual({ sel: 'abc' });
    expect(routeParse('?view=nimporte')).toEqual({});
  });
  test('les entrées des notifications (?run=, ?pass=) ne sont pas des écrans : traitées à part', () => {
    expect(routeParse('?run=123')).toEqual({});
  });
});

describe('navStep', () => {
  const st = (idx: number, url: string) => ({ sd: 1, idx, url });
  test('première entrée de la page (ou entrée d’avant le routeur) : on la remplace', () => {
    expect(navStep(null, [], '?sel=a', false)).toEqual({ op: 'replace', idx: 0 });
    expect(navStep({ pane: 'detail' }, [], '?sel=a', false)).toEqual({ op: 'replace', idx: 0 });
  });
  test('même écran : rien (renderDetail tourne toutes les 2 s)', () => {
    expect(navStep(st(2, '?sel=a'), ['', '?view=board', '?sel=a'], '?sel=a', false)).toEqual({ op: 'none', idx: 2 });
  });
  test('nouvel écran : on empile', () => {
    expect(navStep(st(0, ''), [''], '?sel=a', false)).toEqual({ op: 'push', idx: 1 });
  });
  test('retour à l’écran juste d’avant (Échap, Fermer, ← Sessions) : on recule, pas de doublon', () => {
    expect(navStep(st(1, '?view=board'), ['', '?view=board'], '', false)).toEqual({ op: 'back', idx: 0 });
  });
  test('l’écran d’avant-avant n’est pas un recul : on empile', () => {
    expect(navStep(st(2, '?sel=b'), ['', '?sel=a', '?sel=b'], '', false)).toEqual({ op: 'push', idx: 3 });
  });
  test('recherche affinée : on remplace l’entrée, une frappe n’en fait pas une', () => {
    expect(navStep(st(1, '?view=find&q=dep'), ['', '?view=find&q=dep'], '?view=find&q=depl', false)).toEqual({ op: 'replace', idx: 1 });
  });
  test('correction demandée (session disparue, module coupé) : on remplace', () => {
    expect(navStep(st(1, '?sel=a'), ['', '?sel=a'], '', true)).toEqual({ op: 'replace', idx: 1 });
  });
});
