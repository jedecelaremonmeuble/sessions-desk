// Page : une question à choix AVEC APERÇU (un cadre dessiné à droite des options). Le cadre partage les lignes des
// options : il ne doit ni finir dans leur libellé, ni dans le texte que le serveur recherche à l'écran avant de taper.
// parseDialog est extraite de app.js et exécutée seule, sur un écran relevé dans Claude Code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');   // poste en autocrlf : fins de ligne CRLF
const m = /\nconst SEP = [^\n]*\nfunction parseDialog\(text\) \{[\s\S]*?\n\}\n/.exec(js);
if (!m) throw new Error('parseDialog introuvable dans la page');
type Opt = { num: number; label: string; sel: boolean; expect: string; desc: string[] };
const parseDialog = new Function(`${m[0]}; return parseDialog;`)() as (text: string) => { opts: Opt[]; q: string; preview: boolean; multi: boolean; foot: string } | null;

const BAR = '─'.repeat(112), W = 52;
const box = (s: string): string => '│ ' + s.padEnd(W - 2) + ' │';
const PREVIEW = ['  Ran 1 shell command', '', BAR, ' ☐ Brouillons', '', '│ Où veux-tu retrouver les brouillons ?', '',
  '❯ 1. Section en tête de liste     ┌' + '─'.repeat(W) + '┐',
  '    (Recommandé)                  ' + box('❖ Brouillons (2)'),
  '  2. Dans le formulaire « + »     ' + box('  • /cadrage HD-111111 … · backend · il y a 2 h'),
  '                                  ' + box('  • regarde pourquoi … · frontend · hier'),
  '                                  ' + box('─────────────'),
  '                                  ' + box('● Actives'),
  '                                  └' + '─'.repeat(W) + '┘', '',
  '                                  Notes: press n to add notes', '', BAR, '  Chat about this', '',
  'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel'].join('\n');
const PLAIN = ['  Ran 1 shell command', '', BAR, ' ☐ Couleur', '', 'Quelle couleur ?', '', '❯ 1. Rouge', '     La plus vive', '  2. Bleu', '  3. Type something.', '', BAR, '  Chat about this', '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');

describe('parseDialog — question avec aperçu', () => {
  test('les libellés s\'arrêtent au cadre, la suite de libellé reste une description', () => {
    const d = parseDialog(PREVIEW)!;
    expect(d.opts.map((o) => o.label)).toEqual(['Section en tête de liste', 'Dans le formulaire « + »']);
    expect(d.opts[0]!.desc).toEqual(['(Recommandé)']); expect(d.opts[1]!.desc).toEqual([]);
    expect(d.opts[0]!.sel).toBe(true); expect(d.q).toContain('Où veux-tu retrouver les brouillons ?');
  });
  test('signalée comme telle : la page la pilote aux flèches, pas aux chiffres', () => {
    expect(parseDialog(PREVIEW)!.preview).toBe(true);
  });
  test('le texte recherché à l\'écran avant la frappe y figure tel quel', () => {
    for (const o of parseDialog(PREVIEW)!.opts) { expect(PREVIEW).toContain(o.expect); expect(o.expect).not.toMatch(/[┌│]/); }
  });
  test('question ordinaire : inchangée, pilotée par son chiffre', () => {
    const d = parseDialog(PLAIN)!;
    expect(d.preview).toBe(false); expect(d.opts.map((o) => o.label)).toEqual(['Rouge', 'Bleu', 'Type something.']); expect(d.opts[0]!.desc).toEqual(['La plus vive']);
  });
});
