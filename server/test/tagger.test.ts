// Étiqueteur des sessions (docs/SessionsDeskTags-Cadrage.md, lot 1) : règles pures, puis une passe sur un profil factice.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { classify, decide, featureSlug, feedLine, isFeatureSlug, launchKind, LLM_VERSION, newAcc, parseLlm, relPath, runPass, topDirs, weeklyQuotaPct, worktreeOf, type Acc, type TaggerConfig } from '../src/tagger.ts';

const cfg = JSON.parse(readFileSync(new URL('../src/tagger-config.json', import.meta.url), 'utf8')) as TaggerConfig;
const W = 'C:\\Sources\\jd2m\\.claude\\worktrees\\pdial-rdv\\Jd2m_Backoffice\\backend\\';
const user = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', cwd: 'C:\\Sources\\jd2m\\Jd2m_Backoffice\\backend', entrypoint: 'cli', gitBranch: 'HEAD', message: { role: 'user', content: text }, ...extra });
const tool = (name: string, input: Record<string, unknown>) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const feed = (lines: string[], acc: Acc = newAcc()): Acc => { for (const l of lines) feedLine(acc, l); return acc; };
const vals = (tags: { axis: string; v: string }[], axis: string) => tags.filter((t) => t.axis === axis).map((t) => t.v);

describe('chemins', () => {
  test('relatif à la racine du dépôt, worktree compris ; mémoire et %TEMP% ignorés', () => {
    expect(relPath(W + 'Application\\Twilio\\X.cs')).toBe('jd2m_backoffice/backend/application/twilio/x.cs');
    expect(relPath('C:\\Sources\\jd2m\\Jd2m_Backoffice\\frontend\\src\\a.tsx')).toBe('jd2m_backoffice/frontend/src/a.tsx');
    expect(relPath('C:/Sources/wt-sessions-tags/Jd2m_Backoffice/backend/docs/claude/Telephony.md')).toBe('jd2m_backoffice/backend/docs/claude/telephony.md');
    expect(relPath('C:\\Sources\\jd2m\\twilio-contact-center\\src\\a.ts')).toBe('twilio-contact-center/src/a.ts');
    expect(relPath('C:\\Sources\\jd2m\\sessions-desk-tags\\server\\src\\state.ts')).toBe('sessions-desk-tags/server/src/state.ts');
    expect(relPath('C:\\Users\\x\\.claude\\scripts\\sessions-dashboard.ps1')).toBe('claude-scripts/sessions-dashboard.ps1');
    expect(relPath('C:\\Users\\x\\.claude\\projects\\p\\memory\\MEMORY.md')).toBeNull();
    expect(relPath('C:\\Sources\\jd2m\\.claude\\settings.json')).toBeNull();
    expect(relPath('C:\\Users\\x\\AppData\\Local\\Temp\\a.txt')).toBeNull();
  });
  test('worktree et fonctionnalité', () => {
    expect(worktreeOf(W + 'a.cs')).toBe('pdial-rdv');
    expect(worktreeOf('C:/Sources/wt-fil-delais/x')).toBe('fil-delais');
    expect(worktreeOf('C:\\Sources\\jd2m\\Jd2m_Backoffice\\backend\\a.cs')).toBeNull();
    expect(featureSlug('hd990935-rdv-hors-salve-cadrage')).toBe('rdv-hors-salve');
    expect(featureSlug('sessions-desk-lot2-cadrage')).toBe('sessions-desk');
    expect(featureSlug('fix')).toBeNull(); expect(featureSlug('auto-dev')).toBeNull(); expect(featureSlug('master')).toBeNull();
  });
  test('classement : un chemin = un outil ; domaine par motifs, par la mémoire de domaine, jamais pour l\'outillage', () => {
    expect(classify('jd2m_backoffice/backend/application/twilio/x.cs', cfg)).toEqual({ outils: ['hubdesk'], domaines: ['Téléphonie'] });
    expect(classify('jd2m_backoffice/backend/partnerapi/a.cs', cfg)).toEqual({ outils: ['portail-partenaires'], domaines: ['Partenaires'] });
    expect(classify('jd2m_backoffice/backend/docs/claude/telephony.md', cfg).domaines).toEqual(['Téléphonie']);
    expect(classify('jd2m_backoffice/backend/docs/claude/platform.md', cfg).domaines).toEqual([]);
    expect(classify('jd2m_backoffice/backend/scripts/autodiagnostic/hd_tickets.py', cfg)).toEqual({ outils: ['lanceur'], domaines: [] });
    expect(classify('twilio-contact-center/src/calls/a.ts', cfg)).toEqual({ outils: ['contact-center'], domaines: ['Téléphonie'] });
  });
});

describe('lecture et décision', () => {
  test('nature d\'une session lancée par un script', () => {
    expect(launchKind('Session de DÉVELOPPEMENT automatique, SANS personne devant, lancée par\n`scripts/AutoDiagnostic/auto_dev.py`')).toBe('dev');
    expect(launchKind('Session de RELECTURE automatique, SANS personne')).toBe('relecture');
    expect(launchKind('Session SANS personne devant, lancée par scripts/AutoDiagnostic/auto_diagnostic.py. Applique')).toBe('diag');
    expect(launchKind('Session SANS personne devant, lancée par scripts/DatadogStatus/datadog_status.py.')).toBe('automate:datadog-status');
    expect(launchKind('Corrige le bug HD-990033')).toBeNull();
  });
  test('session interactive : 1er message (pas /model ni les messages méta), fichiers écrits d\'abord', () => {
    const acc = feed([
      user('<command-name>/model</command-name>\n<command-args></command-args>'),
      user('Caveat : HD-111111', { isMeta: true }),
      user('Regarde HD-990935 et HD-990935, puis HD-990033'),
      tool('Read', { file_path: W + 'Application\\Ticket\\T.cs' }),
      tool('Read', { file_path: W + 'Application\\Ticket\\U.cs' }),
      tool('Edit', { file_path: W + 'Application\\Twilio\\Calls.cs' }),
      tool('Write', { file_path: 'C:\\Users\\x\\.claude\\projects\\p\\memory\\m.md' }),
      user('et aussi HD-222222'),
    ]);
    expect(acc.hd).toEqual(['HD-990935', 'HD-990033']);
    const tags = decide(acc, null, cfg);
    expect(vals(tags, 'origine')).toEqual(['interactive']);
    expect(vals(tags, 'domaine')).toEqual(['Téléphonie']);      // écrit l'emporte sur lu
    expect(vals(tags, 'outil')).toEqual(['hubdesk']);
    expect(vals(tags, 'fonction')).toEqual(['pdial-rdv']);
    expect(vals(tags, 'hd')).toEqual(['HD-990935', 'HD-990033']);
  });
  test('le domaine de la demande HD prime ; « Autre » et un domaine hors liste ne comptent pas', () => {
    const acc = feed([user('HD-990935'), tool('Edit', { file_path: W + 'Application\\Twilio\\A.cs' })]);
    // Un seul fichier de téléphonie écrit : pas assez pour un 2e domaine (au moins 2 fichiers).
    expect(decide(acc, 'RDV & agendas', cfg).filter((t) => t.axis === 'domaine')).toEqual([{ axis: 'domaine', v: 'RDV & agendas', src: 'hd' }]);
    expect(vals(decide(acc, 'Autre', cfg), 'domaine')).toEqual(['Téléphonie']);
    expect(vals(decide(acc, 'Inconnu', cfg), 'domaine')).toEqual(['Téléphonie']);
  });
  test('lanceur : origine par le prompt ; un automate ne garde ni ses HD d\'exemple ni le domaine', () => {
    const dev = feed([user('Session de DÉVELOPPEMENT automatique, lancée par `scripts/AutoDiagnostic/auto_dev.py`. Demande HD-970504', { entrypoint: 'sdk-cli', gitBranch: 'auto-dev/hd-970504' })]);
    expect(vals(decide(dev, 'Compta', cfg), 'origine')).toEqual(['lanceur-dev']);
    expect(vals(decide(dev, 'Compta', cfg), 'domaine')).toEqual(['Compta']);
    expect(vals(decide(dev, 'Compta', cfg), 'fonction')).toEqual([]);       // auto-dev/hd-… : rien de parlant
    const dd = feed([user('<command-name>/datadog-error-status</command-name>\n<command-args>Session SANS personne devant, lancée par scripts/DatadogStatus/datadog_status.py. Ex. HD-123456</command-args>', { entrypoint: 'sdk-cli' })]);
    const t = decide(dd, 'Compta', cfg);
    expect(vals(t, 'origine')).toEqual(['automate']); expect(vals(t, 'fonction')).toEqual(['datadog-status']);
    expect(vals(t, 'hd')).toEqual([]); expect(vals(t, 'domaine')).toEqual([]);
  });
  test('lectures seules : un domaine à partir de 2 fichiers, un outil à partir de 3', () => {
    const one = feed([user('x'), tool('Read', { file_path: W + 'Application\\Twilio\\A.cs' })]);
    expect(vals(decide(one, null, cfg), 'domaine')).toEqual([]); expect(vals(decide(one, null, cfg), 'outil')).toEqual([]);
    const three = feed([user('x'), ...['A', 'B', 'C'].map((n) => tool('Grep', { path: W + `Application\\Twilio\\${n}.cs` }))]);
    expect(vals(decide(three, null, cfg), 'domaine')).toEqual(['Téléphonie']); expect(vals(decide(three, null, cfg), 'outil')).toEqual(['hubdesk']);
  });
});

describe('passe', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  const setup = () => {
    root = mkdtempSync(join(tmpdir(), 'sd-tagger-'));
    const proj = join(root, 'projects', 'C--x'); mkdirSync(proj, { recursive: true });
    return { proj, out: join(root, 'tags') };
  };
  const ID = '11111111-2222-3333-4444-555555555555';
  const read = (out: string, id = ID) => JSON.parse(readFileSync(join(out, id + '.json'), 'utf8'));

  test('incrémentale : relit depuis le dernier octet, ignore une ligne inachevée, ne relit pas un transcript inchangé', () => {
    const { proj, out } = setup();
    const f = join(proj, ID + '.jsonl');
    writeFileSync(f, user('HD-990935') + '\n' + tool('Edit', { file_path: W + 'Application\\Twilio\\A.cs' }).slice(0, 30));
    const look: string[] = [];
    const hdLookup = (id: string) => { look.push(id); return { domain: 'RDV & agendas', title: 'Prochaine action et RDV' }; };
    let r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup });
    expect(r.updated).toBe(1);
    expect(vals(read(out).tags, 'domaine')).toEqual(['RDV & agendas']);
    expect(vals(read(out).tags, 'outil')).toEqual([]);                    // ligne inachevée : pas encore lue
    appendFileSync(f, tool('Edit', { file_path: W + 'Application\\Twilio\\A.cs' }).slice(30) + '\n');
    r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup });
    expect(r.updated).toBe(1);
    expect(vals(read(out).tags, 'outil')).toEqual(['hubdesk']);
    expect(look).toEqual(['990935']);                                     // domaine HD en cache
    r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup });
    expect(r).toMatchObject({ updated: 0, skipped: 1 });
  });

  test('budget de recherches HD épuisé ⇒ en attente, complété à la passe suivante ; rétention : purge', () => {
    const { proj, out } = setup();
    writeFileSync(join(proj, ID + '.jsonl'), user('HD-990935') + '\n');
    const tight = { ...cfg, maxHdLookupsPerPass: 0 };
    let r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg: tight, hdLookup: () => ({ domain: 'Compta', title: null }) });
    expect(r.pending).toBe(1); expect(read(out).hdPending).toBe(true); expect(vals(read(out).tags, 'domaine')).toEqual([]);
    r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup: () => ({ domain: 'Compta', title: null }) });
    expect(read(out).hdPending).toBe(false); expect(vals(read(out).tags, 'domaine')).toEqual(['Compta']);
    const OLD = '99999999-2222-3333-4444-555555555555';
    writeFileSync(join(out, OLD + '.json'), '{}');
    r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup: () => ({ domain: 'Compta', title: null }) });
    expect(r.purged).toBe(1); expect(existsSync(join(out, OLD + '.json'))).toBe(false); expect(existsSync(join(out, '_hd-domains.json'))).toBe(true);
  });

  test('budget d\'octets : la lecture reprend où elle s\'est arrêtée ; changer les règles recalcule sans relire', () => {
    const { proj, out } = setup();
    const lines = [user('x'), ...Array.from({ length: 50 }, (_, i) => tool('Edit', { file_path: W + `Application\\Twilio\\F${i}.cs` }))];
    writeFileSync(join(proj, ID + '.jsonl'), lines.join('\n') + '\n');
    const small = { ...cfg, maxBytesPerPass: 2000 };
    let r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg: small, hdLookup: () => null });
    expect(r.budgetHit).toBe(true); expect(read(out).transcriptLen).toBe(-1);
    for (let i = 0; i < 20 && read(out).transcriptLen === -1; i++) runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg: small, hdLookup: () => null });
    expect(Object.keys(read(out).acc.files)).toHaveLength(50);
    r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg: { ...cfg, rulesVersion: cfg.rulesVersion + 1 }, hdLookup: () => null });
    expect(r).toMatchObject({ updated: 1, bytes: 0 });
  });
});

describe('petit modèle (lot 2)', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  const ID = '11111111-2222-3333-4444-555555555555', AUTO = '22222222-2222-3333-4444-555555555555', NEW = '33333333-2222-3333-4444-555555555555';
  const title = (t: string) => JSON.stringify({ type: 'ai-title', aiTitle: t });

  test('titre, 1er message et messages tapés relevés ; les résultats d\'outils ne comptent pas', () => {
    const acc = feed([user('Ajoute un bouton HD-990935'), title('Bouton rappel'), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }), user('et le test'), title('Bouton de rappel')]);
    expect(acc.title).toBe('Bouton de rappel'); expect(acc.firstText).toBe('Ajoute un bouton HD-990935'); expect(acc.users).toBe(2);
  });
  test('réponse filtrée : identifiants kebab-case, domaine de la liste, session absente ignorée', () => {
    const raw = 'Voici : {"a": {"fonction": ["power-dial", "Power Dial", "hd-990935-x", "bdc-relance", "x"], "domaine": "Téléphonie"}, "b": {"fonction": "tags-sessions", "domaine": "Inventé"}}';
    const got = parseLlm(raw, ['a', 'b', 'c'], cfg, 5, new Map([['a', 'T']]));
    expect(got.get('a')).toEqual({ at: 5, title: 'T', fonction: ['power-dial', 'hd-990935-x'], domaine: 'Téléphonie', v: LLM_VERSION });
    expect(got.get('b')).toEqual({ at: 5, title: null, fonction: ['tags-sessions'], domaine: null, v: LLM_VERSION });
    expect(got.has('c')).toBe(false);
    expect(parseLlm('pas de json', ['a'], cfg, 5, new Map()).size).toBe(0);
    expect(isFeatureSlug('a-b-c-d-e')).toBe(true); expect(isFeatureSlug('a-b-c-d-e-f')).toBe(false);
  });
  test('décision : la fonction de l\'IA d\'abord, le domaine de l\'IA seulement sans autre domaine', () => {
    const acc = feed([user('x'), tool('Edit', { file_path: W + 'Application/Twilio/A.cs' })]);
    const llm = { at: 1, title: null, fonction: ['power-dial', 'pdial-rdv'], domaine: 'Compta' };
    const t = decide(acc, null, cfg, llm);
    expect(t.filter((x) => x.axis === 'fonction')).toEqual([{ axis: 'fonction', v: 'power-dial', src: 'ia' }, { axis: 'fonction', v: 'pdial-rdv', src: 'ia' }]);
    expect(vals(t, 'domaine')).toEqual(['Téléphonie']);
    const bare = feed([user('x')]);
    expect(decide(bare, null, cfg, llm).filter((x) => x.axis === 'domaine')).toEqual([{ axis: 'domaine', v: 'Compta', src: 'ia' }]);
    expect(topDirs(acc)).toEqual(['jd2m_backoffice/backend/application/twilio']);
  });
  test('passe : par lots, une seule fois par titre, jamais pour un automate ni une session sans tête encore active', () => {
    root = mkdtempSync(join(tmpdir(), 'sd-tagger-'));
    const proj = join(root, 'projects', 'C--x'); mkdirSync(proj, { recursive: true }); const out = join(root, 'tags');
    writeFileSync(join(proj, ID + '.jsonl'), [user('Bouton de rappel HD-990935'), title('Bouton rappel')].join('\n') + '\n');
    writeFileSync(join(proj, AUTO + '.jsonl'), user('<command-name>/datadog-error-status</command-name><command-args>Session SANS personne devant, lancée par scripts/DatadogStatus/datadog_status.py.</command-args>', { entrypoint: 'sdk-cli' }) + '\n');
    writeFileSync(join(proj, NEW + '.jsonl'), user('Session de RELECTURE automatique, lancée par `scripts/AutoDiagnostic/auto_review.py` HD-970504', { entrypoint: 'sdk-cli' }) + '\n');
    const prompts: string[] = [];
    const llm = (p: string) => { prompts.push(p); return JSON.stringify({ s1: { fonction: ['bouton-rappel'], domaine: null } }); };
    const hdLookup = () => ({ domain: 'RDV & agendas', title: 'Prochaine action et RDV' });
    let r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup, llm });
    expect(r).toMatchObject({ llmCalls: 1, llmTagged: 1, llmWaiting: 1 });          // la relecture vient d'écrire : on attend
    expect(prompts[0]).toContain('HD-990935 — Prochaine action et RDV');
    const tf = JSON.parse(readFileSync(join(out, ID + '.json'), 'utf8'));
    expect(tf.tags.filter((t: any) => t.axis === 'fonction')).toEqual([{ axis: 'fonction', v: 'bouton-rappel', src: 'ia' }]);
    r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup, llm });
    expect(r.llmCalls).toBe(0);                                                           // même titre : pas de nouvelle question
    appendFileSync(join(proj, ID + '.jsonl'), title('Bouton de rappel planifié') + '\n');
    r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup, llm, now: Date.now() + 3600000 });
    expect(r).toMatchObject({ llmCalls: 1, llmWaiting: 2 });                              // titre changé + relecture finie
    expect(prompts[1]).not.toContain('datadog');
    // Échec du modèle : rien de noté, redemandé à la passe suivante.
    appendFileSync(join(proj, ID + '.jsonl'), title('Encore un titre') + '\n');
    r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup, llm: () => undefined });
    expect(r.llmFailed).toBe(1);
    expect(JSON.parse(readFileSync(join(out, ID + '.json'), 'utf8')).llm.title).toBe('Bouton de rappel planifié');
  });
  test('session du lanceur : « auto-… » écarté (l’origine le dit déjà) ; une réponse d’une version antérieure est redemandée', () => {
    const dev = feed([user('Session de DÉVELOPPEMENT automatique, lancée par `scripts/AutoDiagnostic/auto_dev.py`. HD-970504', { entrypoint: 'sdk-cli' })]);
    const llm = { at: 1, title: null, fonction: ['auto-diag-correctif', 'bdc-relance'], domaine: null, v: 2 };
    expect(decide(dev, null, cfg, llm).filter((t) => t.axis === 'fonction')).toEqual([{ axis: 'fonction', v: 'bdc-relance', src: 'ia' }]);
    const inter = feed([user('Travaille sur le lanceur')]);
    expect(vals(decide(inter, null, cfg, llm), 'fonction')).toEqual(['auto-diag-correctif', 'bdc-relance']);
    root = mkdtempSync(join(tmpdir(), 'sd-tagger-'));
    const proj = join(root, 'projects', 'C--x'); mkdirSync(proj, { recursive: true }); const out = join(root, 'tags');
    writeFileSync(join(proj, ID + '.jsonl'), [user('Bouton de rappel'), title('Bouton rappel')].join('\n') + '\n');
    const ask = (p: string) => { void p; return JSON.stringify({ s1: { fonction: ['bouton-rappel'] } }); };
    runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup: () => null, llm: ask });
    const f = join(out, ID + '.json'); const tf = JSON.parse(readFileSync(f, 'utf8'));
    tf.llm.v = 1; writeFileSync(f, JSON.stringify(tf));                       // réponse v1 : à redemander
    expect(runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup: () => null, llm: ask }).llmCalls).toBe(1);
    expect(runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup: () => null, llm: ask }).llmCalls).toBe(0);
  });
  test('v3 : bouche-trous refusés ; la demande sans titre en cache est relue et retient la question ; vocabulaire sans singletons', () => {
    for (const v of ['demande-sans-titre', 'demande-non-renseignee', 'inconnu', 'divers']) expect(isFeatureSlug(v)).toBe(false);
    root = mkdtempSync(join(tmpdir(), 'sd-tagger-'));
    const proj = join(root, 'projects', 'C--x'); mkdirSync(proj, { recursive: true }); const out = join(root, 'tags');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(proj, ID + '.jsonl'), [user('Session de DÉVELOPPEMENT automatique, lancée par `scripts/AutoDiagnostic/auto_dev.py`. HD-970504', { entrypoint: 'sdk-cli' }), title('Correctif')].join('\n') + '\n');
    writeFileSync(join(out, '_hd-domains.json'), JSON.stringify({ '970504': { domain: 'Partenaires', at: Date.now() } }));   // entrée du lot 1 : sans titre
    const prompts: string[] = [];
    const llm = (p: string) => { prompts.push(p); return JSON.stringify({ s1: { fonction: ['lien-suivi-partenaire'] } }); };
    const tight = { ...cfg, maxHdLookupsPerPass: 0 };
    let r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg: tight, hdLookup: () => ({ domain: 'Partenaires', title: 'Lien grisé' }), llm });
    expect(r.llmWaiting).toBe(0);                                         // titre inconnu, budget épuisé : on attend
    r = runPass({ projectsDir: join(root, 'projects'), outDir: out, cfg, hdLookup: () => ({ domain: 'Partenaires', title: 'Lien grisé' }), llm });
    expect(r).toMatchObject({ skipped: 1, hdLookups: 1, llmCalls: 1, llmTagged: 1 });
    expect(prompts[0]).toContain('HD-970504 — Lien grisé');
    expect(prompts[0]).toContain('Fonctionnalités déjà connues (les plus fréquentes d\'abord) : []');   // l'unique valeur n'est pas du vocabulaire
  });
  test('quota : le plus haut des comptes mesurés, null si inconnu', () => {
    root = mkdtempSync(join(tmpdir(), 'sd-quota-'));
    const p = join(root, 'u.json');
    writeFileSync(p, JSON.stringify({ a: { weeklyPct: 64 }, b: { weeklyPct: null }, c: { weeklyPct: 91.5 } }));
    expect(weeklyQuotaPct(p)).toBe(91.5);
    writeFileSync(p, JSON.stringify({ a: { weeklyPct: null } })); expect(weeklyQuotaPct(p)).toBeNull();
    expect(weeklyQuotaPct(join(root, 'absent.json'))).toBeNull();
    // Limite propre à un modèle : comptée seulement pour ce modèle ; limitsJson illisible ignoré.
    const limitsJson = JSON.stringify([{ kind: 'weekly_all', percent: 64, scope: null }, { kind: 'weekly_scoped', percent: 93, scope: { model: { display_name: 'Fable' } } }]);
    writeFileSync(p, JSON.stringify({ a: { weeklyPct: 64, limitsJson }, b: { weeklyPct: null, limitsJson: 'None' } }));
    expect(weeklyQuotaPct(p)).toBe(64);
    expect(weeklyQuotaPct(p, 'claude-haiku-5-5')).toBe(64);
    expect(weeklyQuotaPct(p, 'claude-fable-5-2')).toBe(93);
  });
});
