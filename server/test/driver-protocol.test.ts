// Protocole du pilote et comportement du client face à un pilote lent, figé ou mort. Sans console : tourne en CI.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { DriverClient, DriverError, FocusCode, SendCode } from '../src/driver.ts';
import { DRIVER_EXE, NO_SUCH_PID } from './helpers.ts';

const clients: DriverClient[] = [];
function client(timeouts?: Record<string, number>): DriverClient {
  const c = new DriverClient({ exe: DRIVER_EXE, args: ['--test-ops'], ...(timeouts ? { timeouts } : {}) });
  clients.push(c);
  return c;
}
afterEach(() => { while (clients.length) clients.pop()!.close(); });

describe('protocole', () => {
  test('ping : version et pid du pilote', async () => {
    const c = client();
    const r = await c.call('ping', {});
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.pid).toBe(c.pid);
  });

  test('opération inconnue, pid ou argument manquant : refus explicites, le pilote reste vivant', async () => {
    const c = client();
    await expect(c.call('nope', {})).rejects.toThrow('opération inconnue : nope');
    await expect(c.call('read', {})).rejects.toThrow('pid manquant ou invalide');
    await expect(c.call('read', { pid: -3 })).rejects.toThrow('pid manquant ou invalide');
    await expect(c.call('send', { pid: 12 })).rejects.toThrow('line manquant');
    await expect(c.call('sendKeys', { pid: 12, items: [1] })).rejects.toThrow('items : texte attendu');
    expect((await c.call('ping', {})).pid).toBe(c.pid);
    expect(c.starts).toBe(1);
  });

  test('opérations de test refusées sans --test-ops', async () => {
    const c = new DriverClient({ exe: DRIVER_EXE });
    clients.push(c);
    await expect(c.call('test.sleep', { ms: 1 })).rejects.toThrow('opération inconnue');
  });

  test('console inexistante : read/title/suggestion → null, send/sendKeys/focus → 2 (valeurs de ConScreen)', async () => {
    const c = client();
    expect(await c.call('read', { pid: NO_SUCH_PID })).toBeNull();
    expect(await c.call('title', { pid: NO_SUCH_PID })).toBeNull();
    expect(await c.call('suggestion', { pid: NO_SUCH_PID })).toBeNull();
    expect(await c.call('send', { pid: NO_SUCH_PID, line: 'x' })).toBe(SendCode.Inaccessible);
    expect(await c.call('sendKeys', { pid: NO_SUCH_PID, items: ['\u0001Enter'] })).toBe(SendCode.Inaccessible);
    expect(await c.call('focus', { pid: NO_SUCH_PID, noActivate: true })).toBe(FocusCode.Inaccessible);
  });

  test('idleSeconds : un nombre ; foregroundTitle : texte ou null', async () => {
    const c = client();
    expect(typeof (await c.call('idleSeconds', {}))).toBe('number');
    const t = await c.call('foregroundTitle', {});
    expect(t === null || typeof t === 'string').toBe(true);
  });

  test('XML du toast identique à celui de Show-Toast (échappement compris)', async () => {
    const c = client();
    const xml = await c.call('test.toastXml', { title: 'A & <B>', text: 'dit "oui" l\'été', launch: 'cc-focus://12?a=1&b=2' });
    expect(xml).toBe('<toast activationType="protocol" launch="cc-focus://12?a=1&amp;b=2"><visual><binding template="ToastGeneric">'
      + '<text>A &amp; &lt;B&gt;</text><text>dit &quot;oui&quot; l&apos;été</text></binding></visual></toast>');
  });

  test('ligne illisible : réponse d\'id null, le pilote continue ; stdin fermé : le pilote s\'arrête', async () => {
    const p = spawn(DRIVER_EXE, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const got: string[] = [];
    createInterface({ input: p.stdout }).on('line', (l) => got.push(l));
    p.stdin.write('pas du json\n{"id":"a","op":"ping"}\n');
    for (let i = 0; i < 50 && got.length < 2; i++) await sleep(100);
    const parsed = got.map((l) => JSON.parse(l) as { id: unknown; ok: boolean });
    expect(parsed.find((m) => m.id === null)).toMatchObject({ ok: false });
    expect(parsed.find((m) => m.id === 'a')).toMatchObject({ ok: true });
    const t0 = Date.now();
    p.stdin.end();
    const [code] = await once(p, 'exit');
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

describe('concurrence et verrou de la console', () => {
  test('requêtes traitées en parallèle : une requête lente ne retient pas un ping', async () => {
    const c = client();
    await c.call('ping', {});
    const slow = c.call('test.sleep', { ms: 1500 });
    const t0 = Date.now();
    await c.call('ping', {});
    expect(Date.now() - t0).toBeLessThan(500);
    await slow;
  });

  test('ce qui s\'attache à une console attend le verrou ; ce qui ne s\'y attache pas, non', async () => {
    const c = client();
    await c.call('ping', {});
    const hold = c.call('test.holdGate', { ms: 1200 });
    await sleep(100);
    const t0 = Date.now();
    const [read, idle] = await Promise.all([
      c.call('read', { pid: NO_SUCH_PID }).then(() => Date.now() - t0),
      c.call('idleSeconds', {}).then(() => Date.now() - t0),
    ]);
    await hold;
    expect(idle).toBeLessThan(500);
    expect(read).toBeGreaterThan(900);
  });
});

describe('pilote figé ou mort', () => {
  test('délai dépassé : la requête échoue, le pilote est tué avec ses requêtes en cours, le suivant répond', async () => {
    const c = client({ 'test.sleep': 400 });
    const first = (await c.call('ping', {})).pid;
    const hung = c.call('test.sleep', { ms: 60_000 });
    const other = c.call('test.sleep', { ms: 60_000 }, 30_000);
    const t0 = Date.now();
    await expect(hung).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1_500);
    await expect(other).rejects.toMatchObject({ kind: 'died' });
    const second = (await c.call('ping', {})).pid;
    expect(second).not.toBe(first);
    expect(c.starts).toBe(2);
  });

  test('pilote mort (sortie) : requêtes en cours rejetées, relancé à la requête suivante', async () => {
    const c = client();
    const first = (await c.call('ping', {})).pid;
    const pending = c.call('test.sleep', { ms: 5_000 });
    await expect(c.call('test.exit', { code: 3 })).rejects.toBeInstanceOf(DriverError);
    await expect(pending).rejects.toMatchObject({ kind: 'died' });
    expect((await c.call('ping', {})).pid).not.toBe(first);
  });

  test('pilote tué de l\'extérieur : relancé', async () => {
    const c = client();
    const first = (await c.call('ping', {})).pid;
    process.kill(first);
    await sleep(300);
    expect((await c.call('ping', {})).pid).not.toBe(first);
  });

  test('morts en boucle : relances espacées, jamais en rafale', async () => {
    const c = client();
    for (let i = 0; i < 4; i++) {
      await c.call('ping', {});
      await c.call('test.exit', { code: 1 }).catch(() => {});
    }
    const t0 = Date.now();
    await c.call('ping', {});
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);   // 4e mort en 30 s : 1 s d'attente
    expect(c.starts).toBe(5);
  });

  test('exe introuvable : la requête échoue sans figer', async () => {
    const c = new DriverClient({ exe: 'C:\\nexiste\\pas.exe' });
    clients.push(c);
    await expect(c.call('ping', {})).rejects.toMatchObject({ kind: 'died' });
  });

  test('close : requêtes en cours rejetées, plus aucune acceptée', async () => {
    const c = client();
    await c.call('ping', {});
    const pending = c.call('test.sleep', { ms: 5_000 });
    c.close();
    await expect(pending).rejects.toMatchObject({ kind: 'closed' });
    await expect(c.call('ping', {})).rejects.toMatchObject({ kind: 'closed' });
  });
});
