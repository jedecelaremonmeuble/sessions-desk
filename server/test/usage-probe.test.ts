// Sonde d'usage : lecture de l'écran `/usage`, date de remise, projection, et la sonde elle-même avec un faux
// `claude -p` (aucun vrai Claude Code n'est lancé).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parseModules } from '../src/modules.ts';
import { readClaudeUsage } from '../src/usage.ts';
import { keptLines, parseResets, parseUsageScreen } from '../src/usage-parse.ts';
import { isProbeCwd, probeDir, probeFile, projectWeek, UsageProbe, type RunResult } from '../src/usage-probe.ts';

// Écran réel (Claude Code 2.1.329, 20/11/2026), lignes utiles + une suite factice qui ne doit JAMAIS être gardée.
const SCREEN = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current week (all models): 27% used · resets Nov 25, 6:59pm (Europe/Paris)',
  'Current week (Fable): 28% used · resets Nov 25, 6:59pm (Europe/Paris)',
  '',
  "What's contributing to your usage?",
  '  26%  Trim C:\\secret\\path\\CLAUDE.md · 7k tokens per request',
  '  Top MCP servers: private-server 4%',
].join('\n');
const NOW = Date.parse('2026-11-20T18:00:00Z');
const RESET = Date.parse('2026-11-25T17:59:00Z');   // 18:59 à Paris (UTC+1)

describe('écran /usage', () => {
  test('semaine tous modèles et semaine par modèle, avec la remise dans son fuseau', () => {
    const s = parseUsageScreen(SCREEN, NOW);
    expect(s.subscription).toBe(true);
    expect(s.windows).toEqual([
      { kind: 'weekly_all', model: null, percent: 27, resetsText: 'Nov 25, 6:59pm (Europe/Paris)', resetsAt: RESET },
      { kind: 'weekly_scoped', model: 'Fable', percent: 28, resetsText: 'Nov 25, 6:59pm (Europe/Paris)', resetsAt: RESET },
    ]);
  });
  test('la fenêtre de 5 h (« Current session ») est lue aussi', () => {
    const s = parseUsageScreen('Current session: 12.5% used · resets 9pm (Europe/Paris)', NOW);
    expect(s.windows).toEqual([{ kind: 'five_hour', model: null, percent: 12.5, resetsText: '9pm (Europe/Paris)', resetsAt: Date.parse('2026-11-20T20:00:00Z') }]);
  });
  test('écran inconnu : rien de deviné', () => {
    expect(parseUsageScreen('Something else entirely\n42% of nothing', NOW)).toEqual({ subscription: false, windows: [] });
  });
  test('seules la ligne d’abonnement et les lignes « Current » sont gardées', () => {
    const kept = keptLines(SCREEN).join('\n');
    expect(kept).toContain('Current week (Fable)');
    expect(kept).not.toMatch(/secret|private-server|Trim/);
  });
});

describe('date de remise', () => {
  test('heure seule passée ⇒ demain', () => {
    expect(parseResets('5pm (Europe/Paris)', NOW)).toBe(Date.parse('2026-11-21T16:00:00Z'));
  });
  test('date de janvier vue en décembre ⇒ année suivante', () => {
    expect(parseResets('Jan 2, 10am (UTC)', Date.parse('2026-12-30T12:00:00Z'))).toBe(Date.parse('2027-01-02T10:00:00Z'));
  });
  test('fuseau inconnu ou texte illisible ⇒ null', () => {
    expect(parseResets('Nov 25, 6:59pm (Nowhere/Land)', NOW)).toBeNull();
    expect(parseResets('bientôt', NOW)).toBeNull();
  });
});

describe('projection de la semaine', () => {
  test('rythme depuis la première mesure de la fenêtre', () => {
    const h = [[NOW - 10 * 3_600_000, 17, RESET]];
    const p = projectWeek(h, NOW, 27, RESET);   // +1 %/h, 119,98 h avant la remise
    expect(p.projected).toBe(Math.round(27 + (RESET - NOW) / 3_600_000));
    expect(p.fullAt).toBe(Math.round(NOW + 73 * 3_600_000));
  });
  test('moins d’une heure de recul, ou autre fenêtre : pas de projection', () => {
    expect(projectWeek([[NOW - 60_000, 26, RESET]], NOW, 27, RESET)).toEqual({ projected: null, fullAt: null });
    expect(projectWeek([[NOW - 10 * 3_600_000, 90, RESET - 7 * 86_400_000]], NOW, 27, RESET)).toEqual({ projected: null, fullAt: null });
  });
});

describe('sonde', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
  function setup(account: Record<string, unknown> | null = { accountUuid: 'acct-1', emailAddress: 'me@example.com', planDisplayName: 'Max' }) {
    root = mkdtempSync(join(tmpdir(), 'sd-probe-'));
    const claude = join(root, 'home', '.claude'); mkdirSync(claude, { recursive: true });
    if (account) writeFileSync(join(root, 'home', '.claude.json'), JSON.stringify({ oauthAccount: account }));
    return { localAppData: join(root, 'lad'), claude };
  }
  const reply = (o: Record<string, unknown>): () => Promise<RunResult> => async () => ({ ok: true, stdout: JSON.stringify({ type: 'result', is_error: false, num_turns: 0, total_cost_usd: 0, ...o }) });

  test('mesure écrite au format lu par la page, par compte, sans la suite de l’écran', async () => {
    const cfg = setup();
    const p = new UsageProbe(cfg, reply({ result: SCREEN }), NOW);
    expect(await p.runOnce(NOW)).toEqual({ status: 'ok', uuid: 'acct-1' });
    const raw = readFileSync(probeFile(cfg), 'utf8');
    expect(raw).not.toMatch(/secret|private-server/);
    const [row] = readClaudeUsage({ modules: { quota: { file: probeFile(cfg) } } } as never) as Record<string, unknown>[];
    expect(row).toMatchObject({ uuid: 'acct-1', alias: 'me@example.com', plan: 'Max', status: 'ok', weeklyPct: 27, weeklyResetsAt: RESET, measuredAt: NOW });
    expect(row!.limits).toEqual([
      { kind: 'weekly_all', pct: 27, model: null, resetsAt: RESET, active: true, severity: 'normal' },
      { kind: 'weekly_scoped', pct: 28, model: 'Fable', resetsAt: RESET, active: true, severity: 'normal' },
    ]);
  });

  test('un tour de modèle ou un coût ⇒ arrêt de la sonde, jamais de dépense en boucle', async () => {
    const cfg = setup();
    const p = new UsageProbe(cfg, reply({ num_turns: 1, total_cost_usd: 0.07, result: 'I think you meant /usage' }), NOW);
    expect((await p.runOnce(NOW)).status).toBe('error:model-called');
    expect(p.halted).toBe(true);
    let ran = false; (p as unknown as { maybeRun(n: number): void }).maybeRun(NOW + 3_600_000);
    await Promise.resolve(); ran = p.last?.status !== 'error:model-called'; expect(ran).toBe(false);
  });

  test('échec après une mesure : les valeurs restent (avec leur âge), le statut dit l’échec', async () => {
    const cfg = setup();
    await new UsageProbe(cfg, reply({ result: SCREEN }), NOW).runOnce(NOW);
    const later = NOW + 900_000;
    expect((await new UsageProbe(cfg, async () => ({ ok: false, timedOut: true, stdout: '' }), later).runOnce(later)).status).toBe('error:timeout');
    const j = JSON.parse(readFileSync(probeFile(cfg), 'utf8')) as Record<string, Record<string, unknown>>;
    expect(j['acct-1']).toMatchObject({ status: 'error:timeout', weeklyPct: 27, measuredAt: new Date(NOW).toISOString() });
  });

  test('écran non reconnu ⇒ error:format ; pas d’abonnement ⇒ no-subscription', async () => {
    const cfg = setup();
    expect((await new UsageProbe(cfg, reply({ result: 'You are currently using your subscription\nNew layout 27%' }), NOW).runOnce(NOW)).status).toBe('error:format');
    expect((await new UsageProbe(cfg, reply({ result: 'Usage is billed to your API key' }), NOW).runOnce(NOW)).status).toBe('no-subscription');
  });

  test('compte inconnu (déconnecté) ⇒ rien n’est lancé', async () => {
    const cfg = setup(null);
    let called = false;
    expect((await new UsageProbe(cfg, async () => { called = true; return { ok: true, stdout: '' }; }, NOW).runOnce(NOW)).status).toBe('error:account');
    expect(called).toBe(false);
  });

  test('le dossier de la sonde est reconnu (exclu de la liste)', () => {
    const cfg = { localAppData: 'C:\\Users\\x\\AppData\\Local' };
    expect(isProbeCwd(cfg, probeDir(cfg))).toBe(true);
    expect(isProbeCwd(cfg, probeDir(cfg).toUpperCase())).toBe(true);
    expect(isProbeCwd(cfg, 'C:\\code\\repo')).toBe(false);
  });
});

describe('configuration', () => {
  const env = { home: 'C:\\Users\\x', localAppData: 'C:\\Users\\x\\AppData\\Local', temp: 'C:\\t' };
  test('source usage-probe ⇒ relevé de la sonde', () => {
    expect(parseModules({ modules: { quota: { source: 'usage-probe' } } }, env).quota).toEqual({ file: join(env.localAppData, 'sessions-desk', 'usage-probe.json'), probe: true });
  });
  test('fichier d’un collecteur extérieur : toujours lu', () => {
    expect(parseModules({ modules: { quota: { file: 'C:\\x\\claude-usage.json' } } }, env).quota).toEqual({ file: 'C:\\x\\claude-usage.json' });
  });
});
