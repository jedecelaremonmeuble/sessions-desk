// Page : copie à la sélection — selectionToCopy, extraite de app.js et exécutée seule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const m = /\nfunction selectionToCopy\(text\) \{[\s\S]*?\n\}\n/.exec(js);
if (!m) throw new Error('selectionToCopy introuvable dans la page');
const selectionToCopy = new Function(`${m[0]}; return selectionToCopy;`)() as (t: unknown) => string;

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
