// SONDE D'USAGE PAR COMPTE CLAUDE — le relevé du module « quota » sans collecteur extérieur.
//
// Toutes les 15 min, le serveur principal lance `claude -p '/usage'` : c'est l'écran `/usage` de Claude Code lui-même,
// rendu sans appel au modèle (0 tour, 0 $), qui donne la session (5 h), la semaine tous modèles et la semaine PAR
// MODÈLE. Aucun jeton n'est lu ni utilisé : on ne touche ni à `.credentials.json` ni à une adresse d'Anthropic.
//
// Garde-fous :
// - `--setting-sources project --strict-mcp-config` depuis un dossier VIDE et FIXE : aucun réglage de l'utilisateur,
//   donc aucun de ses hooks ni de ses serveurs MCP (3 démarraient sans ce drapeau) ; `--no-session-persistence` :
//   ni transcript ni historique. Le dossier fixe ne laisse qu'UN dossier
//   `projects/<dossier>/memory` vide chez Claude Code ;
// - si Claude Code annonce un tour de modèle ou un coût (une version qui ne reconnaîtrait plus `/usage` y répondrait
//   comme à un message), la sonde S'ARRÊTE jusqu'au redémarrage du serveur : jamais de dépense en boucle ;
// - une sonde à la fois, 60 s au plus ;
// - de l'écran, seules la ligne d'abonnement et les lignes « Current … » sont gardées (la suite cite des chemins
//   locaux, des skills, des serveurs MCP).
//
// Le compte mesuré est celui du profil courant (`oauthAccount` de `.claude.json` : identifiant, email, offre — pas de
// secret). Un autre compte (bascule par /login) garde sa dernière mesure, affichée avec son âge.
// Le relevé est écrit au format que lit déjà `readClaudeUsage` (usage.ts) : la page ne change pas.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config } from './config.ts';
import { keptLines, parseUsageScreen, type UsageWindow } from './usage-parse.ts';
import { mtimeMs, psString, readJson, setContentAtomic, stripBom } from './util.ts';

export const PROBE_EVERY_MS = 15 * 60_000;
export const PROBE_FIRST_MS = 30_000;
export const PROBE_TIMEOUT_MS = 60_000;
const HISTORY_DAYS = 8;

export const probeHome = (cfg: Pick<Config, 'localAppData'>): string => join(cfg.localAppData, 'sessions-desk');
export const probeDir = (cfg: Pick<Config, 'localAppData'>): string => join(probeHome(cfg), 'probe');
export const probeFile = (cfg: Pick<Config, 'localAppData'>): string => join(probeHome(cfg), 'usage-probe.json');
const historyFile = (cfg: Pick<Config, 'localAppData'>): string => join(probeHome(cfg), 'usage-probe-history.json');
const lastScreenFile = (cfg: Pick<Config, 'localAppData'>): string => join(probeHome(cfg), 'usage-probe-last-screen.txt');

/** Le dossier de travail d'une session est-il celui de la sonde ? (elle n'apparaît pas dans la liste) */
export function isProbeCwd(cfg: Pick<Config, 'localAppData'>, cwd: unknown): boolean {
  const c = psString(cwd); if (!c) return false;
  return resolve(c).toLowerCase() === resolve(probeDir(cfg)).toLowerCase();
}

export interface ProbeAccount { uuid: string; email: string; plan: string }
/** Compte du profil courant, d'après `.claude.json` (dossier de configuration, sinon à côté de ~/.claude). */
export function readAccount(cfg: Pick<Config, 'claude'>): ProbeAccount | null {
  const inDir = join(cfg.claude, '.claude.json');
  const f = mtimeMs(inDir) ? inDir : join(dirname(cfg.claude), '.claude.json');
  try {
    const j = JSON.parse(stripBom(readFileSync(f, 'utf8'))) as { oauthAccount?: Record<string, unknown> };
    const a = j.oauthAccount ?? {}; const uuid = psString(a.accountUuid);
    return uuid ? { uuid, email: psString(a.emailAddress), plan: psString(a.planDisplayName) || psString(a.billingType) } : null;
  } catch { return null; }
}

export interface RunResult { ok: boolean; timedOut?: boolean; stdout: string }
export const PROBE_ARGS = ['-p', '/usage', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence'];
/** Lance `claude -p '/usage'` (sans shell : rien ne réécrit « /usage »). */
export function runClaudeUsage(cfg: Pick<Config, 'localAppData'>, exe = 'claude'): Promise<RunResult> {
  const cwd = probeDir(cfg); mkdirSync(cwd, { recursive: true });
  return new Promise((ok) => {
    execFile(exe, PROBE_ARGS, { cwd, timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      ok({ ok: !e, timedOut: !!e?.killed, stdout: String(stdout ?? '') });
    });
  });
}

type Sample = Record<string, unknown>;
type History = Record<string, number[][]>;   // uuid → [[instant, % semaine, remise]…]

const iso = (t: number | null | undefined): string | null => (t ? new Date(t).toISOString() : null);

/**
 * Projection de la semaine à la remise : rythme moyen depuis la première mesure de la fenêtre en cours (même remise),
 * à partir d'une heure de recul. Pure. `fullAt` : quand 100 % serait atteint, s'il l'est avant la remise.
 */
export function projectWeek(hist: number[][], now: number, pct: number | null, reset: number | null): { projected: number | null; fullAt: number | null } {
  if (pct === null || !reset || reset <= now) return { projected: null, fullAt: null };
  const same = hist.filter((h) => h[2] === reset && h[0]! < now);
  const first = same[0];
  if (!first || now - first[0]! < 3_600_000) return { projected: null, fullAt: null };
  const rate = (pct - first[1]!) / (now - first[0]!);
  if (rate <= 0) return { projected: Math.round(pct), fullAt: null };
  const projected = Math.round(pct + rate * (reset - now));
  const fullAt = pct >= 100 ? now : now + (100 - pct) / rate;
  return { projected, fullAt: fullAt < reset ? Math.round(fullAt) : null };
}

/** Relevé d'un compte (format de usage.ts) à partir des fenêtres lues. Pure. */
export function toSample(acct: ProbeAccount, windows: UsageWindow[], now: number, hist: number[][]): Sample {
  const all = windows.find((w) => w.kind === 'weekly_all') ?? null;
  const five = windows.find((w) => w.kind === 'five_hour') ?? null;
  const proj = projectWeek(hist, now, all?.percent ?? null, all?.resetsAt ?? null);
  const limits = windows.filter((w) => w.kind !== 'five_hour').map((w) => ({
    kind: w.kind, percent: w.percent, resets_at: iso(w.resetsAt), resets_text: w.resetsText,
    ...(w.model ? { scope: { model: { display_name: w.model } } } : {}),
    is_active: true, severity: w.percent >= 100 ? 'critical' : 'normal',   // pas d'alerte inventée sous 100 %
  }));
  return {
    alias: acct.email || acct.uuid.slice(0, 8), plan: acct.plan || null, status: 'ok',
    weeklyPct: all?.percent ?? null, weeklyResetsAt: iso(all?.resetsAt), weeklyProjectedPct: proj.projected, weeklyFullAt: iso(proj.fullAt),
    fiveHourPct: five?.percent ?? null, fiveHourResetsAt: iso(five?.resetsAt),
    measuredAt: iso(now), limitsJson: JSON.stringify(limits), source: 'usage-probe',
  };
}

export interface ProbeOutcome { status: string; uuid: string | null }

export class UsageProbe {
  readonly cfg: Pick<Config, 'localAppData' | 'claude'>;
  #run: () => Promise<RunResult>;
  #running = false;
  #next: number;
  #halted = false;
  last: ProbeOutcome | null = null;

  constructor(cfg: Pick<Config, 'localAppData' | 'claude'>, run?: () => Promise<RunResult>, now = Date.now()) {
    this.cfg = cfg; this.#run = run ?? (() => runClaudeUsage(cfg)); this.#next = now + PROBE_FIRST_MS;
  }
  get halted(): boolean { return this.#halted; }

  /** Appelée à chaque tour de la boucle du serveur : lance une sonde quand c'est l'heure (sans l'attendre). */
  maybeRun(now: number): void {
    if (this.#halted || this.#running || now < this.#next) return;
    this.#next = now + PROBE_EVERY_MS;
    void this.runOnce(now).catch(() => undefined);
  }

  async runOnce(now = Date.now()): Promise<ProbeOutcome> {
    if (this.#running) return { status: 'busy', uuid: null };
    this.#running = true;
    try { this.last = await this.#probe(now); return this.last; } finally { this.#running = false; }
  }

  async #probe(now: number): Promise<ProbeOutcome> {
    const acct = readAccount(this.cfg);
    if (!acct) return { status: 'error:account', uuid: null };
    const r = await this.#run();
    if (r.timedOut) return this.#fail(acct, 'error:timeout', now);
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(r.stdout) as Record<string, unknown>; } catch { j = null; }
    if (!j) return this.#fail(acct, r.ok ? 'error:format' : 'error:exit', now);
    // Un tour de modèle ou un coût : `/usage` n'a pas été reconnu ⇒ arrêt jusqu'au redémarrage (jamais de dépense).
    if (Number(j.num_turns) > 0 || Number(j.total_cost_usd) > 0) { this.#halted = true; return this.#fail(acct, 'error:model-called', now); }
    const text = psString(j.result);
    const screen = parseUsageScreen(text, now);
    if (!screen.windows.length) {
      try { mkdirSync(probeHome(this.cfg), { recursive: true }); setContentAtomic(lastScreenFile(this.cfg), keptLines(text).join('\r\n')); } catch { /* best effort */ }
      return this.#fail(acct, screen.subscription ? 'error:format' : 'no-subscription', now);
    }
    const history = this.#history(); const all = screen.windows.find((w) => w.kind === 'weekly_all');
    const mine = (history[acct.uuid] ?? []).filter((h) => h[0]! > now - HISTORY_DAYS * 86_400_000);
    const sample = toSample(acct, screen.windows, now, mine);
    if (all) mine.push([now, all.percent, all.resetsAt ?? 0]);
    history[acct.uuid] = mine;
    this.#write(acct.uuid, sample, history);
    return { status: 'ok', uuid: acct.uuid };
  }

  /** Échec : le relevé du compte garde ses dernières valeurs (et leur âge), son statut dit l'échec. */
  #fail(acct: ProbeAccount, status: string, now: number): ProbeOutcome {
    const cur = this.#current()[acct.uuid] as Sample | undefined;
    this.#write(acct.uuid, { ...(cur ?? { alias: acct.email || acct.uuid.slice(0, 8), plan: acct.plan || null, measuredAt: null }), status, checkedAt: iso(now), source: 'usage-probe' }, null);
    return { status, uuid: acct.uuid };
  }

  #current(): Record<string, unknown> { const j = readJson(probeFile(this.cfg)); return j && typeof j === 'object' ? j as Record<string, unknown> : {}; }
  #history(): History { const j = readJson(historyFile(this.cfg)); return j && typeof j === 'object' ? j as History : {}; }
  #write(uuid: string, sample: Sample, history: History | null): void {
    mkdirSync(probeHome(this.cfg), { recursive: true });
    setContentAtomic(probeFile(this.cfg), JSON.stringify({ ...this.#current(), [uuid]: sample }));
    if (history) setContentAtomic(historyFile(this.cfg), JSON.stringify(history));
  }
}
