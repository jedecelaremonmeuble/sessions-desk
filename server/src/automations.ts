// MODULE « automations » — les passes des scripts planifiés du poste (ménage, rapports, purges…), lues dans
// l'historique JSONL que chacun tient. Déclarés dans la configuration du poste (modules.ts, AutomationDef) : le code
// ne connaît aucun automate.
//
// CONTRAT. Chaque ligne d'historique porte une clé `pass`, au même format pour tous les automates :
//   {"pass": {"v": 1, "status": "ok", "level": "ok", "summary": "…", "startedAt": "2026-11-20T08:00:16Z",
//             "minutes": 2.4, "runDir": "C:\\…\\runs\\20261120-080001", "sessionId": "…", "costUsd": 2.48,
//             "files": ["recap.md"], "quiet": false, "dryRun": false}}
// - status : ok (la passe a agi), nothing (rien à faire), dry-run, conflict, rejected, failed ;
// - level  : santé de la PASSE (ok, warn, error), pas celle de ce qu'elle surveille ; la page notifie sur error ;
// - quiet  : passe sans effet ni problème, résumée dans l'en-tête du groupe au lieu d'une ligne ;
// - files  : noms de fichiers présents dans runDir, les seuls que GET /api/automations/file accepte de servir.
// Le reste de la ligne appartient à l'automate et n'est pas lu. Une ligne sans `pass` compte comme une passe
// silencieuse « issue inconnue ».
//
// PASSE EN COURS. Une session `claude -p` dont la ligne de commande cite un dossier sous `runs` est la passe en cours
// de cet automate : la page l'affiche dans son groupe (conversation en direct) et la retire de la liste des sessions.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { AutomationDef } from './modules.ts';
import type { Dashboard } from './state.ts';
import { nowMs } from './util.ts';
import { T } from './i18n.ts';

const STATUSES = new Set(['ok', 'nothing', 'dry-run', 'conflict', 'rejected', 'failed']);
const LEVELS = new Set(['ok', 'warn', 'error']);
const DAY = 24 * 3600e3;
/** Historique gardé en mémoire : 8 jours (la carte compte sur 7). */
export const KEEP_MS = 8 * DAY;
const CHUNK = 1024 * 1024;
const MAX_FILE = 5 * 1024 * 1024;
/** Passes du jour renvoyées au plus par automate (les plus récentes). */
const MAX_PASSES = 100;

export interface Pass {
  run: string;                  // identifiant de la passe : nom de son dossier, à défaut son heure de début
  at: number;                   // début (ms)
  status: string; level: string; summary: string;
  minutes: number | null; costUsd: number | null; sessionId: string | null;
  files: string[]; quiet: boolean; dryRun: boolean;
  runDir: string | null;        // gardé côté serveur (fichiers) ; jamais envoyé à la page
}
export interface RunningPass { run: string; runDir: string; sessionId: string; pid: number; at: number }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const SID = /^[0-9a-f-]{36}$/i;

/** Une ligne d'historique → passe ; null si elle n'est pas datée (illisible ou sans heure de début). Pure. */
export function passOf(line: unknown): Pass | null {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
  const l = line as Record<string, unknown>;
  const p = l.pass && typeof l.pass === 'object' && !Array.isArray(l.pass) ? l.pass as Record<string, unknown> : null;
  const started = str(p?.startedAt) ?? str(l.startedAt) ?? str(l.at);
  const at = started ? Date.parse(started) : NaN;
  if (!Number.isFinite(at)) return null;
  if (!p) return { run: started!, at, status: 'unknown', level: 'ok', summary: 'issue inconnue (ligne sans clé « pass »)', minutes: null, costUsd: null, sessionId: null, files: [], quiet: true, dryRun: false, runDir: null };
  const runDir = str(p.runDir);
  const status = typeof p.status === 'string' && STATUSES.has(p.status) ? p.status : 'unknown';
  const level = typeof p.level === 'string' && LEVELS.has(p.level) ? p.level : status === 'failed' || status === 'rejected' ? 'error' : 'ok';
  const files = Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string' && plainName(f)).slice(0, 30) : [];
  const sessionId = str(p.sessionId);
  return {
    run: runDir ? basename(runDir) : started!, at, status, level,
    summary: typeof p.summary === 'string' && p.summary.trim() ? p.summary.trim().slice(0, 300) : status === 'unknown' ? 'issue inconnue' : status,
    minutes: num(p.minutes), costUsd: num(p.costUsd), sessionId: sessionId && SID.test(sessionId) ? sessionId.toLowerCase() : null,
    files, quiet: p.quiet === true, dryRun: p.dryRun === true, runDir,
  };
}
/** Un nom de fichier seul : ni séparateur, ni « . » / « .. », ni lecteur. */
export const plainName = (n: string): boolean => n.length > 0 && n.length <= 120 && !/[\\/:\0]/.test(n) && n !== '.' && n !== '..';

/**
 * Fin d'un historique JSONL, tenue à jour sans le relire : au premier passage, lecture DEPUIS LA FIN jusqu'aux lignes
 * plus vieilles que `keepMs` (un historique peut peser des dizaines de Mo) ; ensuite, seulement les octets ajoutés.
 * Fichier raccourci ou remplacé ⇒ relu. Une dernière ligne sans saut de ligne est en cours d'écriture : lue au
 * passage suivant.
 */
export class HistoryTail {
  readonly file: string;
  readonly keepMs: number;
  passes: Pass[] = [];
  #size = -1; #mtime = 0; #offset = 0; #ino = 0;

  constructor(file: string, keepMs = KEEP_MS) { this.file = file; this.keepMs = keepMs; }

  get present(): boolean { return this.#size >= 0; }

  refresh(now = nowMs()): void {
    let st;
    try { st = statSync(this.file); } catch { this.passes = []; this.#size = -1; this.#offset = 0; return; }
    if (st.size === this.#size && st.mtimeMs === this.#mtime && st.ino === this.#ino) { this.#prune(now); return; }
    try {
      if (this.#size < 0 || st.size < this.#offset || st.ino !== this.#ino || st.size - this.#offset > 64 * CHUNK) this.#scan(st.size, now);
      else this.#append(st.size);
      this.#size = st.size; this.#mtime = st.mtimeMs; this.#ino = st.ino;
    } catch { /* illisible à cet instant (écriture en cours) : relu au passage suivant */ }
    this.#prune(now);
  }

  #prune(now: number): void {
    const cut = now - this.keepMs;
    if (this.passes.length && this.passes[0]!.at < cut) this.passes = this.passes.filter((p) => p.at >= cut);
  }

  #scan(size: number, now: number): void {
    const cut = now - this.keepMs;
    const fd = openSync(this.file, 'r');
    try {
      const found: Pass[] = [];               // du plus récent au plus ancien
      let pos = size; let rest = Buffer.alloc(0); let end = -1; let done = false;
      while (pos > 0 && !done) {
        const n = Math.min(CHUNK, pos); pos -= n;
        const b = Buffer.alloc(n); readSync(fd, b, 0, n, pos);
        let buf = rest.length ? Buffer.concat([b, rest]) : b;
        if (end < 0) {                        // fin des lignes complètes : là où reprendra la lecture suivante
          const k = buf.lastIndexOf(10);
          if (k < 0) { rest = buf; continue; }
          end = pos + k + 1; buf = buf.subarray(0, k + 1);
        }
        let start = 0;
        if (pos > 0) { const k = buf.indexOf(10); if (k < 0) { rest = buf; continue; } start = k + 1; }
        rest = buf.subarray(0, start);
        const lines = buf.subarray(start).toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const p = parseLine(lines[i]!); if (!p) continue;
          if (p.at < cut) { done = true; break; }
          found.push(p);
        }
      }
      this.passes = found.reverse();
      this.#offset = end < 0 ? 0 : end;
    } finally { closeSync(fd); }
  }

  #append(size: number): void {
    if (size <= this.#offset) return;
    const fd = openSync(this.file, 'r');
    try {
      const b = Buffer.alloc(size - this.#offset); readSync(fd, b, 0, b.length, this.#offset);
      const k = b.lastIndexOf(10); if (k < 0) return;
      for (const l of b.subarray(0, k).toString('utf8').split('\n')) { const p = parseLine(l); if (p) this.passes.push(p); }
      this.#offset += k + 1;
    } finally { closeSync(fd); }
  }
}
function parseLine(l: string): Pass | null {
  const t = l.trim(); if (!t) return null;
  try { return passOf(JSON.parse(t)); } catch { return null; }
}

/**
 * Passes EN COURS : une session sans terminal (`claude -p`) dont la ligne de commande cite un dossier sous le `runs`
 * d'un automate (« --add-dir C:\…\runs\20261120-080001 »). Pure : sessions et lignes de commande sont données.
 */
export function runningPasses(defs: AutomationDef[], sessions: { pid: number; sessionId: string; headless: boolean; startedAt?: unknown }[],
  commandLines: Map<number, string>): Map<string, RunningPass> {
  const out = new Map<string, RunningPass>();
  for (const s of sessions) {
    if (!s.headless) continue;
    const cl = commandLines.get(Number(s.pid)); if (!cl) continue;
    const low = cl.replace(/\//g, '\\').toLowerCase();
    for (const d of defs) {
      if (!d.runs || out.has(d.id)) continue;
      const root = d.runs.replace(/[\\/]+$/, '').toLowerCase() + '\\';
      const k = low.indexOf(root); if (k < 0) continue;
      const m = /^[^\\"'\s]+/.exec(cl.replace(/\//g, '\\').slice(k + root.length)); if (!m || !plainName(m[0])) continue;
      const started = typeof s.startedAt === 'number' ? s.startedAt : Date.parse(String(s.startedAt ?? ''));
      out.set(d.id, { run: m[0], runDir: join(d.runs, m[0]), sessionId: String(s.sessionId), pid: Number(s.pid), at: Number.isFinite(started) ? started : nowMs() });
    }
  }
  return out;
}

/**
 * Passes qui méritent une notification parmi celles commencées après `after` (dans l'ordre) : toute passe en
 * `error`, et la deuxième `warn` d'affilée (une seule fois, jusqu'à ce que ça se rétablisse). Pure.
 */
export function passAlerts(passes: Pass[], after: number): Pass[] {
  const out: Pass[] = [];
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i]!; if (p.at <= after) continue;
    if (p.level === 'error') out.push(p);
    else if (p.level === 'warn' && i >= 1 && passes[i - 1]!.level === 'warn' && (i < 2 || passes[i - 2]!.level !== 'warn')) out.push(p);
  }
  return out;
}

/** Ce que la page reçoit d'une passe : jamais le chemin de son dossier. */
const passView = (p: Pass): Omit<Pass, 'runDir'> & { hasDir: boolean } => {
  const { runDir: dir, ...v } = p; return { ...v, hasDir: !!dir };
};

/**
 * Prochaine passe d'une tâche planifiée toutes les `everyMinutes` : à l'heure HABITUELLE des passes de la semaine
 * (décalage dans la période le plus fréquent, à la minute), pas une période après la dernière passe — une passe
 * lancée à la main décalerait tout. Pure.
 */
export function nextPass(passes: Pass[], everyMinutes: number | null, now: number): number | null {
  if (!everyMinutes || !passes.length) return null;
  const period = everyMinutes * 60000; const count = new Map<number, number>();
  for (const p of passes) { const k = Math.round((p.at % period) / 60000) % everyMinutes; count.set(k, (count.get(k) ?? 0) + 1); }
  let best = 0, n = -1;
  for (const [k, c] of count) if (c > n || (c === n && k < best)) { best = k; n = c; }
  let next = Math.floor(now / period) * period + best * 60000;
  if (next <= now) next += period;
  return next;
}

/** Vue d'un automate (GET /api/automations). Pure : historique et passe en cours sont donnés. */
export function automationView(d: AutomationDef, passes: Pass[], present: boolean, running: RunningPass | null, since: number, now: number) {
  const today = passes.filter((p) => p.at >= since);
  const loud = today.filter((p) => !p.quiet && !(running && p.run === running.run));
  const week = passes.filter((p) => p.at >= now - 7 * DAY);
  const costs = week.filter((p) => p.costUsd !== null);
  const last = passes.length ? passes[passes.length - 1]! : null;
  const fails = week.filter((p) => p.level === 'error');
  return {
    id: d.id, label: d.label, icon: d.icon, everyMinutes: d.everyMinutes, present, files: !!d.runs,
    orders: d.orders.map((o) => ({ id: o.id, label: o.label, confirm: o.confirm })),
    running: running ? { run: running.run, sessionId: running.sessionId, pid: running.pid, at: running.at } : null,
    passes: loud.slice(-MAX_PASSES).reverse().map(passView),
    quietToday: today.length - loud.length,
    last: last ? passView(last) : null,
    next: nextPass(week, d.everyMinutes, now),
    // Aucune passe depuis une fois et demie la période (+ 2 min) : la tâche planifiée ne tourne plus ?
    late: !!(d.everyMinutes && !running && (!last || now - last.at > d.everyMinutes * 90000 + 120000)) && present,
    week: {
      count: week.length, failures: fails.length, warnings: week.filter((p) => p.level === 'warn').length,
      costUsd: costs.length ? Math.round(costs.reduce((s, p) => s + p.costUsd!, 0) * 100) / 100 : null,
      costAvg: costs.length ? Math.round(costs.reduce((s, p) => s + p.costUsd!, 0) / costs.length * 100) / 100 : null,
      lastFailure: fails.length ? passView(fails[fails.length - 1]!) : null,
    },
  };
}

const FILE_TYPES: Record<string, string> = { '.png': 'image/png' };

export class Automations {
  readonly d: Dashboard;
  readonly defs: AutomationDef[];
  #tails = new Map<string, HistoryTail>();
  #cmd: { at: number; map: Map<number, string> } = { at: 0, map: new Map() };
  #alertFrom = new Map<string, number>();

  constructor(d: Dashboard) {
    this.d = d; this.defs = d.cfg.modules.automations;
    for (const a of this.defs) this.#tails.set(a.id, new HistoryTail(a.history));
  }
  get enabled(): boolean { return this.defs.length > 0; }

  #tail(id: string): HistoryTail { const t = this.#tails.get(id)!; t.refresh(); return t; }

  /** Lignes de commande des `claude` en cours, relues au plus toutes les 10 s et seulement s'il y a un automate. */
  async #commandLines(sessions: { headless: boolean }[]): Promise<Map<number, string>> {
    if (!sessions.some((s) => s.headless)) return new Map();
    if (nowMs() - this.#cmd.at < 10000) return this.#cmd.map;
    try {
      const list = await this.d.driver.call('procs', { name: 'claude', commandLine: true }) as { pid: number; commandLine: string | null }[];
      this.#cmd = { at: nowMs(), map: new Map(list.filter((p) => p.commandLine).map((p) => [p.pid, p.commandLine!])) };
    } catch { this.#cmd = { at: nowMs(), map: new Map() }; }
    return this.#cmd.map;
  }
  async running(sessions?: { pid: number; sessionId: string; headless: boolean; startedAt?: unknown }[]): Promise<Map<string, RunningPass>> {
    const open = sessions ?? await this.d.openSessions();
    return runningPasses(this.defs, open, await this.#commandLines(open));
  }

  async view(since: number): Promise<unknown> {
    const now = nowMs(); const run = await this.running();
    return { now, since, automations: this.defs.map((a) => { const t = this.#tail(a.id); return automationView(a, t.passes, t.present, run.get(a.id) ?? null, since, now); }) };
  }

  /** Un fichier annoncé par une passe (`files`), dans SON dossier, lui-même sous le `runs` déclaré. */
  file(id: string, run: string, name: string): { status: number; type?: string; body?: Buffer } {
    if (!plainName(name) || isAbsolute(name)) return { status: 403 };
    const a = this.defs.find((x) => x.id === id); if (!a || !a.runs) return { status: 404 };
    const p = this.#tail(id).passes.find((x) => x.run === run); if (!p || !p.runDir || !p.files.includes(name)) return { status: 404 };
    const root = resolve(a.runs); const dir = resolve(p.runDir);
    if (!(dir.toLowerCase() + sep).startsWith(root.toLowerCase() + sep) || dir.toLowerCase() === root.toLowerCase()) return { status: 403 };
    const f = join(dir, name);
    try {
      if (statSync(f).size > MAX_FILE) return { status: 413 };
      return { status: 200, type: FILE_TYPES[extname(name).toLowerCase()] ?? 'text/plain; charset=utf-8', body: readFileSync(f) };
    } catch { return { status: 404 }; }
  }

  /** « Lancer maintenant » : `python <cli> <args>` détaché, sortie dans un journal du dossier temporaire. Réponse
   *  après 1,5 s au plus : la commande tourne encore, a fini, ou s'est arrêtée en erreur (verrou d'une passe en cours…). */
  async order(id: string, orderId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const a = this.defs.find((x) => x.id === id); const o = a?.orders.find((x) => x.id === orderId);
    if (!a || !o) return { status: 400, body: { error: T('ordre inconnu', 'unknown order') } };
    const log = join(this.d.cfg.temp, `sessions-desk-automation-${a.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    let fd: number;
    try { fd = openSync(log, 'a'); } catch (e) { return { status: 500, body: { error: T(`journal impossible : ${(e as Error).message}`, `could not open the log: ${(e as Error).message}`) } }; }
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
    const exit = await new Promise<{ code: number | null; error?: string }>((ok) => {
      let child;
      try { child = spawn(a.python, [a.cli, ...o.args], { cwd: dirname(a.cli), detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env }); }
      catch (e) { ok({ code: null, error: (e as Error).message }); return; }
      const t = setTimeout(() => { child.unref(); ok({ code: null }); }, 1500);
      child.once('error', (e) => { clearTimeout(t); ok({ code: null, error: e.message }); });
      child.once('exit', (code) => { clearTimeout(t); ok({ code: code ?? -1 }); });
    });
    try { closeSync(fd); } catch { /* idem */ }
    this.#cmd.at = 0;                          // la passe lancée doit apparaître sans attendre 10 s
    if (exit.error) return { status: 500, body: { error: T(`lancement impossible : ${exit.error}`, `could not start: ${exit.error}`) } };
    if (exit.code === null) return { status: 200, body: { started: true } };
    const last = lastLine(log);
    if (exit.code !== 0) return { status: 409, body: { error: T(`la commande s'est arrêtée (code ${exit.code})${last ? ' : ' + last : ''}`, `the command stopped (code ${exit.code})${last ? ': ' + last : ''}`), code: exit.code } };
    return { status: 200, body: { done: true, output: last } };
  }

  /** Notifications (échecs) : passes ajoutées depuis le dernier passage. Le premier passage ne fait que se caler. */
  alerts(): { def: AutomationDef; pass: Pass }[] {
    const out: { def: AutomationDef; pass: Pass }[] = [];
    for (const a of this.defs) {
      const passes = this.#tail(a.id).passes; const lastAt = passes.length ? passes[passes.length - 1]!.at : 0;
      const from = this.#alertFrom.get(a.id);
      if (from !== undefined) for (const p of passAlerts(passes, from)) out.push({ def: a, pass: p });
      this.#alertFrom.set(a.id, Math.max(from ?? 0, lastAt));
    }
    return out;
  }
}

function lastLine(file: string): string {
  try {
    const t = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return (t[t.length - 1] ?? '').slice(0, 300);
  } catch { return ''; }
}
