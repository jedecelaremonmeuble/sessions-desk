// Module « automations » (src/automations.ts) : configuration, lecture de l'historique depuis la fin, passes du jour,
// passe en cours, fichiers confinés au dossier de la passe, ordres, notifications. Sans serveur ni vraie session.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { automationView, Automations, HistoryTail, nextPass, passAlerts, passOf, runningPasses, type Pass } from '../src/automations.ts';
import { modulesView, parseAutomations, parseModules, type AutomationDef } from '../src/modules.ts';
import type { Dashboard } from '../src/state.ts';

const dir = mkdtempSync(join(tmpdir(), 'sd-automates-'));
// L'ordre « lent » tourne encore 1 s après son test (dossier courant = celui du test) : on attend qu'il ait fini.
afterAll(async () => {
  for (let i = 0; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) { if (i >= 40) throw e; await new Promise((ok) => setTimeout(ok, 250)); }
  }
}, 15000);
const env = { home: 'C:\\Users\\moi', localAppData: 'C:\\Users\\moi\\AppData\\Local', temp: 'C:\\Temp' };
const H = 3600e3;
const NOW = Date.UTC(2026, 10, 20, 14, 0);
const MIDNIGHT = Date.UTC(2026, 10, 20, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** Ligne d'historique au format du contrat, avec des champs propres à l'automate autour. */
function line(at: number, pass: Record<string, unknown> | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ startedAt: iso(at), outcome: 'done', level: 'calme', ...extra, ...(pass ? { pass: { v: 1, startedAt: iso(at), status: 'ok', level: 'ok', summary: 'résumé', minutes: 1, runDir: null, sessionId: null, costUsd: null, files: [], quiet: false, dryRun: false, ...pass } } : {}) });
}
const def = (o: Partial<AutomationDef> = {}): AutomationDef => ({ id: 'menage', label: 'Ménage', icon: '🧹', history: join(dir, 'h.jsonl'), runs: join(dir, 'runs'), cli: '', python: 'python', everyMinutes: 60, orders: [], ...o });

describe('configuration', () => {
  test('absente : module éteint ; un automate mal décrit est ignoré sans éteindre les autres', () => {
    expect(parseModules({ modules: {} }, env).automations).toEqual([]);
    expect(modulesView(parseModules({ modules: {} }, env)).automations).toBe(false);
    const list = parseAutomations([
      { id: 'rapport', label: 'Rapport', icon: '📊', history: '%LOCALAPPDATA%\\s\\history.jsonl', runs: '%LOCALAPPDATA%\\s\\runs', cli: 'C:\\s\\run.py', everyMinutes: 60,
        orders: [{ id: 'blanc', label: 'À blanc', args: ['run', '--dry-run'] }, { id: 'vrai', label: 'Publier', args: ['run'], confirm: 'Publier ?' },
          { id: 'X', label: 'id refusé', args: [] }, { id: 'guill', label: 'guillemet', args: ['a"b'] }, { id: 'blanc', label: 'doublon', args: ['x'] }] },
      { id: 'rapport', label: 'doublon', history: 'C:\\h.jsonl' },
      { id: 'relatif', label: 'Relatif', history: 'h.jsonl' },
      { id: 'sans-libelle', history: 'C:\\h.jsonl' },
      { id: 'sans-cli', label: 'Sans commande', history: 'C:\\h.jsonl', orders: [{ id: 'a', label: 'A', args: ['run'] }], everyMinutes: 0 },
    ], env);
    expect(list.map((a) => a.id)).toEqual(['rapport', 'sans-cli']);
    expect(list[0]).toEqual({ id: 'rapport', label: 'Rapport', icon: '📊', history: 'C:\\Users\\moi\\AppData\\Local\\s\\history.jsonl', runs: 'C:\\Users\\moi\\AppData\\Local\\s\\runs',
      cli: 'C:\\s\\run.py', python: 'python', everyMinutes: 60,
      orders: [{ id: 'blanc', label: 'À blanc', args: ['run', '--dry-run'], confirm: '' }, { id: 'vrai', label: 'Publier', args: ['run'], confirm: 'Publier ?' }] });
    expect(list[1]).toMatchObject({ runs: '', cli: '', orders: [], everyMinutes: null });     // sans commande : aucun ordre
    expect(modulesView(parseModules({ modules: { automations: list } }, env)).automations).toBe(true);
  });
});

describe('ligne d\'historique', () => {
  test('clé « pass » : lue ; champs propres à l\'automate ignorés ; dossier → identifiant de passe', () => {
    const p = passOf(JSON.parse(line(NOW, { runDir: 'C:\\r\\runs\\20261120-140000', sessionId: 'AAAAAAAA-1111-2222-3333-444444444444', files: ['recap.md', '..', 'a\\b.md'], costUsd: 2.5 })))!;
    expect(p).toMatchObject({ run: '20261120-140000', at: NOW, status: 'ok', level: 'ok', summary: 'résumé', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', files: ['recap.md'], costUsd: 2.5 });
  });
  test('sans clé « pass » : passe silencieuse « issue inconnue » ; statut inconnu, niveau déduit', () => {
    expect(passOf(JSON.parse(line(NOW, null)))).toMatchObject({ status: 'unknown', quiet: true, run: iso(NOW) });
    expect(passOf({ pass: { startedAt: iso(NOW), status: 'rejected' } })).toMatchObject({ status: 'rejected', level: 'error', summary: 'rejected' });
    expect(passOf({ pass: { startedAt: iso(NOW), status: 'bizarre', level: 'pire' } })).toMatchObject({ status: 'unknown', level: 'ok' });
    for (const x of [null, 3, [], {}, { pass: { startedAt: 'pas une date' } }]) expect(passOf(x)).toBeNull();
  });
});

describe('historique lu depuis la fin', () => {
  test('8 jours seulement, sans tout relire ; ajout lu au passage suivant ; ligne en cours d\'écriture attendue', () => {
    const f = join(dir, 'long.jsonl');
    const old = Array.from({ length: 3000 }, (_, i) => line(NOW - 30 * 24 * H + i * 60000, { summary: 'x'.repeat(900) }));   // ~3 Mo hors fenêtre
    const recent = [line(NOW - 7 * 24 * H, { summary: 'il y a 7 j' }), line(NOW - 2 * H, { summary: 'récente' })];
    writeFileSync(f, old.concat(recent).join('\n') + '\n');
    const t = new HistoryTail(f); t.refresh(NOW);
    expect(t.present).toBe(true);
    expect(t.passes.map((p) => p.summary)).toEqual(['il y a 7 j', 'récente']);
    appendFileSync(f, line(NOW - H, { summary: 'ajoutée' }) + '\n' + line(NOW, { summary: 'à moitié' }).slice(0, 40));
    t.refresh(NOW);
    expect(t.passes.map((p) => p.summary)).toEqual(['il y a 7 j', 'récente', 'ajoutée']);
    appendFileSync(f, line(NOW, { summary: 'à moitié' }).slice(40) + '\n');
    t.refresh(NOW);
    expect(t.passes.at(-1)!.summary).toBe('à moitié');
    writeFileSync(f, line(NOW, { summary: 'remplacé' }) + '\n');       // fichier raccourci : relu en entier
    t.refresh(NOW);
    expect(t.passes.map((p) => p.summary)).toEqual(['remplacé']);
    rmSync(f); t.refresh(NOW);
    expect(t.present).toBe(false); expect(t.passes).toEqual([]);
  });
});

describe('vue d\'un automate', () => {
  const passes = [
    line(MIDNIGHT - 2 * H, { status: 'failed', level: 'error', summary: 'hier, échec', costUsd: 1 }),
    line(MIDNIGHT + 1 * H, { status: 'nothing', quiet: true, summary: 'rien' }),
    line(MIDNIGHT + 2 * H, { status: 'ok', summary: 'a agi', costUsd: 2, runDir: 'C:\\r\\runs\\a', files: ['recap.md'] }),
    line(MIDNIGHT + 3 * H, null),
    line(MIDNIGHT + 4 * H, { status: 'conflict', level: 'warn', summary: 'conflit' }),
  ].map((l) => passOf(JSON.parse(l))!);
  test('passes du jour hors silencieuses, de la plus récente à la plus ancienne ; carte sur 7 jours ; jamais de chemin', () => {
    const v = automationView(def(), passes, true, null, MIDNIGHT, NOW);
    expect(v.passes.map((p) => p.summary)).toEqual(['conflit', 'a agi']);
    expect(v.quietToday).toBe(2);
    expect(v.last!.summary).toBe('conflit');
    expect(v.next).toBe(MIDNIGHT + 15 * H);                         // heure habituelle (pile), pas « dernière + 1 h »
    expect(v.late).toBe(true);                                       // rien depuis 4 h pour une tâche horaire
    expect(v.week).toMatchObject({ count: 5, failures: 1, warnings: 1, costUsd: 3, costAvg: 1.5 });
    expect(v.week.lastFailure!.summary).toBe('hier, échec');
    expect(JSON.stringify(v)).not.toContain('runDir');
    expect(v.passes[1]).toMatchObject({ run: 'a', hasDir: true, files: ['recap.md'] });
  });
  test('passe en cours : à part, et sa ligne d\'historique (si déjà écrite) n\'est pas comptée deux fois', () => {
    const v = automationView(def(), passes, true, { run: 'a', runDir: 'C:\\r\\runs\\a', sessionId: 's', pid: 7, at: NOW }, MIDNIGHT, NOW);
    expect(v.running).toEqual({ run: 'a', sessionId: 's', pid: 7, at: NOW });
    expect(v.passes.map((p) => p.summary)).toEqual(['conflit']);
  });
  test('historique absent : vue vide, sans erreur', () => {
    expect(automationView(def(), [], false, null, MIDNIGHT, NOW)).toMatchObject({ present: false, passes: [], last: null, next: null, week: { count: 0, costUsd: null } });
  });
});

describe('prochaine passe', () => {
  const P = (at: number): Pass => ({ run: String(at), at, level: 'ok', status: 'ok', summary: '', minutes: null, costUsd: null, sessionId: null, files: [], quiet: false, dryRun: false, runDir: null });
  test('à l\'heure habituelle de la tâche, même après une passe lancée à la main', () => {
    const hourly = [0, 1, 2, 3].map((h) => P(MIDNIGHT + h * H + 15000)).concat(P(MIDNIGHT + 3 * H + 36 * 60000));
    expect(nextPass(hourly, 60, MIDNIGHT + 3 * H + 40 * 60000)).toBe(MIDNIGHT + 4 * H);
    const tenMin = [0, 1, 2].map((i) => P(MIDNIGHT + i * 600000 + 6 * 60000 + 11000));   // :06, :16, :26
    expect(nextPass(tenMin, 10, MIDNIGHT + 27 * 60000)).toBe(MIDNIGHT + 36 * 60000);
    expect(nextPass([], 60, NOW)).toBeNull();
    expect(nextPass(hourly, null, NOW)).toBeNull();
  });
});

describe('passe en cours', () => {
  test('session sans terminal dont la ligne de commande cite un dossier sous « runs »', () => {
    const d = def({ runs: 'C:\\Users\\moi\\AppData\\Local\\menage\\runs' });
    const sessions = [
      { pid: 1, sessionId: 'auto', headless: true, startedAt: NOW },
      { pid: 2, sessionId: 'manuelle', headless: false },
      { pid: 3, sessionId: 'autre', headless: true },
    ];
    const cl = new Map([
      [1, 'claude.exe -p --settings C:/Users/moi/AppData/Local/menage/runs/20261120-140000/settings.json --add-dir "C:\\Users\\moi\\AppData\\Local\\menage\\runs\\20261120-140000"'],
      [2, 'claude.exe --add-dir C:\\Users\\moi\\AppData\\Local\\menage\\runs\\x'],
      [3, 'claude.exe -p --add-dir C:\\ailleurs\\runs\\y'],
    ]);
    const r = runningPasses([d, def({ id: 'sans-dossier', runs: '' })], sessions, cl);
    expect([...r.keys()]).toEqual(['menage']);
    expect(r.get('menage')).toEqual({ run: '20261120-140000', runDir: join(d.runs, '20261120-140000'), sessionId: 'auto', pid: 1, at: NOW });
  });
});

describe('notifications : échecs seulement', () => {
  const P = (at: number, level: string): Pass => ({ run: String(at), at, level, status: 'ok', summary: '', minutes: null, costUsd: null, sessionId: null, files: [], quiet: false, dryRun: false, runDir: null });
  test('toute passe en erreur ; la 2e alerte d\'affilée une seule fois ; rien avant le point de départ', () => {
    const ps = [P(1, 'error'), P(2, 'warn'), P(3, 'warn'), P(4, 'warn'), P(5, 'ok'), P(6, 'warn'), P(7, 'error'), P(8, 'warn')];
    expect(passAlerts(ps, 0).map((p) => p.at)).toEqual([1, 3, 7]);
    expect(passAlerts(ps, 3).map((p) => p.at)).toEqual([7]);
    expect(passAlerts([P(1, 'warn'), P(2, 'warn')], 1).map((p) => p.at)).toEqual([2]);
  });
});

describe('fichiers et ordres (module complet)', () => {
  const root = join(dir, 'auto'); const runs = join(root, 'runs'); const hist = join(root, 'history.jsonl');
  mkdirSync(join(runs, 'p1'), { recursive: true }); mkdirSync(join(root, 'dehors'), { recursive: true });
  writeFileSync(join(runs, 'p1', 'recap.md'), '# récap'); writeFileSync(join(runs, 'p1', 'settings.json'), '{"secret":1}');
  writeFileSync(join(root, 'dehors', 'x.md'), 'hors du dossier des passes');
  const script = (name: string, body: string): string => { const f = join(root, name); writeFileSync(f, body); return f; };
  const fake = (defs: AutomationDef[]): Automations => new Automations({
    cfg: { modules: { automations: defs }, temp: root },
    driver: { call: async () => [] }, openSessions: async () => [],
  } as unknown as Dashboard);
  const now = Date.now();
  writeFileSync(hist, [
    line(now - H, { runDir: join(runs, 'p1'), files: ['recap.md', 'settings.json'] }),
    line(now - 30 * 60000, { runDir: join(root, 'dehors'), files: ['x.md'] }),
  ].join('\n') + '\n');
  const a = def({ id: 'auto', history: hist, runs, python: process.execPath, cli: script('ordre.mjs', `
    const m = process.argv[2];
    if (m === 'ko') { console.log('une passe tourne déjà (verrou)'); process.exit(3); }
    if (m === 'lent') setTimeout(() => {}, 2500); else console.log('fini : ' + process.argv.slice(2).join(' '));`),
    orders: [{ id: 'ko', label: 'KO', args: ['ko'], confirm: '' }, { id: 'lent', label: 'Lent', args: ['lent'], confirm: '' }, { id: 'ok', label: 'OK', args: ['ok', '--dry-run'], confirm: '' }] });

  test('fichier annoncé, dans le dossier de SA passe ; tout le reste refusé', () => {
    const m = fake([a]);
    const ok = m.file('auto', 'p1', 'recap.md');
    expect(ok.status).toBe(200); expect(ok.type).toBe('text/plain; charset=utf-8'); expect(ok.body!.toString()).toBe('# récap');
    expect(m.file('auto', 'p1', 'settings.json').status).toBe(200);        // annoncé par la passe : servi tel quel
    expect(m.file('auto', 'p1', 'absent.md').status).toBe(404);            // pas dans `files`
    expect(m.file('auto', 'p1', '..\\h.jsonl').status).toBe(403);
    expect(m.file('auto', 'p1', 'C:\\Windows\\win.ini').status).toBe(403);
    expect(m.file('auto', 'p1', '..').status).toBe(403);
    expect(m.file('auto', 'dehors', 'x.md').status).toBe(403);             // dossier hors de `runs`
    expect(m.file('inconnu', 'p1', 'recap.md').status).toBe(404);
    expect(fake([{ ...a, runs: '' }]).file('auto', 'p1', 'recap.md').status).toBe(404);
  });

  test('ordres : inconnu ⇒ 400 ; arrêt en erreur ⇒ 409 avec sa dernière ligne ; fini ; encore en cours', async () => {
    const m = fake([a]);
    expect(fake([]).enabled).toBe(false);
    expect(await m.order('auto', 'absent')).toEqual({ status: 400, body: { error: 'ordre inconnu' } });
    expect(await m.order('inconnu', 'ok')).toEqual({ status: 400, body: { error: 'ordre inconnu' } });
    expect(await m.order('auto', 'ko')).toEqual({ status: 409, body: { error: 'la commande s\'est arrêtée (code 3) : une passe tourne déjà (verrou)', code: 3 } });
    expect(await m.order('auto', 'ok')).toEqual({ status: 200, body: { done: true, output: 'fini : ok --dry-run' } });
    expect(await m.order('auto', 'lent')).toEqual({ status: 200, body: { started: true } });
  });

  test('vue et notifications : le premier passage se cale, une nouvelle passe en erreur est signalée une fois', async () => {
    const m = fake([a]);
    const v = await m.view(now - 24 * H) as { automations: { passes: unknown[] }[] };
    expect(v.automations[0]!.passes).toHaveLength(2);
    expect(m.alerts()).toEqual([]);
    appendFileSync(hist, line(Date.now(), { status: 'failed', level: 'error', summary: 'récap impossible' }) + '\n');
    expect(m.alerts().map((x) => x.pass.summary)).toEqual(['récap impossible']);
    expect(m.alerts()).toEqual([]);
  });
});
