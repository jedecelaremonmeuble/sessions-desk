// Commandes « / » : ce que la page propose, et la garde d'un envoi. Dossiers temporaires, faux pilote : aucune
// console réelle, aucun réglage du poste lu.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Actions } from '../src/actions.ts';
import { commandOf, Commands, frontmatter, hasArgs, parseShortcuts, projectClaudeDirs, scanDir } from '../src/commands.ts';
import { parseUi } from '../src/modules.ts';
import type { Dashboard } from '../src/state.ts';

let root: string, claude: string, cwd: string;
const put = (file: string, text: string): void => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text, 'utf8'); };
const names = (c: Commands, dir = cwd): string[] => c.list(dir).map((x) => x.name);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sd-cmd-')); claude = join(root, 'home', '.claude'); cwd = join(root, 'repo', 'app');
  mkdirSync(claude, { recursive: true }); mkdirSync(cwd, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('commandOf', () => {
  test('premier mot « /nom » : une commande, en minuscules', () => {
    expect(commandOf('/mcp')).toBe('/mcp');
    expect(commandOf('  /MCP reconnect all')).toBe('/mcp');
    expect(commandOf('/hookify:list')).toBe('/hookify:list');
  });
  test('un chemin, une barre seule ou un texte ordinaire : un message comme avant', () => {
    expect(commandOf('/api/send est cassé')).toBeNull();
    expect(commandOf('/')).toBeNull();
    expect(commandOf('/ 2')).toBeNull();
    expect(commandOf('regarde /mcp')).toBeNull();
    expect(commandOf('/42')).toBeNull();
  });
  test('arguments', () => { expect(hasArgs('/mcp')).toBe(false); expect(hasArgs('/mcp ')).toBe(false); expect(hasArgs('/mcp reconnect all')).toBe(true); });
});

describe('lecture du disque', () => {
  test('en-tête : clés simples, guillemets retirés', () => {
    expect(frontmatter('---\nname: essai\ndescription: "Fait une chose"\nargument-hint: [sujet]\n---\ncorps')).toEqual({ name: 'essai', description: 'Fait une chose', 'argument-hint': '[sujet]' });
    expect(frontmatter('pas d\'en-tête')).toEqual({});
  });
  test('skills et commandes d\'un dossier, sous-dossier de commandes compris', () => {
    put(join(claude, 'skills', 'cadrage', 'SKILL.md'), '---\nname: cadrage\ndescription: Cadrer un sujet\nargument-hint: "[sujet]"\n---\n');
    put(join(claude, 'skills', 'interne', 'SKILL.md'), '---\nname: interne\nuser-invocable: false\n---\n');
    put(join(claude, 'commands', 'ship.md'), '---\ndescription: Livrer\n---\n');
    put(join(claude, 'commands', 'ops', 'purge.md'), 'sans en-tête');
    const got = scanDir(claude, 'user');
    expect(got.map((c) => c.name).sort()).toEqual(['/cadrage', '/purge', '/ship']);
    expect(got.find((c) => c.name === '/cadrage')).toMatchObject({ desc: 'Cadrer un sujet', args: '[sujet]', source: 'user', dialog: '', risky: false });
  });
  test('dossiers .claude du projet : celui de la session puis ses parents, jamais celui de l\'utilisateur', () => {
    mkdirSync(join(root, 'repo', '.claude')); mkdirSync(join(cwd, '.claude'));
    expect(projectClaudeDirs(cwd, claude, root)).toEqual([join(cwd, '.claude'), join(root, 'repo', '.claude')]);
    expect(projectClaudeDirs(join(root, 'home'), claude, root)).toEqual([]);
  });
});

describe('liste d\'une session', () => {
  test('intégrées + projet + utilisateur + plugins ACTIVÉS seulement, préfixés', () => {
    put(join(root, 'repo', '.claude', 'skills', 'recette', 'SKILL.md'), '---\nname: recette\n---\n');
    put(join(claude, 'commands', 'ship.md'), '');
    const on = join(root, 'plugins', 'outil'), off = join(root, 'plugins', 'autre');
    put(join(on, 'commands', 'list.md'), '---\ndescription: Lister\n---\n'); put(join(off, 'commands', 'nope.md'), '');
    put(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'outil@place': true, 'autre@place': false } }));
    put(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'outil@place': [{ installPath: on }], 'autre@place': [{ installPath: off }] } }));
    const n = names(new Commands(claude, root));
    expect(n).toEqual(expect.arrayContaining(['/mcp', '/model', '/recette', '/ship', '/outil:list']));
    expect(n).not.toContain('/autre:nope');
    expect(names(new Commands(claude, root), join(root, 'ailleurs'))).not.toContain('/recette');   // skill de projet : absent hors du projet
  });
  test('un nom déjà pris n\'est pas repris : l\'intégrée l\'emporte', () => {
    put(join(claude, 'commands', 'mcp.md'), '---\ndescription: la mienne\n---\n');
    const mcp = new Commands(claude, root).list(cwd).filter((c) => c.name === '/mcp');
    expect(mcp).toHaveLength(1); expect(mcp[0]!.source).toBe('builtin');
  });
  test('relue après le délai de cache', () => {
    const c = new Commands(claude, root); expect(names(c)).not.toContain('/neuf');
    put(join(claude, 'commands', 'neuf.md'), '');
    expect(names(c)).not.toContain('/neuf');
    c.ttlMs = 0; expect(names(c)).toContain('/neuf');
  });
  test('indicateurs des intégrées', () => {
    const by = (n: string) => new Commands(claude, root).list(cwd).find((c) => c.name === n)!;
    expect(by('/mcp')).toMatchObject({ dialog: 'bare', risky: false, forms: ['/mcp reconnect all'] });
    expect(by('/model')).toMatchObject({ dialog: 'bare', persist: true, immediate: true });
    expect(by('/clear')).toMatchObject({ risky: true, dialog: '' });
    expect(by('/permissions').dialog).toBe('always');
  });
});

describe('garde d\'un envoi', () => {
  const c = (): Commands => new Commands(claude, root);
  test('message ordinaire ou commande connue : rien à redire', () => {
    expect(c().check('bonjour', cwd, false, false)).toBeNull();
    expect(c().check('/api/send est cassé', cwd, false, false)).toBeNull();
    expect(c().check('/mcp reconnect all', cwd, false, false)).toBeNull();
    expect(c().check('/clear', cwd, false, false)).toBeNull();
  });
  test('commande inconnue : refusée et nommée, admise sur demande explicite', () => {
    expect(c().check('/mod', cwd, false, false)).toEqual({ error: 'commande inconnue : /mod', unknownCommand: '/mod' });
    expect(c().check('/mod', cwd, true, false)).toBeNull();
  });
  test('message groupé : ni commande à risque, ni menu', () => {
    expect(c().check('/mcp reconnect all', cwd, false, true)).toBeNull();
    expect(c().check('/compact', cwd, false, true)).toBeNull();
    expect(c().check('/clear', cwd, false, true)?.error).toMatch(/refusée en message groupé/);
    expect(c().check('/clear', cwd, true, true)?.error).toMatch(/refusée en message groupé/);
    expect(c().check('/mcp', cwd, false, true)?.error).toMatch(/ouvre un menu/);
    expect(c().check('/permissions', cwd, false, true)?.error).toMatch(/ouvre un menu/);
  });
});

describe('envoi depuis la page', () => {
  const PID = 4242; let calls: { op: string; args: Record<string, unknown> }[];
  const BAR = '─'.repeat(40);
  const actions = (): Actions => {
    const a = new Actions({
      cfg: { claude },
      sf: (name: string) => join(root, name),
      openSessions: async () => [{ pid: PID, sessionId: 'sess-1', title: 'essai', status: 'idle', cwd }],
      setSeen: () => undefined,
      driver: { call: async (op: string, args: Record<string, unknown>) => { calls.push({ op, args }); return op === 'read' ? [BAR, '❯ ', BAR].join('\n') : 0; } },
    } as unknown as Dashboard);
    a.settleMs = 0; a.commands.top = root; return a;
  };
  const typed = (): unknown[] => calls.filter((x) => x.op === 'send').map((x) => x.args.line);
  beforeEach(() => { calls = []; });

  test('commande connue : tapée telle quelle', async () => {
    expect(await actions().sendFromPage(PID, '/mcp reconnect all', false, false)).toEqual({ error: null });
    expect(typed()).toEqual(['/mcp reconnect all']);
  });
  test('faute de frappe : rien n\'est tapé, la commande est nommée', async () => {
    expect(await actions().sendFromPage(PID, '/mod', false, false)).toEqual({ error: 'commande inconnue : /mod', unknownCommand: '/mod' });
    expect(calls).toEqual([]);
  });
  test('« envoyer quand même » : tapée', async () => {
    expect(await actions().sendFromPage(PID, '/pas-dans-la-liste', false, true)).toEqual({ error: null });
    expect(typed()).toEqual(['/pas-dans-la-liste']);
  });
  test('message groupé : la commande à risque est sautée, session par session', async () => {
    const r = await actions().sendMany([PID], '/clear') as { results: { error: string | null }[] };
    expect(r.results[0]!.error).toMatch(/refusée en message groupé/); expect(calls).toEqual([]);
    const ok = await actions().sendMany([PID], '/compact') as { results: { error: string | null }[] };
    expect(ok.results[0]!.error).toBeNull(); expect(typed()).toEqual(['/compact']);
  });
});

describe('raccourcis (ui.shortcuts)', () => {
  test('absents : null, ceux par défaut ; liste vide : aucun bouton', () => {
    expect(parseShortcuts(undefined)).toBeNull(); expect(parseShortcuts([])).toEqual([]);
    expect(parseUi({ ui: {} }, { home: root, localAppData: root, temp: root }).shortcuts).toBeNull();
  });
  test('une entrée sans libellé ou qui n\'est pas une commande est ignorée ; 8 au plus', () => {
    expect(parseShortcuts([{ label: 'Reconnecter', command: '/mcp reconnect all' }, { label: '', command: '/compact' }, { label: 'Texte', command: 'bonjour' }, 'x']))
      .toEqual([{ label: 'Reconnecter', command: '/mcp reconnect all', confirm: '' }]);
    expect(parseShortcuts(Array.from({ length: 12 }, (_, i) => ({ label: 'B' + i, command: '/compact' })))).toHaveLength(8);
  });
});
