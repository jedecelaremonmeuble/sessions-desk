// Page : opérations de texte reprises du terminal de Claude Code — copie à la sélection (selectionToCopy) et
// édition de ligne dans les zones de saisie (lineEdit, lineKeyOp), extraites de app.js et exécutées seules.
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
const selectionToCopy = extract('selectionToCopy', 'text');
const lineEdit = extract('lineEdit', 'op, v, s, e, kill');
const lineKeyOp = extract('lineKeyOp', 'e');

describe('selectionToCopy', () => {
  test('retire les espaces de bourrage de l’écran du terminal en fin de ligne', () => {
    expect(selectionToCopy('● Fait.      \n  ligne 2   \r\nfin\t')).toBe('● Fait.\n  ligne 2\nfin');
  });
  test('garde l’indentation de tête, retire les lignes vides autour', () => {
    expect(selectionToCopy('\n\n    code()\n\n')).toBe('    code()');
  });
  test('une sélection faite de blancs ne copie rien', () => {
    expect(selectionToCopy('   \n \t ')).toBe('');
    expect(selectionToCopy(null)).toBe('');
  });
});

// Applique le résultat de lineEdit comme la page le fait : texte et curseur après coup.
function run(op: string, v: string, s: number, e = s, kill = '') {
  const r = lineEdit(op, v, s, e, kill);
  if (!r) return null;
  if (r.caret != null) return { v, caret: r.caret };
  return { v: v.slice(0, r.from) + r.insert + v.slice(r.to), caret: r.from + r.insert.length, kill: r.kill };
}

describe('lineEdit', () => {
  const V = 'premier mot\ndeuxième ligne ici\nfin';
  test('Ctrl+K coupe jusqu’à la fin de la ligne ; en fin de ligne, il coupe le saut de ligne', () => {
    expect(run('killEnd', V, 21)).toEqual({ v: 'premier mot\ndeuxième \nfin', caret: 21, kill: 'ligne ici' });
    expect(run('killEnd', V, 11)).toEqual({ v: 'premier motdeuxième ligne ici\nfin', caret: 11, kill: '\n' });
    expect(run('killEnd', V, V.length)).toBeNull();
  });
  test('Ctrl+U coupe jusqu’au début de la ligne ; en début de ligne, il coupe le saut de ligne précédent', () => {
    expect(run('killStart', V, 21)).toEqual({ v: 'premier mot\nligne ici\nfin', caret: 12, kill: 'deuxième ' });
    expect(run('killStart', V, 12)).toEqual({ v: 'premier motdeuxième ligne ici\nfin', caret: 11, kill: '\n' });
    expect(run('killStart', V, 0)).toBeNull();
  });
  test('avec une sélection, Ctrl+K / Ctrl+U coupent la sélection', () => {
    expect(run('killEnd', V, 0, 8)).toEqual({ v: 'mot\ndeuxième ligne ici\nfin', caret: 0, kill: 'premier ' });
  });
  test('Ctrl+Y recolle le dernier texte coupé, à la place de la sélection', () => {
    expect(run('yank', 'ab', 1, 1, 'XY')).toEqual({ v: 'aXYb', caret: 3, kill: undefined });
    expect(run('yank', 'abc', 0, 2, 'Z')).toMatchObject({ v: 'Zc', caret: 1 });
    expect(run('yank', 'ab', 1, 1, '')).toBeNull();
  });
  test('Ctrl+E va en fin de ligne', () => {
    expect(run('end', V, 14)).toEqual({ v: V, caret: 30 });
    expect(run('end', V, V.length - 1)).toEqual({ v: V, caret: V.length });
  });
  test('Alt+B / Alt+F reculent / avancent d’un mot, accents compris', () => {
    expect(run('wordBack', V, 21)?.caret).toBe(12);          // « deuxième| » -> |deuxième
    expect(run('wordBack', V, 12)?.caret).toBe(8);           // saute le saut de ligne : |mot
    expect(run('wordFwd', V, 12)?.caret).toBe(20);           // deuxième|
    expect(run('wordFwd', V, 20)?.caret).toBe(26);           // ligne|
    expect(run('wordBack', V, 0)?.caret).toBe(0);
    expect(run('wordFwd', V, V.length)?.caret).toBe(V.length);
  });
});

describe('lineKeyOp', () => {
  const k = (key: string, o: Record<string, boolean> = {}) => lineKeyOp({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
  test('raccourcis du terminal', () => {
    expect(k('k', { ctrlKey: true })).toBe('killEnd');
    expect(k('u', { ctrlKey: true })).toBe('killStart');
    expect(k('y', { ctrlKey: true })).toBe('yank');
    expect(k('e', { ctrlKey: true })).toBe('end');
    expect(k('_', { ctrlKey: true, shiftKey: true })).toBe('undo');
    expect(k('_', { ctrlKey: true })).toBe('undo');            // clavier AZERTY : _ sans Maj
    expect(k('b', { altKey: true })).toBe('wordBack');
    expect(k('f', { altKey: true })).toBe('wordFwd');
  });
  test('rien d’autre n’est intercepté : Ctrl+A, Ctrl+W, AltGr (Ctrl+Alt), Ctrl+Maj+K, frappe simple', () => {
    expect(k('a', { ctrlKey: true })).toBeNull();
    expect(k('w', { ctrlKey: true })).toBeNull();
    expect(k('k', { ctrlKey: true, altKey: true })).toBeNull();
    expect(k('K', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(k('k')).toBeNull();
  });
});
