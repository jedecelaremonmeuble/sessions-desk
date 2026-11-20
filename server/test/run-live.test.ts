// Ce que fait un run en cours, lu dans son transcript stream-json (server/src/run-live.ts), et la ligne que la page en
// tire (runLiveLine, fonction PURE d'app.js extraite du fichier servi — la page n'est pas un module).
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { LiveState, runLive, toolLabel } from '../src/run-live.ts';

const sid = '11111111-2222-3333-4444-555555555555';
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString();
const use = (id: string, name: string, input: object, s: number, parent: string | null = null) =>
  JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, session_id: sid, timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id: string, s: number) =>
  JSON.stringify({ type: 'user', parent_tool_use_id: null, session_id: sid, timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const say = (text: string, s: number) =>
  JSON.stringify({ type: 'assistant', parent_tool_use_id: null, session_id: sid, timestamp: at(s), message: { content: [{ type: 'text', text }] } });
const started = (id: string, description: string) => JSON.stringify({ type: 'system', subtype: 'task_started', tool_use_id: id, description, session_id: sid });

const dir = mkdtempSync(join(tmpdir(), 'sd-runlive-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('LiveState', () => {
  test('outil en cours = appel sans résultat ; la description de task_started remplace la commande', () => {
    const s = new LiveState();
    for (const l of [say('Je lance les tests.', 1), use('a', 'Read', { file_path: 'C:\\x\\src\\main.ts' }, 2), res('a', 3),
      use('b', 'Bash', { command: 'npm test -- --run' }, 4), started('b', 'Run the unit tests')]) s.feed(l);
    const v = s.snapshot();
    expect(v.now).toMatchObject({ id: 'b', name: 'Bash', label: 'Run the unit tests', since: Date.parse(at(4)), inner: null });
    expect(v.text).toBe('Je lance les tests.');
    expect(v.tools).toBe(2);
    s.feed(res('b', 9));
    expect(s.snapshot().now).toBeNull();
    expect(s.snapshot().lastAt).toBe(Date.parse(at(9)));
  });
  test('sous-agent : l’outil principal porte celui de l’agent ; les outils de l’agent ne comptent pas', () => {
    const s = new LiveState();
    for (const l of [use('ag', 'Agent', { description: 'Cherche les appels' }, 1), use('g', 'Grep', { pattern: 'runLive' }, 2, 'ag')]) s.feed(l);
    const v = s.snapshot();
    expect(v.now).toMatchObject({ name: 'Agent', label: 'Cherche les appels', inner: { name: 'Grep', label: 'runLive' } });
    expect(v.tools).toBe(1);
  });
  test('liste de tâches : faites / total et celle en cours', () => {
    const s = new LiveState();
    s.feed(use('t', 'TodoWrite', { todos: [{ content: 'A', status: 'completed' }, { content: 'B', activeForm: 'Écrit B', status: 'in_progress' }, { content: 'C', status: 'pending' }] }, 1));
    expect(s.snapshot().todos).toEqual({ done: 1, total: 3, current: 'Écrit B' });
  });
  test('lignes cassées, vides ou inconnues ignorées', () => {
    const s = new LiveState();
    for (const l of ['', '{pas du json', '[]', JSON.stringify({ type: 'rate_limit_event' })]) s.feed(l);
    expect(s.snapshot()).toMatchObject({ now: null, text: null, tools: 0, todos: null });
  });
  test('toolLabel : description, sinon commande, sinon nom de fichier seul', () => {
    expect(toolLabel('Bash', { command: 'ls', description: 'Liste' })).toBe('Liste');
    expect(toolLabel('Bash', { command: 'git  status\n--short' })).toBe('git status --short');
    expect(toolLabel('Edit', { file_path: 'C:\\a\\b\\app.js' })).toBe('app.js');
    expect(toolLabel('Mystère', {})).toBe('Mystère');
  });
});

describe('runLive (fichier)', () => {
  test('lecture incrémentale ; une ligne en cours d’écriture attend la passe suivante', () => {
    const f = join(dir, 'inc.jsonl');
    writeFileSync(f, use('a', 'Bash', { description: 'Compile' }, 1) + '\n');
    expect(runLive(f)!.now).toMatchObject({ label: 'Compile' });
    const r = res('a', 5);
    appendFileSync(f, r.slice(0, 20)); // moitié de ligne : rien ne change
    expect(runLive(f)!.now).toMatchObject({ label: 'Compile' });
    appendFileSync(f, r.slice(20) + '\n' + say('Compilé : 0 erreur ✅', 6) + '\n');
    const v = runLive(f)!;
    expect(v.now).toBeNull();
    expect(v.text).toBe('Compilé : 0 erreur ✅');
    expect(v.partial).toBe(false);
  });
  test('gros transcript : seule la fin est lue, la première ligne coupée est jetée, le compte est « partiel »', () => {
    const f = join(dir, 'big.jsonl');
    const lines = [use('a', 'Read', { file_path: 'x' }, 1), res('a', 2), use('b', 'Read', { file_path: 'y' }, 3), res('b', 4), use('c', 'Bash', { description: 'Tests' }, 5)];
    writeFileSync(f, lines.join('\n') + '\n');
    const size = readFileSync(f).length;
    const v = runLive(f, size - lines[0]!.length - 10)!; // coupe au milieu de la 1re ligne
    expect(v.partial).toBe(true);
    expect(v.tools).toBe(2);
    expect(v.now).toMatchObject({ label: 'Tests' });
  });
  test('fichier absent : null', () => { expect(runLive(join(dir, 'absent.jsonl'))).toBeNull(); });
});

// ── page : runLiveLine
const js = readFileSync(fileURLToPath(new URL('../../page/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const grab = (re: RegExp, name: string): string => { const m = js.match(re); if (!m) throw new Error(name + ' introuvable dans la page'); return m[0]; };
const src = [grab(/\nconst RUN_STALE_MS = .*\n/, 'RUN_STALE_MS'), grab(/\nconst TOOL_ICON = .*\n/, 'TOOL_ICON'),
  grab(/\nfunction runLiveLine\([^)]*\) \{[\s\S]*?\n\}\n/, 'runLiveLine')].join('');
type Line = { text: string; todos: string | null; tools: string; moved: string | null; stale: boolean } | null;
const runLiveLine = new Function('const T = (fr, en) => fr; const ago = ms => Math.round(ms / 60000) + " min";' + src + '\nreturn runLiveLine;')() as (l: unknown, now: number) => Line;

describe('runLiveLine (page)', () => {
  const now = 1_000_000_000_000;
  test('outil en cours, sous-agent, tâches, compte partiel', () => {
    const v = runLiveLine({ lastAt: now - 60000, now: { name: 'Agent', label: 'Cherche', since: now - 120000, inner: { name: 'Grep', label: 'runLive', since: null, inner: null } },
      text: 'x', tools: 12, partial: true, todos: { done: 2, total: 5, current: 'Écrit les tests' } }, now)!;
    expect(v.text).toBe('⏳ 🤖 Agent : Cherche · depuis 2 min › 🔎 Grep : runLive');
    expect(v.todos).toBe('📋 2/5 tâches · Écrit les tests');
    expect(v.tools).toBe('≥ 12 outils appelés');
    expect(v.stale).toBe(false);
  });
  test('rien en cours : le dernier texte ; transcript immobile > 3 min : bloqué ?', () => {
    const v = runLiveLine({ lastAt: now - 4 * 60000, now: null, text: 'Je relis le diff.', tools: 3, partial: false, todos: null }, now)!;
    expect(v.text).toBe('💬 Je relis le diff.');
    expect(v.stale).toBe(true);
    expect(v.moved).toBe('dernier mouvement il y a 4 min — bloqué ?');
  });
  test('pas de lecture : null ; rien encore : démarre…', () => {
    expect(runLiveLine(null, now)).toBeNull();
    expect(runLiveLine({ lastAt: now, now: null, text: null, tools: 0, partial: false, todos: null }, now)!.text).toBe('démarre…');
  });
});
