// Lecture et envoi sur des CONSOLES DE TEST (le pilote en mode --fake-console, chacune dans sa console conhost).
// Jamais sur une vraie session : un envoi y écrirait un message.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DriverClient, FocusCode, SendCode } from '../src/driver.ts';
import { DRIVER_EXE, TestConsole } from './helpers.ts';

let c: DriverClient;
const consoles: TestConsole[] = [];
async function open(...a: Parameters<typeof TestConsole.open>): Promise<TestConsole> {
  const t = await TestConsole.open(...a);
  consoles.push(t);
  // Prête = le pilote s'y attache et lit son titre (sur le runner CI, une console à peine lancée peut refuser l'attache).
  for (let i = 0; i < 30 && (await c.call('title', { pid: t.pid })) !== t.title; i++) await sleep(100);
  return t;
}
beforeAll(() => { c = new DriverClient({ exe: DRIVER_EXE, args: ['--test-ops'] }); });
afterAll(() => { c.close(); for (const t of consoles) t.close(); });

describe('invite vide', () => {
  let t: TestConsole;
  beforeAll(async () => { t = await open('empty'); });

  test('read : l\'écran visible, accents et symboles compris, fins de ligne nettoyées', async () => {
    const s = await c.call('read', { pid: t.pid });
    expect(s).toContain('Console de test du pilote sessions-desk');
    expect(s).toContain('Ligne accentuée : é à ç ✓ « guillemets »');
    expect(s).toContain('❯');
    expect(s).not.toMatch(/ +\n/);          // TrimEnd de chaque ligne
    expect(s).not.toMatch(/\s$/);           // TrimEnd du tout
  });

  test('title : le titre de la console', async () => {
    expect(await c.call('title', { pid: t.pid })).toBe(t.title);
  });

  test('suggestion : rien quand l\'invite est vide', async () => {
    expect(await c.call('suggestion', { pid: t.pid })).toBeNull();
  });

  test('send : le texte tapé tel quel, puis Entrée À PART (≥ 500 ms après, sinon lu comme un collage)', async () => {
    const before = t.keys().length;
    expect(await c.call('send', { pid: t.pid, line: 'bonjour é ✓ « x »' })).toBe(SendCode.Sent);
    await sleep(200);
    const k = t.keys().slice(before);
    expect(k.map((e) => e.ch).join('')).toBe('bonjour é ✓ « x »\r');
    const enter = k.at(-1)!;
    expect(enter.vk).toBe(0x0d);
    // Le pilote attend 500 ms ; la console de test horodate à la LECTURE, et sur un runner chargé elle lit le texte en
    // retard puis l'Entrée aussitôt (écart mesuré jusqu'à ~350 ms en CI) : seuil bas, mais deux lectures bien séparées.
    expect(enter.at - k.at(-2)!.at).toBeGreaterThanOrEqual(200);
  });

  test('sendKeys : touches nommées (code virtuel, touche étendue) et texte, dans l\'ordre', async () => {
    const before = t.keys().length;
    expect(await c.call('sendKeys', { pid: t.pid, items: ['\u0001Down', '2', '\u0001Enter', '\u0001ShiftTab', '\u0001Esc'] })).toBe(SendCode.Sent);
    await sleep(200);
    const k = t.keys().slice(before);
    expect(k.map((e) => e.vk)).toEqual([0x28, 0, 0x0d, 0x09, 0x1b]);
    expect(k[0]!.ctrl & 0x100).toBe(0x100);   // ENHANCED_KEY
    expect(k[1]!.ch).toBe('2');
    expect(k[3]!.ctrl & 0x10).toBe(0x10);     // SHIFT_PRESSED
  });

  test('sendKeys : touche inconnue → 3, rien n\'est tapé après elle', async () => {
    const before = t.keys().length;
    expect(await c.call('sendKeys', { pid: t.pid, items: ['\u0001F13', 'x'] })).toBe(SendCode.UnknownKey);
    await sleep(200);
    expect(t.keys().length).toBe(before);
  });

  test('focus (sans activer) : 3 — une console conhost n\'est pas un onglet Windows Terminal ; titre d\'origine remis', async () => {
    expect(await c.call('focus', { pid: t.pid, noActivate: true })).toBe(FocusCode.TabNotFound);
    expect(await c.call('title', { pid: t.pid })).toBe(t.title);
  });
});

describe('proposition et brouillon', () => {
  test('proposition grisée : lue telle quelle', async () => {
    const t = await open('suggestion', { suggestion: 'ouvre la PR et lance la CI' });
    expect(await c.call('suggestion', { pid: t.pid })).toBe('ouvre la PR et lance la CI');
  });

  test('brouillon dans l\'invite : send refuse (5) SANS rien taper, pas de proposition', async () => {
    const t = await open('draft');
    expect(await c.call('send', { pid: t.pid, line: 'ne doit pas partir' })).toBe(SendCode.PromptNotEmpty);
    expect(await c.call('suggestion', { pid: t.pid })).toBeNull();
    await sleep(200);
    expect(t.keys()).toEqual([]);
  });
});

describe('plusieurs consoles', () => {
  test('lectures parallèles de deux consoles : chacune lit la sienne (verrou unique)', async () => {
    const [a, b] = await Promise.all([open('empty'), open('suggestion', { suggestion: 'deuxième console' })]);
    const titles = await Promise.all(Array.from({ length: 10 }, (_, i) => c.call('title', { pid: (i % 2 ? b : a).pid })));
    // Chacune lit SA console, et jamais null : ces 10 requêtes parallèles font grossir le pool de threads, et c'est
    // précisément ce qui faisait refuser l'attache (code 1) avant le nouvel essai de ConScreen.Attach.
    titles.forEach((ti, i) => expect(ti, `#${i}`).toBe((i % 2 ? b : a).title));
    const [sa, sb] = await Promise.all([c.call('suggestion', { pid: a.pid }), c.call('suggestion', { pid: b.pid })]);
    expect(sa).toBeNull();
    expect(sb).toBe('deuxième console');
  });

  // NON-RÉGRESSION (18/11/2026) : AttachConsole est refusé passagèrement (ERROR_INVALID_FUNCTION, code 1) quand un
  // thread du process naît ou meurt au même instant — mesuré : 22 à 27 % des attaches à une même console sous création
  // de threads (natifs comme .NET), 0 sans. Sans nouvel essai, une session ouverte était lue « illisible » (null) ou
  // un envoi répondait « console inaccessible ». Ici : le vrai ConScreen.Title / Read, pendant que 4 threads créent et
  // terminent des threads natifs en continu ⇒ aucun null.
  test('lecture pendant que des threads naissent et meurent : jamais null (nouvel essai d\'attache)', async () => {
    const [a, b] = await Promise.all([open('empty'), open('suggestion', { suggestion: 'x' })]);
    const r = await c.call('test.attachLoop', { pids: [a.pid, b.pid], n: 2000, titleChurn: true }, 120000) as { nullTitle: number; nullRead: number; threadsCreated: number };
    expect(r.threadsCreated).toBeGreaterThan(1000);
    expect(r).toMatchObject({ nullTitle: 0, nullRead: 0 });
    const s = await c.call('test.attachLoop', { pids: [a.pid], n: 2000, titleChurn: true }, 120000) as { nullTitle: number; nullRead: number };
    expect(s).toMatchObject({ nullTitle: 0, nullRead: 0 });
  }, 260000);

  test('console fermée : read → null, send → 2', async () => {
    const t = await open('empty');
    t.close();
    await sleep(300);
    expect(await c.call('read', { pid: t.pid })).toBeNull();
    expect(await c.call('send', { pid: t.pid, line: 'x' })).toBe(SendCode.Inaccessible);
  });
});
