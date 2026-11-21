// Page : menu des commandes « / » d'une zone de saisie — ce que la zone contient vu comme une commande (slashState)
// et les avertissements affichés avant l'envoi (slashNotes), extraits de app.js et exécutés seuls.
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
const slashState = extract('slashState', 'value, commands');
const slashNotes = extract('slashNotes', 'st, busy, many');

const cmd = (name: string, o: Record<string, unknown> = {}) => ({ name, desc: '', args: '', source: 'builtin', dialog: '', risky: false, persist: false, immediate: false, forms: [], ...o });
const LIST = [cmd('/mcp', { dialog: 'bare', forms: ['/mcp reconnect all'] }), cmd('/model', { dialog: 'bare', persist: true, immediate: true }), cmd('/memory', { dialog: 'always' }),
  cmd('/clear', { risky: true }), cmd('/compact'), cmd('/hookify:list', { source: 'plugin' })];
const names = (v: string): string[] => slashState(v, LIST).items.map((c: { name: string }) => c.name);

describe('slashState', () => {
  test('texte ordinaire, chemin ou plusieurs lignes : pas une commande', () => {
    for (const v of ['bonjour', '', 'regarde /mcp', '/api/send est cassé', '/mcp\nsuite', '/42']) expect(slashState(v, LIST)).toBeNull();
  });
  test('« / » seul : toutes les commandes', () => { expect(names('/')).toHaveLength(LIST.length); });
  test('nom en cours de frappe : celles qui commencent par lui, puis celles qui le contiennent', () => {
    expect(names('/m')).toEqual(['/mcp', '/model', '/memory', '/compact']);
    expect(names('/list')).toEqual(['/hookify:list']);
    expect(names('  /MO')).toEqual(['/model', '/memory']);      // « memory » contient « mo »
  });
  test('nom exact : reconnu, encore proposé tant que rien ne le suit', () => {
    const st = slashState('/mcp', LIST);
    expect(st.cmd.name).toBe('/mcp'); expect(st.typing).toBe(true); expect(st.args).toBe(false);
  });
  test('arguments : plus de menu, la commande reste reconnue', () => {
    const st = slashState('/mcp reconnect all', LIST);
    expect(st).toMatchObject({ token: '/mcp', typing: false, args: true, items: [] }); expect(st.cmd.name).toBe('/mcp');
    expect(slashState('/mcp ', LIST)).toMatchObject({ typing: false, args: false });
  });
  test('faute de frappe : aucune commande reconnue', () => { expect(slashState('/mod', LIST).cmd).toBeNull(); expect(slashState('/zzz', LIST).items).toEqual([]); });
});

describe('slashNotes', () => {
  const notes = (v: string, busy = false, many = false): string[] => slashNotes(slashState(v, LIST), busy, many);
  test('rien à dire d\'un texte ordinaire, d\'un « / » seul ou d\'une commande sans effet de bord', () => {
    expect(slashNotes(null, false, false)).toEqual([]); expect(notes('/')).toEqual([]); expect(notes('/compact')).toEqual([]);
  });
  test('menu dans le terminal : sans argument seulement pour /mcp, toujours pour /memory', () => {
    expect(notes('/mcp')).toEqual(['ouvre un menu dans le terminal : il se pilote ensuite ici, au pavé de touches']);
    expect(notes('/mcp reconnect all')).toEqual([]);
    expect(notes('/memory x')).toEqual(['ouvre un menu dans le terminal : il se pilote ensuite ici, au pavé de touches']);
  });
  test('ne se rattrape pas ; réglage durable seulement avec un argument', () => {
    expect(notes('/clear')).toEqual(['ne se rattrape pas']);
    expect(notes('/model opus')).toEqual(['change aussi le réglage par défaut des prochaines sessions']);
    expect(notes('/model')).toEqual(['ouvre un menu dans le terminal : il se pilote ensuite ici, au pavé de touches']);
  });
  test('session au travail : en file, sauf commande à effet immédiat', () => {
    expect(notes('/compact', true)).toEqual(['session au travail : exécutée à la fin du tour']);
    expect(notes('/model opus', true)).toEqual(['change aussi le réglage par défaut des prochaines sessions']);
  });
  test('message groupé : le refus est annoncé', () => {
    expect(notes('/clear', false, true)).toEqual(['ne se rattrape pas : refusée en message groupé']);
    expect(notes('/mcp', false, true)).toEqual(['ouvre un menu dans le terminal : refusée en message groupé']);
  });
  test('commande absente de la liste : annoncée dès qu\'aucune proposition ne reste', () => {
    expect(notes('/mo')).toEqual([]);                                   // encore des propositions
    expect(notes('/zzz')[0]).toMatch(/absente de la liste/);
    expect(notes('/mod x')[0]).toMatch(/absente de la liste/);
  });
});
