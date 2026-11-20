// Page : une constante supprimée mais encore lue fait lever le rendu à chaque passe (ReferenceError).
// Et une exception du rendu ne doit jamais se présenter comme une coupure du serveur.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
// Code seul : chaînes, gabarits, expressions régulières simples et commentaires retirés.
const code = js
  .replace(/\/\/[^\n]*/g, '')
  .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");

test('toute constante en MAJUSCULES lue par la page y est déclarée', () => {
  // `const A = …, B = …` : B est déclarée aussi (une affectation nue à une MAJUSCULE serait de toute façon fautive).
  // Lues sur le source brut : le retrait des chaînes peut avaler une déclaration (une regex contenant un `).
  const declared = new Set([...js.matchAll(/(?:\b(?:const|let|var|function)\s+|,\s*)([A-Z][A-Z0-9_]+)\b(?=\s*[=(])/g)].map(m => m[1]));
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) declared.add(n.split(':').pop()!.trim());
  const used = new Set([...code.matchAll(/(?<![.\w$])([A-Z][A-Z0-9_]{2,})\b(?!\s*:)/g)].map(m => m[1]));
  const builtins = new Set(['JSON', 'URL', 'NaN', 'DOMParser', 'CSS']);
  const missing = [...used].filter(n => !declared.has(n) && !builtins.has(n) && !(n in globalThis));
  expect(missing).toEqual([]);
});

test('NARROW est déclarée (lue par la vue conversation, le texte d’écran et le survol)', () => {
  expect(js).toMatch(/\nconst NARROW = matchMedia\(/);
});

test('une erreur de rendu ne passe pas pour « serveur injoignable »', () => {
  const m = /\nasync function tick\(\) \{[\s\S]*?\n\}\n/.exec(js);
  expect(m).not.toBeNull();
  const body = m![0];
  const render = body.slice(body.indexOf('data = srv'));
  expect(render).toContain('renderDetail');
  expect(render).not.toContain('linkDown');
});
