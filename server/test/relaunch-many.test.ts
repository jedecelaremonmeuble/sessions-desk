// Relance groupée (Actions.relaunchMany), testée sans serveur ni pilote : les « sessions » sont de vrais process (node
// qui attend), le pilote est simulé — « send /exit » fait sortir le process, comme la vraie commande.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { Actions, SHELL_RESUME } from '../src/actions.ts';
import { DriverClient } from '../src/driver.ts';
import { DRIVER_EXE, PAGE_DIR } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'sd-relance-'));
const cwd = join(dir, "dossier d'essai"); mkdirSync(cwd); mkdirSync(join(dir, 'state')); mkdirSync(join(dir, 'sessions'));
const kids: ChildProcess[] = [];
afterEach(() => { for (const k of kids.splice(0)) try { k.kill(); } catch { /* déjà sorti */ } });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ID = (n: number): string => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
function fakeSession(): number { const k = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); kids.push(k); return k.pid!; }
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface Opts { shell?: string | null; sendCode?: (pid: number) => number; comesBack?: boolean; backWaitMs?: number; keysCode?: number }
/** Tableau de bord réduit à ce que lit la relance. shell : nom du process parent des sessions (null : parent inconnu). */
function make(open: Record<string, unknown>[], o: Opts = {}): { a: Actions; calls: [string, any][] } {
  const calls: [string, any][] = []; const exited = new Set<number>();
  const d = {
    cfg: { claudeArgs: '--x' }, sessionsDir: join(dir, 'sessions'), openSeen: new Map(),
    openSessions: async () => open.filter((s) => !exited.has(s.pid as number) || o.comesBack !== false),
    meta: () => ({ path: join(dir, 'x.jsonl'), cwd }), sf: (n: string) => join(dir, 'state', n), setSeen: () => undefined,
    driver: {
      call: async (op: string, args: any) => {
        if (op === 'procs') {
          if (args.name === 'claude') return open.map((s) => ({ pid: s.pid, parent: process.pid }));
          return args.name === o.shell ? [{ pid: process.pid }] : [];
        }
        calls.push([op, args]);
        if (op === 'send') { const code = o.sendCode ? o.sendCode(args.pid) : 0; if (code === 0) { exited.add(args.pid); process.kill(args.pid); } return code; }
        if (op === 'sendKeys') return o.keysCode ?? 0;
        return 0;
      },
    },
  };
  const a = new Actions(d as never); a.backWaitMs = o.backWaitMs ?? 0; a.promptWaitMs = 0;
  return { a, calls };
}

describe('relance groupée', () => {
  test('session lancée d\'un shell connu : /exit, puis la reprise tapée à l\'invite de ce shell — aucun nouvel onglet', async () => {
    const p1 = fakeSession(), p2 = fakeSession();
    const { a, calls } = make([{ pid: p1, sessionId: ID(1), status: 'idle', title: 'un' }, { pid: p2, sessionId: ID(2), status: 'idle', title: 'deux' }], { shell: 'pwsh' });
    const r = await a.relaunchMany([p1, p2, p1]);
    expect(r).toEqual({ relaunched: [{ title: 'un', sameTab: true }, { title: 'deux', sameTab: true }], skipped: [] });
    const line = (n: number): string => `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; claude --x --resume ${ID(n)}`;
    expect(calls).toEqual([
      ['send', { pid: p1, line: '/exit' }], ['send', { pid: p2, line: '/exit' }],
      ['sendKeys', { pid: process.pid, items: [line(1), '\u0001Enter'] }], ['sendKeys', { pid: process.pid, items: [line(2), '\u0001Enter'] }]]);
    expect(isAlive(p1) || isAlive(p2)).toBe(false);
    const journal = readFileSync(join(dir, 'state', 'restart-idle-sessions.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    expect(journal.slice(-2).map((j) => [j.name, j.code, j.result])).toEqual([['un', 0, 'relancée dans son onglet'], ['deux', 0, 'relancée dans son onglet']]);
  });

  test('parent inconnu, ou frappe refusée par le shell : reprise dans un nouvel onglet, un seul appel au terminal', async () => {
    const p1 = fakeSession(), p2 = fakeSession();
    const open = [{ pid: p1, sessionId: ID(1), status: 'idle', title: 'un' }, { pid: p2, sessionId: ID(2), status: 'idle', title: 'deux' }];
    const { a, calls } = make(open, { shell: null });
    expect(await a.relaunchMany([p1, p2])).toEqual({ relaunched: [{ title: 'un', sameTab: false }, { title: 'deux', sameTab: false }], skipped: [] });
    expect(calls.at(-1)).toEqual(['wt', { args: `-w 0 ${a.resumeTab(ID(1), cwd)} ; ${a.resumeTab(ID(2), cwd)}` }]);
    expect(calls.filter((c) => c[0] === 'sendKeys')).toEqual([]);

    const p3 = fakeSession();
    const k = make([{ pid: p3, sessionId: ID(3), status: 'idle', title: 'trois' }], { shell: 'cmd', keysCode: 2 });
    expect(await k.a.relaunchMany([p3])).toEqual({ relaunched: [{ title: 'trois', sameTab: false }], skipped: [] });
    expect(k.calls.map((c) => c[0])).toEqual(['send', 'sendKeys', 'wt']);
  });

  test('au travail, bloquée, automate, brouillon dans l\'invite : sautée et laissée en vie', async () => {
    const busy = fakeSession(), auto = fakeSession(), draft = fakeSession(), ok = fakeSession();
    const { a, calls } = make([
      { pid: busy, sessionId: ID(1), status: 'busy', title: 'travaille' }, { pid: auto, sessionId: ID(2), status: 'idle', headless: true, title: 'automate' },
      { pid: draft, sessionId: ID(3), status: 'idle', title: 'brouillon' }, { pid: ok, sessionId: ID(4), status: 'idle', title: 'ok' }],
    { shell: 'pwsh', sendCode: (pid) => (pid === draft ? 5 : 0) });
    const r = await a.relaunchMany([busy, auto, draft, ok, 4_000_001]) as { relaunched: unknown[]; skipped: { title: string; why: string }[] };
    expect(r.relaunched).toEqual([{ title: 'ok', sameTab: true }]);
    expect(r.skipped.map((s) => s.title)).toEqual(['travaille', 'automate', 'brouillon']);
    expect(r.skipped[0]!.why).toContain('statut busy'); expect(r.skipped[2]!.why).toContain('brouillon');
    expect(calls.filter((c) => c[0] === 'send').map((c) => c[1].pid)).toEqual([draft, ok]);
    expect([busy, auto, draft].every(isAlive)).toBe(true);
  });

  test('une session relancée qui ne redevient pas listée est dite, pas comptée', async () => {
    const p1 = fakeSession();
    const { a } = make([{ pid: p1, sessionId: ID(1), status: 'idle', title: 'un' }], { shell: 'pwsh', comesBack: false, backWaitMs: 60 });
    const r = await a.relaunchMany([p1]) as { relaunched: unknown[]; skipped: { why: string }[] };
    expect(r.relaunched).toEqual([]); expect(r.skipped).toHaveLength(1); expect(r.skipped[0]!.why).toContain('pas réapparue');
  });

  test('ligne de reprise : dossier entre guillemets du shell, apostrophe doublée pour PowerShell', () => {
    expect(SHELL_RESUME.pwsh!("C:\\l'x", 'claude --resume i')).toBe("Set-Location -LiteralPath 'C:\\l''x'; claude --resume i");
    expect(SHELL_RESUME.cmd!('C:\\a b', 'claude --resume i')).toBe('cd /d "C:\\a b" && claude --resume i');
  });
});

describe('page : sessions visées par le bouton', () => {
  const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8');
  const src = /\nfunction restartPlan\(items\) \{[\s\S]*?\n\}\r?\n/.exec(js);
  test('« À traiter », « ⏳ Attente Teams » et « Inactives » ouvertes ; seule une session inactive est relancée', () => {
    expect(src).not.toBeNull();
    const restartPlan = new Function(src![0] + '; return restartPlan;')() as (items: unknown[]) => { go: { key: string }[]; skip: { it: { key: string }; why: string }[] };
    const it = (key: string, state: string, status: string, more: object = {}): object => ({ key, kind: 'open', state, status, ...more });
    const p = restartPlan([
      it('done', 'done', 'idle'), it('ask', 'ask', 'idle'), it('teams', 'teams', 'idle'), it('idle', 'idle', 'idle'),
      it('dialogue', 'waiting', 'waiting'), it('ask-shell', 'ask', 'shell'),
      it('busy', 'busy', 'busy'), it('shell', 'shell', 'shell'), it('auto', 'auto', 'idle', { headless: true }),
      { key: 'fermee', kind: 'closed', state: 'teams' }, { key: 'run', kind: 'run', state: 'auto' }]);
    expect(p.go.map((x) => x.key)).toEqual(['done', 'ask', 'teams', 'idle']);
    expect(p.skip.map((x) => [x.it.key, x.why])).toEqual([['dialogue', 'bloquée sur une question'], ['ask-shell', 'commande en arrière-plan en cours']]);
  });
});

describe('pilote : parent d\'un process', () => {
  test('procs avec commandLine rend le pid du parent', async () => {
    const k = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); kids.push(k);
    const c = new DriverClient({ exe: DRIVER_EXE });
    try {
      const list = await c.call('procs', { name: 'node', commandLine: true }) as { pid: number; parent?: number }[];
      expect(list.find((p) => p.pid === k.pid)?.parent).toBe(process.pid);
    } finally { c.close(); }
  });
});
