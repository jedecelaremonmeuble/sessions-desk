// État git des sessions (Get-GitInfo, -RefreshGitFrom, Start-GitRefresh) et état des PR (-RefreshPrFrom).
// Le .ps1 lançait un process PowerShell à part pour chaque lecture (il ne pouvait pas lancer git pendant une lecture
// d'écran) ; Node, qui ne s'attache jamais à une console, lance git et gh directement, en asynchrone.
import { execFile } from 'node:child_process';
import { setPriority, constants } from 'node:os';
import type { Dashboard, GitInfo } from './state.ts';
import { ieq, Mutex, nowMs, readJson, setContentAtomic } from './util.ts';
import { splitN } from './search.ts';

interface Run { code: number; out: string }
function run(cmd: string, args: string[], timeoutMs = 30000, belowNormal = false): Promise<Run> {
  return new Promise((ok) => {
    const p = execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : -1) : 0;
      ok({ code, out: stdout ?? '' });
    });
    p.stdin?.end();
    if (belowNormal && p.pid) { try { setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* sorti */ } }
  });
}
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l, i, a) => !(l === '' && i === a.length - 1));

/** Get-GitInfo : branche, fichiers non commités, commits non poussés, retard sur master, intégration, dernier commit. */
export async function gitInfo(dir: string): Promise<GitInfo | null> {
  const g = async (...a: string[]): Promise<string[] | null> => { const r = await run('git', ['--no-optional-locks', '-C', dir, ...a], 30000, true); return r.code === 0 ? lines(r.out) : null; };
  const rp = await g('rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir');
  if (!rp || rp.length < 3) return null;
  const info: GitInfo = { at: nowMs(), dir, top: rp[0]!.replace(/\//g, '\\'), worktree: !ieq(rp[1], rp[2]),
    branch: null, upstream: null, ahead: 0, behind: 0, nFiles: 0, files: [], base: null, baseAhead: null, baseBehind: null, merged: false, last: null };
  const files: { k: string; p: string }[] = [];
  for (const l of (await g('status', '--porcelain=v2', '--branch', '--untracked-files=normal')) ?? []) {
    let m: RegExpMatchArray | null;
    if (/^# branch\.head /i.test(l)) info.branch = l.slice(14);
    else if (/^# branch\.upstream /i.test(l)) info.upstream = l.slice(18);
    else if ((m = l.match(/^# branch\.ab \+(\d+) -(\d+)/i))) { info.ahead = Number(m[1]); info.behind = Number(m[2]); }
    else if (l.startsWith('#')) continue;
    else {
      info.nFiles = (info.nFiles ?? 0) + 1;
      if (files.length >= 15) continue;
      const c = l[0];
      const p = c === '1' ? splitN(l, ' ', 9)[8] : c === '2' ? splitN(l, ' ', 10)[9]!.split('\t')[0] : c === 'u' ? splitN(l, ' ', 11)[10] : l.slice(2);
      const xy = c === '?' ? '??' : l.slice(2, 4);
      const k = xy === '??' ? 'nouveau' : c === 'u' ? 'conflit' : /D/i.test(xy) ? 'supprimé' : /R/i.test(xy) ? 'renommé' : /A/i.test(xy) ? 'ajouté' : 'modifié';
      files.push({ k, p: p ?? '' });
    }
  }
  info.files = files;
  const has = async (ref: string): Promise<boolean> => { const r = await g('rev-parse', '--verify', '-q', ref); return !!r && r.length > 0; };
  info.base = (await has('origin/master')) ? 'origin/master' : (await has('origin/main')) ? 'origin/main' : null;
  if (info.base) {
    const ab = ((await g('rev-list', '--left-right', '--count', `${info.base}...HEAD`)) ?? []).join(' ').split(/\s+/);
    if (ab.length >= 2) { info.baseBehind = Number(ab[0]); info.baseAhead = Number(ab[1]); }
    info.merged = (await run('git', ['--no-optional-locks', '-C', dir, 'merge-base', '--is-ancestor', 'HEAD', info.base as string])).code === 0;
  }
  const lc = splitN(((await g('log', '-1', '--format=%h%x09%ct%x09%s')) ?? []).join(' '), '\t', 3);
  if (lc.length === 3) info.last = { h: lc[0], at: Number(lc[1]) * 1000, s: lc[2] };
  return info;
}

const gitLock = new Mutex();
/** Start-GitRefresh : lit les dossiers puis fusionne dans le fichier d'état git (suffixé par port), entrées > 24 h retirées. */
export function startGitRefresh(d: Dashboard, dirs: string[]): Promise<void> {
  const list = [...new Set(dirs.filter(Boolean))].sort();
  if (!list.length) return Promise.resolve();
  return (async () => {
    const mine: Record<string, GitInfo> = {};
    for (const dir of list) { try { const i = await gitInfo(dir); if (i) mine[dir.toLowerCase()] = i; } catch { /* idem */ } }
    await gitLock.run(() => {
      const out = ((readJson(d.gitFile) ?? {}) as Record<string, GitInfo>);
      Object.assign(out, mine);
      const old = nowMs() - 86400000;
      for (const k of Object.keys(out)) if (Number(out[k]!.at) < old) delete out[k];
      setContentAtomic(d.gitFile, JSON.stringify(out), `${d.gitFile}.${process.pid}.tmp`);
    });
  })();
}

/** -RefreshPrFrom : état des PR par gh (~0,6 s chacune), à la suite ; état définitif (MERGED, CLOSED) jamais redemandé. */
export async function refreshPrs(d: Dashboard, urls: string[]): Promise<void> {
  const out = ((readJson(d.prFile) ?? {}) as Record<string, Record<string, unknown>>);
  for (const u of urls) {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(u)) continue;
    const st = String(out[u]?.state ?? '').toUpperCase();
    if (st === 'MERGED' || st === 'CLOSED') continue;
    const r = await run('gh', ['pr', 'view', u, '--json', 'state,isDraft,statusCheckRollup'], 60000);
    if (r.code !== 0 || !r.out) continue;
    let j: { state?: string; isDraft?: boolean; statusCheckRollup?: { conclusion?: string; status?: string; state?: string }[] };
    try { j = JSON.parse(r.out); } catch { continue; }
    const c = (j.statusCheckRollup ?? []).map((x) => x.conclusion || x.status || x.state || null).map((x) => String(x ?? '').toUpperCase());
    const checks = c.some((x) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(x)) ? 'ko'
      : c.some((x) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING'].includes(x)) ? 'pending' : c.includes('SUCCESS') ? 'ok' : null;
    out[u] = { state: j.state ?? null, draft: Boolean(j.isDraft), checks };
  }
  setContentAtomic(d.prFile, JSON.stringify(out));
}

export { run };
