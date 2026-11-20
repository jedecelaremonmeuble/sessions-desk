// ACTIONS — portage de Invoke-Send, Invoke-Keys, Invoke-Focus, Invoke-Close, Invoke-CloseMany, Invoke-Relaunch,
// Invoke-Reopen, Invoke-ReopenMany, Invoke-New, Invoke-SendMany, Test-Closable. Mêmes garde-fous, mêmes messages.
// Elles passent toutes par la FILE unique (voir http.ts) : une à la fois, comme la boucle PowerShell.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './gitpr.ts';
import { isRelance } from './quiet.ts';
import { checkTag, type Dashboard, type Session } from './state.ts';
import { addContent, GUID, ieq, isDir, netTrim, nowMs, psArray, psIntZero, psString, sleep } from './util.ts';

const KEY_NAMES = ['Enter', 'Esc', 'Up', 'Down', 'Left', 'Right', 'Tab', 'ShiftTab', 'Space', 'Backspace'];
const NOT_EMPTY = "l'invite de la session n'est pas vide (brouillon, menu ou dialogue ouvert)";
/** « ; » sépare les commandes de wt.exe, même entre guillemets : un dossier qui en contient couperait la ligne en deux
 *  commandes. Ouvrir, rouvrir ou relancer une session dans un tel dossier est refusé. */
export const SEMICOLON_REFUSED = 'dossier refusé : son chemin contient « ; », que Windows Terminal lirait comme une seconde commande';

/** Nettoyage d'une ligne envoyée : ni saut de ligne, ni tabulation, ni caractère de contrôle. */
export function cleanLine(text: string): string { return text.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''); }

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
async function waitExit(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (!alive(pid)) return true; await sleep(100); }
  return !alive(pid);
}
function kill(pid: number): void { try { process.kill(pid, 'SIGKILL'); } catch { /* déjà mort */ } }

export class Actions {
  readonly d: Dashboard;
  constructor(d: Dashboard) { this.d = d; }
  get sentLog(): string { return this.d.sf('sessions-dashboard-sent.jsonl'); }
  async session(pid: number): Promise<Session | undefined> { return (await this.d.openSessions()).find((s) => Number(s.pid) === pid); }

  /** Invoke-Focus */
  async focus(pid: number): Promise<number> {
    let code = 2;
    try { code = await this.d.driver.call('focus', { pid }); } catch { /* pilote injoignable */ }
    const s = await this.session(pid);
    this.d.setSeen(s ? [s.sessionId] : []);
    return code;
  }

  /** Invoke-Send : session inactive, invite vide, une ligne ≤ 4 000 caractères, journalisé.
   *  Proposition COUPÉE à l'écran (elle finit par « … », Claude Code la tronque à la largeur du terminal) : son texte
   *  complet n'est lisible nulle part, on ne peut donc pas le taper. Elle est acceptée dans le terminal — Tab, puis
   *  Entrée — après la même revérification : ce qui est à l'écran est encore exactement ce que la page a montré.
   *  allowBusy : MESSAGE EN FILE — une session au travail garde son invite vide et active ; Claude Code met en file
   *  ce qu'on y tape. Réponse à une session seulement (ni message groupé, ni proposition). */
  async send(pid: number, text: string, suggested = false, allowBusy = false): Promise<string | null> {
    const line = netTrim(cleanLine(text));
    if (!line) return 'message vide';
    if (line.length > 4000) return 'message trop long (4 000 caractères au plus)';
    const sess = await this.session(pid);
    if (!sess) return 'session introuvable';
    const queued = allowBusy && !suggested && ieq(sess.status, 'busy');
    if (!ieq(sess.status, 'idle') && !ieq(sess.status, 'shell') && !queued) return `la session n'est pas inactive (statut ${psString(sess.status)})`;
    if (suggested) {
      let cur: string | null = null;
      try { cur = await this.d.driver.call('suggestion', { pid }); } catch { /* idem */ }
      if (!cur) return "plus de proposition à l'écran";
      if (cur !== line) return "la proposition a changé à l'écran";
    }
    const cut = suggested && line.endsWith('…');
    let code = 2;
    try { code = cut ? await this.d.driver.call('sendKeys', { pid, items: ['\u0001Tab', '\u0001Enter'] }) : await this.d.driver.call('send', { pid, line }); } catch { /* inaccessible */ }
    addContent(this.sentLog, JSON.stringify({ at: nowMs(), pid, sessionId: sess.sessionId, title: sess.title, code, text: line, suggested, queued, ...(cut ? { cut: true } : {}) }));
    // Une relance du veilleur n'est pas toi : elle ne marque pas « vue » une réponse que tu n'as pas encore lue.
    if (code === 0) { if (!isRelance(line)) this.d.setSeen([sess.sessionId]); return null; }
    return code === 5 ? NOT_EMPTY : 'console de la session inaccessible';
  }

  /** Invoke-Keys : réponse à un dialogue d'une session qui ATTEND ; l'option visée est relue à l'écran juste avant. */
  async keys(pid: number, keys: unknown, expect: string): Promise<string | null> {
    const items: string[] = []; let len = 0;
    for (const raw of psArray(keys)) {
      const k = (raw && typeof raw === 'object' ? raw : {}) as { k?: unknown; t?: unknown };
      if (k.k) { const name = psString(k.k); if (!KEY_NAMES.includes(name)) return 'touche inconnue'; items.push('\u0001' + name); }
      else if (k.t !== null && k.t !== undefined) { const t = cleanLine(psString(k.t)); if (t) { items.push(t); len += t.length; } }
    }
    if (!items.length) return 'rien à envoyer';
    if (items.length > 20 || len > 4000) return 'trop de touches ou texte trop long';
    const sess = await this.session(pid);
    if (!sess) return 'session introuvable';
    if (!ieq(sess.status, 'waiting')) return `la session n'attend plus de réponse (statut ${psString(sess.status)})`;
    if (expect) {
      let scr: string | null = null;
      try { scr = await this.d.driver.call('read', { pid }); } catch { /* idem */ }
      if (!scr || !scr.includes(expect)) return `le dialogue a changé : « ${expect} » n'est plus à l'écran`;
    }
    let code = 2;
    try { code = await this.d.driver.call('sendKeys', { pid, items }); } catch { /* idem */ }
    addContent(this.sentLog, JSON.stringify({ at: nowMs(), pid, sessionId: sess.sessionId, title: sess.title, code, keys: items.map((x) => x.replaceAll('\u0001', '#')), expect }));
    if (code === 0) { this.d.setSeen([sess.sessionId]); return null; }
    return code === 3 ? 'touche inconnue' : 'console de la session inaccessible';
  }

  /** Invoke-Close : /exit si inactive (arrêt du process s'il ne sort pas en 10 s) ; sinon needForce, puis arrêt sur force. */
  async close(pid: number, force: boolean): Promise<Record<string, unknown>> {
    const sess = await this.session(pid);
    if (!sess) return { error: 'session introuvable' };
    if (!alive(pid)) return { error: 'process introuvable' };
    if (!force) {
      if (!ieq(sess.status, 'idle')) return { error: `la session travaille (statut ${psString(sess.status)})`, needForce: true };
      let code = 2; try { code = await this.d.driver.call('send', { pid, line: '/exit' }); } catch { /* idem */ }
      if (code === 5) return { error: NOT_EMPTY, needForce: true };
      force = !(code === 0 && await waitExit(pid, 10000));
    }
    if (force) { kill(pid); if (!await waitExit(pid, 5000)) return { error: "le process n'a pas pu être arrêté" }; }
    try { rmSync(join(this.d.sessionsDir, `${pid}.json`), { force: true }); } catch { /* idem */ }
    this.d.openSeen.delete(psString(sess.sessionId));
    addContent(this.sentLog, JSON.stringify({ at: nowMs(), pid, sessionId: sess.sessionId, title: sess.title, forced: force, text: '(fermeture)' }));
    return { error: null, forced: force };
  }

  /** Test-Closable : même règle que la page (closable dans app.js). */
  static closable(s: Session): boolean {
    const g = s.git; const merged = !!s.prInfo && ieq(psString(s.prInfo.state), 'MERGED');
    if (!ieq(s.status, 'idle') || !g) return false;
    if (!g.worktree) return merged;
    if ((Number(g.nFiles) || 0) > 0 || (g.upstream && (Number(g.ahead) || 0) > 0)) return false;
    return merged || !!(g.upstream && g.merged);
  }
  /** Invoke-CloseMany */
  /** Invoke-CloseMany — rule 'idle' : seul « inactive » est revérifié (ménage large) ; sinon Test-Closable. */
  async closeMany(pids: unknown, rule = 'closable'): Promise<Record<string, unknown>> {
    const all = await this.d.openSessions(); const closed: unknown[] = []; const skipped: unknown[] = [];
    for (const p of psArray(pids).slice(0, 60)) {
      const id = psIntZero(p);
      const s = all.find((x) => Number(x.pid) === id);
      if (!s) continue;
      if (rule === 'idle') { if (!ieq(s.status, 'idle')) { skipped.push({ title: s.title, why: `n'est plus inactive (statut ${psString(s.status)})` }); continue; } }
      else if (!Actions.closable(s)) { skipped.push({ title: s.title, why: 'ne peut plus se fermer (état changé)' }); continue; }
      const r = await this.close(Number(s.pid), false);
      if (r.error) skipped.push({ title: s.title, why: r.error }); else closed.push({ title: s.title, forced: Boolean(r.forced) });
    }
    return { closed, skipped };
  }

  /** Invoke-Relaunch */
  async relaunch(pid: number): Promise<string | null> {
    const sess = await this.session(pid);
    if (!sess) return 'session introuvable';
    if (!ieq(sess.status, 'idle')) return `la session n'est pas inactive (statut ${psString(sess.status)})`;
    const m = this.d.meta(sess.sessionId);
    if (!m.path) return 'aucun transcript : la session ne pourrait pas être reprise';
    if (!m.cwd || !isDir(m.cwd)) return 'dossier de lancement introuvable';
    if (m.cwd.includes(';')) return SEMICOLON_REFUSED;      // AVANT de fermer : la session ne pourrait pas être rouverte
    const was = alive(pid);
    let code = 2; try { code = await this.d.driver.call('send', { pid, line: '/exit' }); } catch { /* idem */ }
    if (code === 5) return NOT_EMPTY;
    if (was && (code !== 0 || !await waitExit(pid, 15000))) { kill(pid); if (!await waitExit(pid, 5000)) return "le process n'a pas pu être arrêté"; }
    try { rmSync(join(this.d.sessionsDir, `${pid}.json`), { force: true }); } catch { /* idem */ }
    return this.reopen(sess.sessionId);
  }

  resumeTab(id: string, cwd: string): string { return `nt -d "${cwd}" pwsh -NoExit -Command "claude ${this.d.cfg.claudeArgs} --resume ${id}"`; }
  async wt(args: string): Promise<void> { await this.d.driver.call('wt', { args }); }

  /** Invoke-Reopen : nouvel onglet de la fenêtre Windows Terminal la plus récente. */
  async reopen(id: string): Promise<string | null> {
    if (!GUID.test(id)) return 'identifiant invalide';
    if ((await this.d.openSessions()).some((s) => s.sessionId === id)) return 'session déjà ouverte';
    const m = this.d.meta(id);
    if (!m.path) return 'transcript introuvable';
    if (!m.cwd || !isDir(m.cwd)) return 'dossier de lancement introuvable';
    if (m.cwd.includes(';')) return SEMICOLON_REFUSED;
    await this.wt(`-w 0 ${this.resumeTab(id, m.cwd)}`);
    return null;
  }
  /** Invoke-ReopenMany : UN seul appel à Windows Terminal, un onglet par session. */
  async reopenMany(ids: unknown): Promise<Record<string, unknown>> {
    const open = new Set((await this.d.openSessions()).map((s) => s.sessionId));
    const tabs: string[] = []; let skipped = 0;
    for (const raw of psArray(ids).slice(0, 40)) {
      const id = psString(raw);
      if (!GUID.test(id) || open.has(id)) { skipped++; continue; }
      const m = this.d.meta(id);
      if (!m.path || !m.cwd || !isDir(m.cwd) || m.cwd.includes(';')) { skipped++; continue; }
      tabs.push(this.resumeTab(id, m.cwd));
    }
    if (!tabs.length) return { error: 'aucune session à rouvrir', opened: 0, skipped };
    await this.wt('-w 0 ' + tabs.join(' ; '));
    return { error: null, opened: tabs.length, skipped };
  }

  /** Invoke-SendMany */
  async sendMany(pids: unknown, text: string): Promise<Record<string, unknown>> {
    const results: unknown[] = [];
    for (const p of psArray(pids).slice(0, 40)) {
      const id = psIntZero(p); if (!id) continue;
      const t = (await this.session(id))?.title ?? null;
      results.push({ pid: id, title: t, error: await this.send(id, text) });
    }
    return { results };
  }

  /** Invoke-New : nouvelle session (dossier proposé, premier message, modèle, worktree neuf facultatif,
   *  session source facultative : `--resume <id> --fork-session`, nouvel identifiant, source intacte). */
  async newSession(cwd: string, prompt: string, model: string, branchRaw: string, forkRaw = '', tagsRaw: unknown = undefined, sidRaw = ''): Promise<string | null> {
    const want = cwd.replace(/\\+$/, '');
    const dir = (await this.d.newFolders()).find((f) => ieq(f.path, want));
    if (!dir) return 'dossier non proposé';
    if (model && !/^[A-Za-z0-9][A-Za-z0-9.\-\[\]]{0,60}$/.test(model)) return 'modèle invalide';
    if (prompt.length > 20000) return 'premier message trop long';
    const forkFrom = forkRaw.trim();
    if (forkFrom) {
      if (!GUID.test(forkFrom)) return 'session source : identifiant invalide';
      if (!this.d.meta(forkFrom).path) return 'session source : transcript introuvable';
    }
    // Tags choisis à la création : mêmes contrôles que la correction à la main, TOUS vérifiés avant d'ouvrir l'onglet.
    // Identifiant choisi par l'appelant (veilleur Teams : il doit retrouver la session qu'il ouvre) : jamais un identifiant déjà pris.
    const wantSid = sidRaw.trim();
    if (wantSid) {
      if (!GUID.test(wantSid)) return 'identifiant de session invalide';
      if (this.d.meta(wantSid).path) return 'identifiant de session déjà pris';
    }
    const sid = wantSid || randomUUID(); const newTags: [string, string][] = [];
    if (tagsRaw !== undefined && tagsRaw !== null) {
      if (!Array.isArray(tagsRaw)) return 'tags : liste attendue';
      if (tagsRaw.length > 8) return 'tags : 8 au plus';
      const vocab = this.d.tagVocab();
      for (const t of tagsRaw) {
        const o = (t !== null && typeof t === 'object' ? t : {}) as Record<string, unknown>;
        const a = psString(o.axis), v = psString(o.v).trim();
        const e = checkTag(sid, a, v, vocab); if (e) return `tag ${a}:${v} : ${e}`;
        newTags.push([a, v]);
      }
    }
    const branch = branchRaw.trim(); let prelude = ''; let startDir = dir.path;
    if (branch) {
      if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,2}$/i.test(branch) || branch.length > 80 || /\.\.|\.lock$|\/$/i.test(branch))
        return 'nom de branche invalide (minuscules, chiffres, . _ - et /, ex. feat/hd-123456-x)';
      const r = await run('git', ['-C', dir.path, 'rev-parse', '--show-toplevel']);
      const top = r.out.trim().replace(/\//g, '\\');
      if (r.code !== 0 || !top) return "ce dossier n'est pas dans un dépôt git";
      if ((await run('git', ['-C', top, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`])).code === 0) return `la branche ${branch} existe déjà`;
      const wt = join(top, '.claude', 'worktrees', branch.split('/').at(-1)!);
      if (existsSync(wt)) return `le dossier ${wt} existe déjà`;
      let rel = dir.path.slice(Math.min(top.length, dir.path.length)).replace(/^\\+/, '');
      if (!dir.path.toLowerCase().startsWith(top.toLowerCase())) rel = '';
      const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
      prelude = `Write-Host 'Worktree neuf : ${branch.replace(/'/g, "''")} sur origin/master…' -ForegroundColor Cyan; `
        + `git -C ${q(top)} fetch origin master; `
        + `git -C ${q(top)} worktree add -b ${q(branch)} ${q(wt)} origin/master; `
        + "if ($LASTEXITCODE) { Write-Host 'Échec de la création du worktree : session non lancée.' -ForegroundColor Red; return }; "
        + `Set-Location -LiteralPath ${q(join(wt, rel))}; `;
      startDir = top;
    }
    if (startDir.includes(';')) return SEMICOLON_REFUSED;
    let cmd =`claude ${this.d.cfg.claudeArgs}`;
    if (model) cmd += ` --model ${model}`;
    if (forkFrom) cmd += ` --resume ${forkFrom} --fork-session`;
    // Identifiant fixé d'avance (--session-id, admis avec --fork-session) : tags posés AVANT le démarrage.
    if (newTags.length || wantSid) cmd += ` --session-id ${sid}`;
    let p = prompt.trim();
    if (p) {
      // « -x » serait lu comme une option, un mot seul (« update ») comme une sous-commande : une espace devant suffit.
      if (/^-/.test(p) || /^[\p{L}\p{Mn}\p{Nd}\p{Pc}]+$/u.test(p)) p = ' ' + p;
      const pd = this.d.sf('new-session-prompts'); mkdirSync(pd, { recursive: true });
      const file = join(pd, `${randomUUID()}.txt`);
      writeFileSync(file, p, 'utf8');
      const lit = file.replace(/'/g, "''");
      cmd = `$p = [IO.File]::ReadAllText('${lit}'); Remove-Item -LiteralPath '${lit}'; ${cmd} $p`;
    }
    for (const [a, v] of newTags) this.d.setTag(sid, a, v, true);
    const b64 = Buffer.from(prelude + cmd, 'utf16le').toString('base64');
    await this.wt(`-w 0 nt -d "${startDir}" pwsh -NoExit -EncodedCommand ${b64}`);
    return null;
  }
}

