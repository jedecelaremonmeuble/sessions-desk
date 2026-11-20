// FACULTATIFS (poste seulement) : ce qui demande Windows Terminal ou le centre de notifications.
//   SD_TEST_WT=1    ouvre une fenêtre Windows Terminal « sd-driver-test » (opération wt du pilote) avec deux consoles de
//                   test, y lit, y envoie, retrouve les onglets par UI Automation SANS les activer (focus noActivate),
//                   puis les ferme. C'est le cas réel des sessions : console hébergée par ConPTY, pas par conhost.
//   SD_TEST_TOAST=1 affiche UNE notification « test du pilote ».
// Jamais de vraie session.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DriverClient, FocusCode, SendCode } from '../src/driver.ts';
import { DRIVER_EXE, TestConsole } from './helpers.ts';

let c: DriverClient;
beforeAll(() => { c = new DriverClient({ exe: DRIVER_EXE }); });
afterAll(() => c.close());

describe.runIf(process.env.SD_TEST_WT === '1')('Windows Terminal', () => {
  const opened: TestConsole[] = [];
  async function openInWt(mode: 'empty' | 'suggestion', title?: string): Promise<TestConsole> {
    const a = TestConsole.args(mode, { ttl: 60 });
    const line = title ? a.line.replace(a.title, title) : a.line;
    const r = await c.call('wt', { args: `-w sd-driver-test nt ${line}` });
    expect(r).toHaveProperty('pid');
    const t = await TestConsole.wait(a.dir, title ?? a.title);
    opened.push(t);
    return t;
  }
  afterAll(async () => {
    // Ctrl+Q : sortie propre de la console de test, l'onglet se ferme seul.
    for (const t of opened) await c.call('sendKeys', { pid: t.pid, items: ['\u0011'] }).catch(() => {});
    await sleep(500);
    for (const t of opened) t.close();
  });

  test('onglet ouvert par wt : lecture, titre, envoi', async () => {
    const t = await openInWt('empty');
    await sleep(500);
    expect(await c.call('read', { pid: t.pid })).toContain('Console de test du pilote');
    expect(await c.call('title', { pid: t.pid })).toBe(t.title);
    expect(await c.call('send', { pid: t.pid, line: 'via ConPTY' })).toBe(SendCode.Sent);
    await sleep(200);
    expect(t.typed()).toBe('via ConPTY\r');
  });

  test('focus sans activer : onglet retrouvé par son titre (titre unique)', async () => {
    const t = opened[0]!;
    expect(await c.call('focus', { pid: t.pid, noActivate: true })).toBe(FocusCode.Ok);
  });

  test('focus sans activer : deux onglets au même titre → titre-marqueur, puis titre d\'origine remis', async () => {
    const same = `sessions-desk-test-meme-titre-${process.pid}`;
    const a = await openInWt('empty', same);
    await openInWt('suggestion', same);
    await sleep(800);
    expect(await c.call('focus', { pid: a.pid, noActivate: true })).toBe(FocusCode.Ok);
    expect(await c.call('title', { pid: a.pid })).toBe(same);
  });
});

describe.runIf(process.env.SD_TEST_TOAST === '1')('notification', () => {
  test('toast affiché sans erreur', async () => {
    expect(await c.call('toast', { title: 'Sessions Desk — test du pilote', text: 'Notification de test, à ignorer.', launch: 'http://localhost:8765/' })).toBe(true);
  });
});
