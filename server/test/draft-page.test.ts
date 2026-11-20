// Page : brouillon de réponse gardé par session (draftSave / draftLoad, extraites de app.js et exécutées seules),
// et garde du rechargement à chaud (typing) qui ne bloque plus sur un brouillon seul.
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
const draftSave = extract('draftSave', 'store, key, text');
const draftLoad = extract('draftLoad', 'store, key');

/** Stockage façon sessionStorage. */
function store(full = false) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { if (full) throw new Error('QuotaExceededError'); m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('brouillon de réponse', () => {
  test('gardé par session : chacune retrouve le sien', () => {
    const s = store();
    draftSave(s, 'open:a', 'réponse pour A\nsur deux lignes');
    draftSave(s, 'open:b', 'pour B');
    expect(draftLoad(s, 'open:a')).toBe('réponse pour A\nsur deux lignes');
    expect(draftLoad(s, 'open:b')).toBe('pour B');
    expect(draftLoad(s, 'open:c')).toBe('');
  });
  test('vidé (envoi réussi, texte effacé, blancs seuls) : rien ne reste', () => {
    const s = store();
    draftSave(s, 'open:a', 'texte'); draftSave(s, 'open:a', '');
    expect(s.m.size).toBe(0);
    draftSave(s, 'open:a', '   \n ');
    expect(s.m.size).toBe(0);
  });
  test('le texte est gardé tel quel (espaces compris)', () => {
    const s = store();
    draftSave(s, 'k', '  indenté  ');
    expect(draftLoad(s, 'k')).toBe('  indenté  ');
  });
  test('stockage plein ou refusé : ni exception, ni brouillon', () => {
    const s = store(true);
    expect(() => draftSave(s, 'k', 'x')).not.toThrow();
    expect(draftLoad(s, 'k')).toBe('');
    expect(draftLoad({ getItem: () => { throw new Error('SecurityError'); } }, 'k')).toBe('');
  });
});

test('rechargement à chaud : un brouillon seul ne le bloque plus, une pièce jointe en attente si', () => {
  const m = /\nfunction typing\(\) \{[\s\S]*?\n\}\n/.exec(js);
  expect(m).not.toBeNull();
  expect(m![0]).not.toContain('sendtext');
  expect(m![0]).toContain('attachSets');
});
