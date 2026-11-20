// DIAGNOSTIC du refus passager d'AttachConsole (vu sur le runner CI, jamais sur le poste) : mesures imprimées,
// le test n'échoue jamais. Lancé seulement avec SD_ATTACH_PROBE=1.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { DriverClient } from '../src/driver.ts';
import { DRIVER_EXE, TestConsole } from './helpers.ts';

describe.runIf(process.env.SD_ATTACH_PROBE === '1')('sonde d\'attache', () => {
  let c: DriverClient;
  const cons: TestConsole[] = [];
  const log = (name: string, r: unknown): void => console.log(`[attach-probe] ${name} : ${JSON.stringify(r)}`);
  beforeAll(async () => {
    c = new DriverClient({ exe: DRIVER_EXE, args: ['--test-ops'], timeouts: { 'test.attachLoop': 170000 } });
    // Comme le test fautif : deux consoles ouvertes en même temps (vide, proposition), puis deux autres à la suite.
    cons.push(...await Promise.all([TestConsole.open('empty'), TestConsole.open('suggestion', { suggestion: 'x' })]));
    cons.push(await TestConsole.open('empty'), await TestConsole.open('draft'));
    await sleep(1500);
    log('consoles', cons.map((t) => t.pid));
  }, 60000);
  afterAll(() => { c.close(); for (const t of cons) t.close(); });

  const loop = async (name: string, pick: number[], o: Record<string, unknown>): Promise<void> => {
    log(name, await c.call('test.attachLoop', { pids: pick.map((i) => cons[i]!.pid), n: 2000, ...o }, 170000));
  };
  test('1 thread, 2 consoles ouvertes ensemble', () => loop('1 thread, a/b', [0, 1], {}), 180000);
  test('1 thread, 2 consoles ouvertes à la suite', () => loop('1 thread, c/d', [2, 3], {}), 180000);
  test('1 thread, même console', () => loop('1 thread, a/a', [0, 0], {}), 180000);
  test('8 threads, 2 consoles', () => loop('8 threads, a/b', [0, 1], { threads: 8 }), 180000);
  test('8 threads, 4 consoles', () => loop('8 threads, a/b/c/d', [0, 1, 2, 3], { threads: 8 }), 180000);
  test('ConScreen.Title, 8 threads, 2 consoles', () => loop('Title 8 threads, a/b', [0, 1], { threads: 8, title: true }), 180000);
  test('ConScreen.Title, 1 thread, 2 consoles', () => loop('Title 1 thread, a/b', [0, 1], { threads: 1, title: true }), 180000);

  test('RÉ-ATTACHE immédiate : même console / consoles différentes, un thread / relais entre deux, avec ou sans écart', async () => {
    const r: Record<string, unknown> = {};
    for (const [name, pick, handoff, gapUs] of [
      ['même console, 1 thread', [0], false, 0], ['même console, relais', [0], true, 0],
      ['a/b, 1 thread', [0, 1], false, 0], ['a/b, relais', [0, 1], true, 0],
      ['même console, relais, écart 50 µs', [0], true, 50], ['même console, relais, écart 500 µs', [0], true, 500], ['même console, 1 thread, écart 500 µs', [0], false, 500],
    ] as const) {
      const x = await c.call('test.attachLoop', { pids: pick.map((i) => cons[i]!.pid), n: 3000, tight: true, handoff, gapUs }, 170000) as { failed: number; byError: unknown };
      r[name] = `${x.failed}/3000 ${JSON.stringify(x.byError)}`;
    }
    log('ré-attache immédiate', r);
  }, 180000);

  test('THREAD NEUF à chaque attache : même console / consoles différentes', async () => {
    const r: Record<string, unknown> = {};
    for (const [name, pick] of [['même console', [0]], ['a/b', [0, 1]], ['a/b/c/d', [0, 1, 2, 3]]] as const) {
      r[name] = await c.call('test.attachLoop', { pids: pick.map((i) => cons[i]!.pid), n: 3000, tight: true, newThread: true }, 170000);
    }
    log('thread neuf', r);
  }, 180000);

  test('CRÉATION DE THREADS en parallèle des attaches (churn) contre threads qui durent (témoin)', async () => {
    const r: Record<string, unknown> = {};
    for (const [name, pick, gapUs] of [['churn, a/b', [0, 1], -1], ['témoin, a/b', [0, 1], -2], ['churn, même console', [0], -1], ['témoin, même console', [0], -2], ['churn NATIF, même console', [0], -3], ['churn NATIF, a/b', [0, 1], -3]] as const) {
      r[name] = await c.call('test.attachLoop', { pids: pick.map((i) => cons[i]!.pid), n: 20000, tight: true, gapUs }, 170000);
    }
    log('churn', r);
  }, 180000);

  test('CORRECTIF : vrai ConScreen.Title / Read sous création de threads', async () => {
    const r: Record<string, unknown> = {};
    for (const [name, pick] of [['même console', [0]], ['a/b', [0, 1]]] as const) r[name] = await c.call('test.attachLoop', { pids: pick.map((i) => cons[i]!.pid), n: 5000, titleChurn: true }, 170000);
    log('correctif', r);
  }, 360000);

  test('consoles NEUVES : 15 tours (ouverture, « prête », 10 attaches parallèles tout de suite)', async () => {
    const out: unknown[] = []; let calls = 0, failed = 0, nulls = 0;
    for (let round = 0; round < 15; round++) {
      const [x, y] = await Promise.all([TestConsole.open('empty'), TestConsole.open('suggestion', { suggestion: 'x' })]);
      const t0 = Date.now();
      for (const t of [x!, y!]) for (let i = 0; i < 30 && (await c.call('title', { pid: t.pid })) !== t.title; i++) await sleep(100);
      const ready = Date.now() - t0;
      const r = await c.call('test.attachLoop', { pids: [x!.pid, y!.pid], n: 10, threads: 10 }) as { failed: number; fails: unknown[] };
      const titles = await Promise.all(Array.from({ length: 10 }, (_, i) => c.call('title', { pid: (i % 2 ? y! : x!).pid })));
      calls += 20; failed += r.failed; const nn = titles.filter((t) => t === null).length; nulls += nn;
      if (r.failed || nn) out.push({ round, ready, a: x!.pid, b: y!.pid, attachFails: r.fails, titleNulls: titles.map((t, i) => (t === null ? i : -1)).filter((i) => i >= 0) });
      x!.close(); y!.close();
    }
    log('consoles neuves', { rounds: 15, calls, attachFailed: failed, titleNulls: nulls, detail: out });
  }, 180000);

  test('scénario du test fautif : 10 « title » parallèles par le client, 100 fois', async () => {
    const [a, b] = cons; const nulls: unknown[] = [];
    for (let round = 0; round < 100; round++) {
      const r = await Promise.all(Array.from({ length: 10 }, (_, i) => c.call('title', { pid: (i % 2 ? b! : a!).pid })));
      for (const [i, t] of r.entries()) if (t === null) nulls.push({ round, i, pid: (i % 2 ? b! : a!).pid, attachNow: await c.call('test.attach', { pid: (i % 2 ? b! : a!).pid }) });
    }
    log('client 10 x 100', { calls: 1000, nulls: nulls.length, sample: nulls.slice(0, 10) });
  }, 180000);
});
