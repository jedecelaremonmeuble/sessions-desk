import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AskJudge, askKey, askPrompt, parseAskAnswer } from '../src/asks-judge.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('juge « attend l\'utilisateur ? »', () => {
  test('lit la ligne JSON du modèle, même entourée de texte', () => {
    expect(parseAskAnswer('{"raison": "attend le mot envoie", "qui": "utilisateur"}')).toEqual({ v: true, why: 'attend le mot envoie' });
    expect(parseAskAnswer('Voici : {"raison": "compte rendu", "qui": "personne"} fin')).toEqual({ v: false, why: 'personne : compte rendu' });
    expect(parseAskAnswer('{"raison": "attend un collègue", "qui": "tiers"}')?.v).toBe(false);
    expect(parseAskAnswer('oui')).toBeUndefined();
    expect(parseAskAnswer('{"qui": "le chef"}')).toBeUndefined();
    expect(parseAskAnswer(undefined)).toBeUndefined();
  });
  test('la question porte la fin du message', () => {
    expect(askPrompt('x'.repeat(2000) + 'Dis « envoie »')).toContain('Dis « envoie »');
  });
  test('un appel par fin de message, verdict gardé sur disque', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'askj-')); const file = join(dir, 'v.json');
    let calls = 0;
    const j = new AskJudge(file, async () => { calls++; return '{"raison": "go attendu", "qui": "utilisateur"}'; });
    expect(j.verdict('s1', 'Dis « envoie » et je le poste.')).toBeNull();
    expect(j.verdict('s1', 'Dis « envoie » et je le poste.')).toBeNull();   // déjà en cours : pas de 2e appel
    await tick(); await tick();
    expect(calls).toBe(1);
    expect(j.verdict('s1', 'Dis « envoie » et je le poste.')?.v).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))[askKey('s1', 'Dis « envoie » et je le poste.')].v).toBe(true);
    const j2 = new AskJudge(file, async () => { calls++; return undefined; });
    expect(j2.verdict('s1', 'Dis « envoie » et je le poste.')?.v).toBe(true);   // relu du disque, sans appel
    expect(calls).toBe(1);
  });
  test('échec du modèle : pas de verdict, nouvel essai plus tard seulement', async () => {
    let t = 0, calls = 0;
    const j = new AskJudge(join(mkdtempSync(join(tmpdir(), 'askj-')), 'v.json'), async () => { calls++; return undefined; }, { now: () => t });
    j.verdict('s', 'fini.'); await tick(); await tick();
    j.verdict('s', 'fini.'); await tick();
    expect(calls).toBe(1);
    t = 11 * 60000; j.verdict('s', 'fini.'); await tick(); await tick();
    expect(calls).toBe(2);
  });
});
