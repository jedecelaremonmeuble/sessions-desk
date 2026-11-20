// Garde-fous de sécurité du serveur Node, testés sans serveur : Host admis par le relais, corps plafonné, options de
// lancement de claude, dossier dont le chemin contient « ; ». Ce qui se compare au .ps1 est dans test/parity.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, test } from 'vitest';
import { Actions, SEMICOLON_REFUSED } from '../src/actions.ts';
import { parseArgs } from '../src/config.ts';
import { MAX_BODY, readBody, relayHostOk } from '../src/http.ts';
import { claudeArgsOk, loadSettings, parseClaudeArgs } from '../src/modules.ts';

const dir = mkdtempSync(join(tmpdir(), 'sd-securite-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('relais : Host d\'origine', () => {
  const origin = 'https://poste.example.ts.net';
  test('le nom du poste sur le tailnet, sans la casse ni le port', () => {
    for (const h of ['poste.example.ts.net', 'POSTE.Example.TS.net', 'poste.example.ts.net:443', 'poste.example.ts.net:8766']) expect(relayHostOk(h, 1, origin), h).toBe(true);
    expect(relayHostOk('poste.example.ts.net', 1, 'HTTPS://Poste.Example.ts.net')).toBe(true);
  });
  test('tout autre nom : refusé (DNS rebinding), comme un Host absent ou répété', () => {
    for (const h of ['evil.example', 'poste.example.ts.net.evil.example', 'evil.poste.example.ts.net', 'localhost', 'localhost:8766', '127.0.0.1:8766', '[::1]:8766',
      'poste.example.ts.net.', 'poste.example.ts.net:abc', 'poste.example.ts.net:443:443x', ' ', '']) expect(relayHostOk(h, 1, origin), h).toBe(false);
    expect(relayHostOk(null, 0, origin)).toBe(false);
    expect(relayHostOk('poste.example.ts.net', 2, origin)).toBe(false);
  });
  test('identité Tailscale inconnue au démarrage : tout est refusé', () => {
    for (const h of ['poste.example.ts.net', 'localhost', '']) expect(relayHostOk(h, 1, null), h).toBe(false);
  });
});

describe('corps de requête', () => {
  const req = (chunks: Buffer[]): IncomingMessage => Readable.from(chunks) as unknown as IncomingMessage;
  test('lu en entier jusqu\'à la limite', async () => {
    expect(await readBody(req([Buffer.from('{"a":'), Buffer.from('"é"}')]))).toBe('{"a":"é"}');
    expect(await readBody(req([]))).toBe('');
    expect((await readBody(req([Buffer.alloc(MAX_BODY, 0x61)])))!.length).toBe(MAX_BODY);
    expect(await readBody(req([Buffer.from('abcdef')]), 3)).toBe('abc');
  });
  test('au-delà : null dès le dépassement, sans attendre la fin du flux', async () => {
    expect(await readBody(req([Buffer.alloc(MAX_BODY, 0x61), Buffer.from('b')]))).toBeNull();
    expect(await readBody(req([Buffer.from('abcd')]), Infinity, 3)).toBeNull();
    // Flux sans fin : la réponse n'attend pas « end ».
    const endless = new Readable({ read() { setImmediate(() => this.push(Buffer.alloc(65536))); } });
    expect(await readBody(endless as unknown as IncomingMessage)).toBeNull();
    endless.destroy();
  });
});

describe('options de lancement de claude', () => {
  const cfgFile = (name: string, o: unknown): string => { const f = join(dir, name); writeFileSync(f, JSON.stringify(o)); return f; };
  const env = { USERPROFILE: dir, LOCALAPPDATA: join(dir, 'lad'), TEMP: dir };
  test('validation : une ligne de 200 caractères au plus, sans « ; »', () => {
    expect(claudeArgsOk('--model opus')).toBe('--model opus');
    expect(claudeArgsOk('  --verbose ')).toBe('--verbose');
    expect(claudeArgsOk('')).toBe('');
    expect(claudeArgsOk('a'.repeat(200))).toBe('a'.repeat(200));
    for (const v of ['a'.repeat(201), '--x ; calc', '--x\ncalc', '--x\rcalc', 12, null, undefined, ['--x'], {}]) expect(claudeArgsOk(v), String(v)).toBeNull();
  });
  test('fichier de configuration : clé de premier niveau, refusée ⇒ aucune option', () => {
    expect(parseClaudeArgs({ claudeArgs: '--model opus' })).toBe('--model opus');
    for (const raw of [null, {}, [], { claudeArgs: 3 }, { claudeArgs: 'x; calc' }, { modules: { claudeArgs: '--x' } }]) expect(parseClaudeArgs(raw)).toBe('');
    const pe = { home: dir, localAppData: dir, temp: dir };
    expect(loadSettings(cfgFile('args.json', { claudeArgs: '--model opus' }), pe).claudeArgs).toBe('--model opus');
    expect(loadSettings(join(dir, 'absent.json'), pe).claudeArgs).toBe('');
  });
  test('défaut vide ; le fichier ; --claude-args prioritaire ; --claude-args invalide ⇒ erreur au démarrage', () => {
    expect(parseArgs(['--config', join(dir, 'absent.json')], env).claudeArgs).toBe('');
    expect(parseArgs([], env).claudeArgs).toBe('');
    const f = cfgFile('poste.json', { claudeArgs: '--du-fichier' });
    expect(parseArgs(['--config', f], env).claudeArgs).toBe('--du-fichier');
    expect(parseArgs(['--config', f, '--claude-args', '--de-la-ligne'], env).claudeArgs).toBe('--de-la-ligne');
    expect(parseArgs(['--config', f, '--claude-args', ''], env).claudeArgs).toBe('');
    expect(parseArgs(['--config', cfgFile('refuse.json', { claudeArgs: '--x ; calc' })], env).claudeArgs).toBe('');
    expect(() => parseArgs(['--claude-args', '--x ; calc'], env)).toThrow(/--claude-args/);
  });
});

describe('dossier dont le chemin contient « ; »', () => {
  const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const semi = join(dir, 'pi;ege'); const sain = join(dir, 'sain');
  mkdirSync(semi); mkdirSync(sain); mkdirSync(join(dir, 'state'));
  /** Tableau de bord réduit à ce que lisent ces actions ; chaque appel au pilote est noté. */
  const make = (cwd: string, open: Record<string, unknown>[] = []): { a: Actions; calls: [string, any][] } => {
    const calls: [string, any][] = [];
    const d = {
      cfg: { claudeArgs: '' }, sessionsDir: join(dir, 'sessions'), openSeen: new Map(),
      openSessions: async () => open, meta: () => ({ path: join(dir, 'x.jsonl'), cwd }), newFolders: async () => [{ path: cwd, last: 0, count: 1 }],
      sf: (n: string) => join(dir, 'state', n), setTag: () => null, setSeen: () => undefined, tagVocab: () => ({}),
      driver: { call: async (op: string, args: unknown) => { calls.push([op, args]); return 0; } },
    };
    return { a: new Actions(d as never), calls };
  };
  test('rouvrir : refusé, Windows Terminal jamais appelé', async () => {
    const { a, calls } = make(semi);
    expect(await a.reopen(ID)).toBe(SEMICOLON_REFUSED);
    expect(await a.reopenMany([ID])).toEqual({ error: 'aucune session à rouvrir', opened: 0, skipped: 1 });
    expect(calls).toEqual([]);
  });
  test('relancer : refusé AVANT de fermer la session (ni /exit, ni arrêt)', async () => {
    const { a, calls } = make(semi, [{ pid: process.pid, sessionId: ID, status: 'idle' }]);
    expect(await a.relaunch(process.pid)).toBe(SEMICOLON_REFUSED);
    expect(calls).toEqual([]);
  });
  test('nouvelle session : refusée, ni onglet ni fichier de message', async () => {
    const { a, calls } = make(semi);
    expect(await a.newSession(semi, 'bonjour le monde', '', '')).toBe(SEMICOLON_REFUSED);
    expect(calls).toEqual([]);
  });
  test('dossier sain : onglet ouvert, sans option par défaut', async () => {
    const { a, calls } = make(sain);
    expect(await a.reopen(ID)).toBeNull();
    expect(calls).toEqual([['wt', { args: `-w 0 nt -d "${sain}" pwsh -NoExit -Command "claude  --resume ${ID}"` }]]);
  });
});
