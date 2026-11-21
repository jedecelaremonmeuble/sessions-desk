// Questions mises de côté par « Chat about this » : relues dans le transcript (parked.ts), gardées par la page.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parkedFromLines, parkedQuestions } from '../src/parked.ts';
import { PAGE_DIR } from './helpers.ts';

const ask = (id: string, questions: unknown[]): string => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const result = (id: string, text: string, err = true): string => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: text }] } });
const said = (text: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ type: 'user', message: { content: text }, ...extra });
const claude = (text: string): string => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const CLARIFY = 'The user doesn\'t want to proceed with this tool use. To tell you how to proceed, the user said:\nThe user wants to clarify these questions.\n    Questions asked:\n- "Quelle reprise ?"\n  (No answer provided)';
const Q = [
  { question: 'Quelle reprise après une coupure ?', header: 'Reprise', multiSelect: false, options: [{ label: 'Native (Recommandé)', description: 'Le plus petit changement.' }, { label: 'Rouvrir un flux', description: 'Même coût, plus de code.' }] },
  { question: 'Quel diagnostic ?', header: 'Diagnostic', multiSelect: true, options: [{ label: 'Journal complet', description: '' }] },
];

describe('questions mises de côté', () => {
  test('« Chat about this » : les questions et leurs options restent lisibles', () => {
    const p = parkedFromLines([said('cadre le sujet'), ask('toolu_1', Q), result('toolu_1', CLARIFY), claude('Que veux-tu préciser ?')]);
    expect(p).toEqual({ id: 'toolu_1', replies: 0, questions: [
      { header: 'Reprise', question: 'Quelle reprise après une coupure ?', multi: false, options: [{ label: 'Native (Recommandé)', description: 'Le plus petit changement.' }, { label: 'Rouvrir un flux', description: 'Même coût, plus de code.' }] },
      { header: 'Diagnostic', question: 'Quel diagnostic ?', multi: true, options: [{ label: 'Journal complet', description: '' }] },
    ] });
  });
  test('chaque message de la personne est compté, pas les messages injectés ni les commandes', () => {
    const p = parkedFromLines([ask('toolu_1', Q), result('toolu_1', CLARIFY), said('combien coûte la native ?'), claude('2,7 c$/min'),
      said('fin de tâche', { origin: { kind: 'task-notification' } }), said('<command-name>/compact</command-name>'), said('note', { isMeta: true }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'et avec une image' }, { type: 'image' }] } })]);
    expect(p?.replies).toBe(2);
  });
  test('une réponse donnée, un refus ordinaire ou un dialogue encore ouvert ne mettent rien de côté', () => {
    expect(parkedFromLines([ask('toolu_1', Q), result('toolu_1', 'User has answered your questions: …', false)])).toBeNull();
    expect(parkedFromLines([ask('toolu_1', Q), result('toolu_1', 'The user doesn\'t want to proceed with this tool use.')])).toBeNull();
    expect(parkedFromLines([ask('toolu_1', Q)])).toBeNull();
    expect(parkedFromLines([result('toolu_1', CLARIFY)])).toBeNull();   // l'appel est sorti de la fenêtre lue
  });
  test('une nouvelle question remplace celles mises de côté', () => {
    expect(parkedFromLines([ask('toolu_1', Q), result('toolu_1', CLARIFY), said('précision'), ask('toolu_2', Q)])).toBeNull();
    expect(parkedFromLines([ask('toolu_1', Q), result('toolu_1', CLARIFY), ask('toolu_2', [Q[1]]), result('toolu_2', CLARIFY)])?.questions.map((q) => q.header)).toEqual(['Diagnostic']);
  });
  test('sous-agents, lignes illisibles et entrées mal formées sont ignorés', () => {
    const side = JSON.stringify({ ...JSON.parse(ask('toolu_9', Q)), isSidechain: true });
    expect(parkedFromLines(['{pas du json "user"', side, result('toolu_9', CLARIFY), ask('toolu_1', [{ question: '' }, 7, { question: 'Seule ?', options: [{ label: '' }, null] }]), result('toolu_1', CLARIFY)]))
      .toEqual({ id: 'toolu_1', replies: 0, questions: [{ header: '', question: 'Seule ?', multi: false, options: [] }] });
  });
  test('lecture du fichier : relue quand il grossit, null s\'il manque', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sd-parked-')); const f = join(dir, 't.jsonl');
    try {
      expect(parkedQuestions(f)).toBeNull();
      writeFileSync(f, [ask('toolu_1', Q), result('toolu_1', CLARIFY)].join('\n') + '\n');
      expect(parkedQuestions(f)?.replies).toBe(0);
      appendFileSync(f, said('une précision') + '\n');
      expect(parkedQuestions(f)?.replies).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('page', () => {
  const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  test('cliquer une option la recopie dans la réponse, à la suite de ce qui est déjà écrit', () => {
    const m = /\nfunction parkedPick\(v, q, n, o\) \{[\s\S]*?\n\}\n/.exec(js);
    expect(m).not.toBeNull();
    const pick = new Function('T', `${m![0]}; return parkedPick;`)((fr: string) => fr) as (v: string, q: unknown, n: number, o: unknown) => string;
    expect(pick('', { header: 'Reprise' }, 1, { label: 'Native' })).toBe('Reprise : Native');
    expect(pick('déjà écrit\n\n', { header: '' }, 2, { label: 'Journal complet' })).toBe('déjà écrit\nQuestion 2 : Journal complet');
  });
  test('la carte ne tape rien dans le terminal, et les touches 1 à 9 ne la visent pas', () => {
    const m = /\nfunction renderParked\(box, p\) \{[\s\S]*?\n\}\n/.exec(js);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain('sendKeys');
    expect(js).toContain("querySelectorAll('button.opt:not(.pk)')");
    expect(js).toContain('renderDialog(it, r.text || \'\', r.draft, r.parked || null)');
  });
});
