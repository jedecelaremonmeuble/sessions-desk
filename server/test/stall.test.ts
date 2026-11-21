// Trace de performance (stall.ts) : verdict calcul / attente, ligne de démarrage, et le guetteur réel (fil de
// travail) devant un fil principal BLOQUÉ — par du calcul (CPU ≈ durée) puis par une attente (Atomics.wait, CPU ≈ 0).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { setPhase, startStallWatch, startupLine, stallVerdict } from '../src/stall.ts';
import { sleep } from './parity/harness.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const dir = mkdtempSync(join(tmpdir(), 'sd-stall-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const read = (f: string): string => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const busy = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* calcul */ } };
const asleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const until = async (f: () => boolean, ms = 3000): Promise<void> => { for (let i = 0; i < ms / 50 && !f(); i++) await sleep(50); };

test('verdict : CPU ≈ durée => calcul ; CPU ≈ 0 => attente ; entre les deux => mêlés', () => {
  expect(stallVerdict(10000, 9500)).toMatch(/calculait/);
  expect(stallVerdict(10000, 300)).toMatch(/attendait/);
  expect(stallVerdict(10000, 4000)).toMatch(/mêlés/);
  expect(stallVerdict(0, 0)).toMatch(/attendait/);
});

test('ligne de démarrage : chaque phase, le total, le CPU ; « LENT » au-delà du seuil', () => {
  const l = startupLine([['modules', 812.4], ['écoute', 15]], 1600, 1300);
  expect(l).toBe('démarrage : modules 812 ms · écoute 15 ms · total 1600 ms (CPU 1300 ms, le serveur calculait (code))');
  expect(startupLine([['1er état', 34000]], 35000, 900)).toMatch(/^démarrage LENT : .*attendait/);
});

test('gel par CALCUL puis gel par ATTENTE : vus du fil de travail, avec la phase et le bon verdict', async () => {
  const f = join(dir, 'a.perf.log');
  const w = startStallWatch(f, { thresholdMs: 500, everyMs: 100, beatMs: 50, repeatMs: 400 });
  try {
    await sleep(300);                         // le guetteur prend ses repères
    setPhase('état'); busy(1500);
    await until(() => /débloquée.*phase état/.test(read(f)));
    setPhase('index'); asleep(1500);
    await until(() => /débloquée.*phase index/.test(read(f)));
  } finally { await w.stop(); }
  const log = read(f);
  expect(log).toMatch(/boucle figée depuis \d+ ms \(phase état\)/);
  expect(log).toMatch(/boucle toujours figée depuis \d+ ms \(phase état\)/);   // un gel qui dure est re-signalé
  expect(log).toMatch(/débloquée après \d+ ms \(phase état\) : CPU \d+ ms sur \d+ ms, le serveur calculait/);
  expect(log).toMatch(/débloquée après \d+ ms \(phase index\) : CPU \d+ ms sur \d+ ms, le serveur attendait/);
}, 20000);

test('boucle libre : aucune ligne', async () => {
  const f = join(dir, 'b.perf.log');
  const w = startStallWatch(f, { thresholdMs: 500, everyMs: 100, beatMs: 50 });
  await sleep(1200); await w.stop();
  expect(read(f)).toBe('');
});

test('serveur réel : une ligne de démarrage par lancement, phases jusqu\'au 1er état', async () => {
  // Port libre et profil vide À LUI : jamais le port fixe de la parité, qu'une autre suite peut tenir au même moment.
  const port = await new Promise<number>((ok) => { const t = createServer().listen(0, '127.0.0.1', () => { const a = t.address() as AddressInfo; t.close(() => ok(a.port)); }); });
  const home = join(dir, 'home'); const temp = join(dir, 'tmp');
  for (const d of [join(home, '.claude'), join(home, 'AppData', 'Local'), temp]) mkdirSync(d, { recursive: true });
  const f = join(temp, `sessions-desk-node-${port}.perf.log`);
  const proc = spawn(process.execPath, [join(REPO, 'server', 'src', 'main.ts'), '--port', String(port), '--no-background', '--tailscale', ''],
    { env: { ...process.env, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: temp, TMP: temp }, windowsHide: true, stdio: 'ignore' });
  try {
    await until(() => read(f).includes('1er état'), 30000);
    expect(read(f)).toMatch(/démarrage( LENT)? : modules \d+ ms · préparation \d+ ms · protocole \d+ ms · identité \d+ ms · purge \d+ ms · écoute \d+ ms · 1er état \d+ ms · total \d+ ms \(CPU \d+ ms, /);
    expect(Number(/modules (\d+) ms/.exec(read(f))![1])).toBeGreaterThan(0);   // le chargement des modules compte, depuis le lancement
  } finally { proc.kill(); }
}, 60000);
