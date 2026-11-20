// Arrêt propre (Server.shutdown) : ce qui est déjà reçu va au bout, ce qui arrive ensuite est refusé net (503), puis
// le serveur sort de lui-même avec le code 0. Serveur Node réel sur un port de test, profil factice (fixture).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildFixture, call, sleep, startServer, type Fixture, type Srv } from './parity/harness.ts';

let fx: Fixture; let s: Srv;
beforeAll(async () => { fx = await buildFixture(); s = await startServer('node', fx); }, 60000);
afterAll(async () => { await s?.stop(); });

const exited = async (ms: number): Promise<number | null> => {
  for (let i = 0; i < ms / 50 && s.proc.exitCode === null; i++) await sleep(50);
  return s.proc.exitCode;
};

test('arrêt demandé pendant une action : l\'action en cours ET celle arrivée juste après vont au bout, la suite est refusée', async () => {
  const busy = call(s, '/api/test-busy?ms=1500');                 // en cours de traitement quand l'arrêt arrive
  await sleep(150);
  const stop = call(s, '/api/stop');                              // en file derrière elle
  await sleep(50);
  const after = call(s, '/api/test-busy?ms=1000');                // reçue avant l'arrêt, plus longue que l'ancien délai de 300 ms : servie, plus coupée
  expect((await busy).code).toBe(200);
  expect((await stop).body).toBe('{"stopped":true}');
  // Arrêt en cours (« after » tourne encore ~1 s) : une nouvelle requête est refusée net, jamais acceptée puis coupée.
  const late = await call(s, '/api/state', { timeoutMs: 3000 });
  expect(late.code).toBe(503); expect(late.json().error).toMatch(/arrêt/);
  expect((await after).code).toBe(200);
  expect(await exited(10000)).toBe(0);
}, 30000);
