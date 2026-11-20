import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Le serveur PowerShell historique est-il dans ce dépôt ? Il n'est pas dans l'arbre publié. */
export const LEGACY_PS1 = join(REPO, 'legacy', 'sessions-dashboard.ps1');
export const HAS_LEGACY = existsSync(LEGACY_PS1);
export const PAGE_DIR = existsSync(join(REPO, 'page')) ? join(REPO, 'page') : join(REPO, 'legacy', 'sessions-dashboard-page');
export const DRIVER_EXE = process.env.SD_DRIVER_EXE ?? join(REPO, '.build', 'driver', 'sessions-desk-driver.exe');

export interface KeyEvent { at: number; vk: number; ch: string; ctrl: number }
export type Mode = 'empty' | 'suggestion' | 'draft';
/** exe : autre exe que le pilote (ex. sa copie nommée claude.exe, pour passer pour une session) ; text : lignes affichées avant l'invite. */
export interface ConsoleOpts { suggestion?: string; ttl?: number; exe?: string; text?: string; title?: string; noBanner?: boolean }

/**
 * Console de test : le pilote lui-même en mode --fake-console, dans SA console (conhost, pas un onglet Windows
 * Terminal : on n'ouvre rien dans les fenêtres de travail). Jamais une vraie session.
 */
export class TestConsole {
  readonly pid: number; readonly title: string; private readonly dir: string;
  private constructor(pid: number, title: string, dir: string) { this.pid = pid; this.title = title; this.dir = dir; }

  static args(mode: Mode, opts: ConsoleOpts = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'sd-driver-test-'));
    const title = opts.title ?? `sessions-desk-test-${mode}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const args = ['--fake-console', '--mode', mode, '--log', join(dir, 'keys.jsonl'), '--pidfile', join(dir, 'pid'),
      '--title', title, '--ttl', String(opts.ttl ?? 90)];
    if (opts.suggestion) args.push('--suggestion', opts.suggestion);
    if (opts.noBanner) args.push('--no-banner');
    if (opts.text) { writeFileSync(join(dir, 'screen.txt'), opts.text, 'utf8'); args.push('--text-file', join(dir, 'screen.txt')); }
    return { dir, title, args, line: [opts.exe ?? DRIVER_EXE, ...args].map(quote).join(' ') };
  }

  static async open(mode: Mode, opts: ConsoleOpts = {}): Promise<TestConsole> {
    const a = TestConsole.args(mode, opts);
    // conhost.exe <commande> : console classique, même quand Windows Terminal est le terminal par défaut.
    const p = spawn('cmd.exe', ['/d', '/c', 'start', '""', '/min', 'conhost.exe', a.line],
      { windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: true });
    p.unref();
    return TestConsole.wait(a.dir, a.title);
  }

  /** Attend la console lancée par un autre moyen (ex. l'opération wt du pilote). */
  static async wait(dir: string, title: string): Promise<TestConsole> {
    const pidFile = join(dir, 'pid');
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100);
    if (!existsSync(pidFile)) throw new Error('console de test non démarrée (10 s)');
    await sleep(200);
    return new TestConsole(Number(readFileSync(pidFile, 'utf8')), title, dir);
  }

  keys(): KeyEvent[] {
    const f = join(this.dir, 'keys.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as KeyEvent);
  }
  typed(): string { return this.keys().map((k) => k.ch).join(''); }

  close(): void {
    try { process.kill(this.pid); } catch { /* déjà fermée */ }
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* fichier encore ouvert */ }
  }
}

function quote(a: string): string { return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a; }

/** Un pid qui n'existe pas (aucun process ne porte un pid impair très grand sous Windows : ils sont multiples de 4). */
export const NO_SUCH_PID = 4_000_001;
