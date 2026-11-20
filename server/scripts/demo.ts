// DEMO PROFILE: starts the server on a fake profile with a handful of made-up sessions, to look around, take
// screenshots or record the README animation. Nothing of your real ~/.claude is read or written: USERPROFILE and
// LOCALAPPDATA point to a temporary folder, and every "session" is the driver in --fake-console mode (a copy named
// claude.exe, the name the server looks for). Ctrl+C stops everything and removes the folder.
//
//   npm run build:driver   (once)
//   npm run demo [-- --port 8851] [--root C:\src]   (--root: an EMPTY folder, so the paths shown look like real ones)
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRIVER_EXE, REPO, TestConsole } from '../test/helpers.ts';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const PORT = Number(arg('--port') ?? 8851);
if (!existsSync(DRIVER_EXE)) { console.error(`Driver not found (${DRIVER_EXE}): run "npm run build:driver" first.`); process.exit(1); }

const t0 = Date.now();
const rootArg = arg('--root');
if (rootArg && existsSync(rootArg) && readdirSync(rootArg).length) { console.error(`--root ${rootArg}: the folder must be empty (it is removed on exit).`); process.exit(1); }
if (rootArg) mkdirSync(rootArg, { recursive: true });
const root = rootArg ? realpathSync.native(rootArg) : realpathSync.native(mkdtempSync(join(tmpdir(), 'sd-demo-')));
const home = join(root, 'home'); const claude = join(home, '.claude'); const lad = join(home, 'AppData', 'Local');
for (const d of ['sessions', 'projects', 'state', 'state\\search-index']) mkdirSync(join(claude, d), { recursive: true });

// Two small git repositories, one branch per piece of work.
const repo = (name: string, branch: string): string => {
  const dir = join(root, name); mkdirSync(dir, { recursive: true });
  const git = (...a: string[]): void => { execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true }); };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'demo@example.com'); git('config', 'user.name', 'demo'); git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`); git('add', '.'); git('commit', '-q', '-m', 'initial commit');
  git('checkout', '-q', '-b', branch); writeFileSync(join(dir, 'CHANGES.md'), 'wip\n');
  return dir;
};
const shop = repo('acme-shop', 'feat/dark-mode');
const api = repo('acme-api', 'fix/search-latency');
const docs = repo('acme-docs', 'docs/release-2.3');

const bin = join(root, 'bin'); cpSync(join(DRIVER_EXE, '..'), bin, { recursive: true });
copyFileSync(DRIVER_EXE, join(bin, 'claude.exe'));
const exe = join(bin, 'claude.exe');

const WORKING = (verb: string, s: number): string => `✻ ${verb}… (${s}s · ↓ 2.1k tokens · esc to interrupt)`;
const DIALOG = ' Bash command\n\n   git push -u origin fix/search-latency\n   Push the branch to open the pull request\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for git push commands\n   3. No, and tell Claude what to do differently';

interface Demo { id: string; cwd: string; title: string; status: 'idle' | 'busy' | 'waiting'; ageMin: number; model: string;
  screen: { mode: 'empty' | 'suggestion'; text?: string; suggestion?: string }; talk: [string, string][]; pr?: number; prompts: string[] }
const id = (n: number): string => `${String(n).repeat(8)}-0000-4000-8000-00000000000${n}`;
const demos: Demo[] = [
  { id: id(1), cwd: api, title: 'Search endpoint is slow on large catalogs', status: 'waiting', ageMin: 1, model: 'claude-opus-5-5',
    screen: { mode: 'empty', text: DIALOG },
    talk: [['/search takes 4 s on the big catalog, find out why and fix it', 'Found it: the category filter runs one query per product (N+1). I replaced it with a single join and added an index on products(category_id).\n\np95 on the seeded catalog: **4.1 s → 180 ms**. Tests pass. Ready to push the branch and open the PR.']],
    prompts: ['/search takes 4 s on the big catalog, find out why and fix it', 'good, push it and open the PR'] },
  { id: id(2), cwd: shop, title: 'Dark mode for the settings page', status: 'idle', ageMin: 3, model: 'claude-opus-5-5',
    screen: { mode: 'suggestion', suggestion: 'merge the PR once the checks are green' },
    talk: [['add a dark mode toggle to the settings page, follow the system theme by default', 'Done. The toggle has three states (system, light, dark) and is saved per user. I also fixed two hard-coded colors in the header that ignored the theme.\n\nPull request **#128** is open, checks are green.']],
    pr: 128, prompts: ['add a dark mode toggle to the settings page, follow the system theme by default', 'open the PR'] },
  { id: id(3), cwd: shop, title: 'Flaky checkout test on CI', status: 'busy', ageMin: 0, model: 'claude-sonnet-5-5',
    screen: { mode: 'empty', text: WORKING('Reproducing', 42) },
    talk: [['the checkout e2e test fails one run out of five on CI, make it reliable', 'Running the test 50 times in a loop to reproduce the failure…']],
    prompts: ['the checkout e2e test fails one run out of five on CI, make it reliable'] },
  { id: id(4), cwd: docs, title: 'Release notes for 2.3', status: 'busy', ageMin: 0, model: 'claude-haiku-5-5',
    screen: { mode: 'empty', text: WORKING('Writing', 17) },
    talk: [['write the release notes for 2.3 from the merged PRs since 2.2', 'Reading the 23 pull requests merged since v2.2…']],
    prompts: ['write the release notes for 2.3 from the merged PRs since 2.2'] },
  { id: id(5), cwd: api, title: 'Upgrade to Node 22', status: 'idle', ageMin: 26, model: 'claude-sonnet-5-5',
    screen: { mode: 'empty' },
    talk: [['upgrade the API to Node 22 and fix whatever breaks', 'Upgraded to Node 22. Two changes were needed: the `url.parse` calls now use `new URL()`, and the test runner config moved to `node:test`. All 412 tests pass.']],
    prompts: ['upgrade the API to Node 22 and fix whatever breaks'] },
];

const consoles: TestConsole[] = [];
const stop = (): void => { for (const c of consoles) c.close(); try { rmSync(root, { recursive: true, force: true }); } catch { /* still open */ } };
process.on('SIGINT', () => { stop(); process.exit(0); });

const slugOf = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');
const jl = (...o: unknown[]): string => o.map((x) => JSON.stringify(x)).join('\n') + '\n';
const at = (minAgo: number): string => new Date(t0 - minAgo * 60000).toISOString();
const history: unknown[] = [];
const prState: Record<string, unknown> = {};

for (const d of demos) {
  const c = await TestConsole.open(d.screen.mode, { exe, ttl: 24 * 3600, noBanner: true, ...(d.screen.text ? { text: d.screen.text } : {}), ...(d.screen.suggestion ? { suggestion: d.screen.suggestion } : {}) });
  consoles.push(c);
  writeFileSync(join(claude, 'sessions', `${c.pid}.json`), JSON.stringify({ pid: c.pid, sessionId: d.id, cwd: d.cwd, startedAt: t0 - 3600000, version: '2.1.327',
    kind: 'interactive', entrypoint: 'cli', status: d.status, statusUpdatedAt: t0 - d.ageMin * 60000, updatedAt: t0,
    ...(d.status === 'waiting' ? { waitingFor: 'permission' } : {}) }));
  const proj = join(claude, 'projects', slugOf(d.cwd)); mkdirSync(proj, { recursive: true });
  const lines: unknown[] = [{ type: 'ai-title', aiTitle: d.title }];
  d.talk.forEach(([u, a], i) => {
    lines.push({ parentUuid: null, type: 'user', cwd: d.cwd, timestamp: at(30 - i), message: { role: 'user', content: u } });
    lines.push({ parentUuid: 'p', type: 'assistant', timestamp: at(d.ageMin), message: { model: d.model, content: [{ type: 'text', text: a }],
      usage: { input_tokens: 12, cache_creation_input_tokens: 4200, cache_read_input_tokens: 38000 + i * 9000, output_tokens: 900 } } });
  });
  if (d.pr) {
    const url = `https://github.com/acme/shop/pull/${d.pr}`;
    lines.push({ type: 'pr-link', prNumber: d.pr, prUrl: url });
    prState[url] = { state: 'OPEN', draft: false, checks: 'ok' };
  }
  writeFileSync(join(proj, `${d.id}.jsonl`), jl(...lines));
  d.prompts.forEach((p, i) => history.push({ display: p, timestamp: t0 - (d.prompts.length - i) * 60000 - d.ageMin * 60000, sessionId: d.id, project: d.cwd }));
}

// One closed session, offered for reopening, found by full-text search ("stripe").
const closed = id(6); const closedProj = join(claude, 'projects', slugOf(shop)); const closedFile = join(closedProj, `${closed}.jsonl`);
writeFileSync(closedFile, jl({ type: 'ai-title', aiTitle: 'Stripe webhook retries' },
  { parentUuid: null, type: 'user', cwd: shop, timestamp: at(180), message: { role: 'user', content: 'Stripe retries the webhook and we create the order twice' } },
  { parentUuid: 'p', type: 'assistant', timestamp: at(170), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The handler is now idempotent: the Stripe event id is stored and a replayed event is acknowledged without side effects.' }] } }));
const h3 = new Date(t0 - 3 * 3600000); utimesSync(closedFile, h3, h3);
const idx = join(claude, 'state', 'search-index');
writeFileSync(join(idx, `${closed}.txt`), `${at(180)}\tuser\tStripe retries the webhook and we create the order twice\r\n${at(170)}\tassistant\tThe handler is now idempotent: the Stripe event id is stored.\r\n`);
writeFileSync(join(idx, `${closed}.norm`), 'stripe retries the webhook and we create the order twice\r\nthe handler is now idempotent: the stripe event id is stored.\r\n');
writeFileSync(join(idx, 'manifest.json'), JSON.stringify({ [closedFile]: { id: closed, offset: 10 } }));

writeFileSync(join(claude, 'history.jsonl'), jl(...history));
writeFileSync(join(claude, 'state', 'sessions-dashboard-pr.json'), JSON.stringify(prState));
writeFileSync(join(claude, 'state', 'sessions-dashboard-favs.json'), JSON.stringify([demos[1]!.id]));
writeFileSync(join(claude, 'state', 'sessions-dashboard-seen.json'), JSON.stringify({ [demos[4]!.id]: t0 }));
// Bandeau d'usage : un relevé au format de la sonde (usage-probe.ts), pour le compte « connecté » de la démo.
const reset = new Date(t0 + 4.2 * 86_400_000).toISOString();
writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'demo-account', emailAddress: 'you@example.com', planDisplayName: 'Max' } }));
writeFileSync(join(root, 'usage.json'), JSON.stringify({ 'demo-account': { alias: 'you@example.com', plan: 'Max', status: 'ok',
  weeklyPct: 41, weeklyResetsAt: reset, weeklyProjectedPct: 78, weeklyFullAt: null, fiveHourPct: 18, fiveHourResetsAt: new Date(t0 + 2 * 3_600_000).toISOString(),
  measuredAt: new Date(t0 - 5 * 60_000).toISOString(), limitsJson: JSON.stringify([
    { kind: 'weekly_all', percent: 41, resets_at: reset, is_active: true, severity: 'normal' },
    { kind: 'weekly_scoped', percent: 63, resets_at: reset, scope: { model: { display_name: 'Opus' } }, is_active: true, severity: 'normal' }]) } }));
writeFileSync(join(root, 'config.json'), JSON.stringify({ modules: { quota: { file: join(root, 'usage.json') } } }));

const env = { ...process.env, USERPROFILE: home, LOCALAPPDATA: lad };
const server = spawn(process.execPath, [join(REPO, 'server', 'src', 'main.ts'), '--port', String(PORT), '--no-background', '--allow-write',
  '--driver', DRIVER_EXE, '--config', join(root, 'config.json'), '--tailscale', ''], { env, stdio: 'inherit', windowsHide: true });
server.on('exit', (code) => { stop(); process.exit(code ?? 0); });
console.log(`Demo profile in ${root}\nOpen http://localhost:${PORT}/ — Ctrl+C to stop.`);
