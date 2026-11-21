// Boutons d'action selon l'état (actionsFor, fonction PURE d'app.js extraite du fichier servi — la page n'est pas un
// module) : absente quand l'action n'a pas de sens, grisée avec sa raison quand elle en aura plus tard, UNE principale.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const js = readFileSync(fileURLToPath(new URL('../../page/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const grab = (re: RegExp, name: string): string => { const m = js.match(re); if (!m) throw new Error(name + ' introuvable dans la page'); return m[0]; };
const src = grab(/\nconst WRITE_ACTIONS = .*\n/, 'WRITE_ACTIONS') + grab(/\nfunction actionsFor\([^)]*\) \{[\s\S]*?\n\}\n/, 'actionsFor');
type Act = { id: string; label: string; title: string; primary: boolean; disabled: boolean; why: string | null };
const actionsFor = new Function('const T = (fr, en) => fr;' + src + '\nreturn actionsFor;')() as (it: object, ctx?: object) => Act[];

const ids = (l: Act[]) => l.map((a) => a.id);
const main = (l: Act[]) => l.filter((a) => a.primary).map((a) => a.id);
const get = (l: Act[], id: string) => l.find((a) => a.id === id)!;
const open = (status: string, more: object = {}) => ({ kind: 'open', key: 'k', status, state: status, ...more });

describe('actionsFor : session ouverte', () => {
  test('inactive : tout est jouable, l’onglet est le geste principal', () => {
    const l = actionsFor(open('idle'));
    expect(ids(l)).toEqual(['focus', 'copy', 'fav', 'fork', 'close', 'relaunch']);
    expect(main(l)).toEqual(['focus']);
    expect(l.every((a) => !a.disabled)).toBe(true);
  });
  test('au travail : « Fermer et rouvrir » reste visible mais grisé, avec sa raison', () => {
    const r = get(actionsFor(open('busy')), 'relaunch');
    expect(r.disabled).toBe(true);
    expect(r.why).toBe('possible seulement quand la session est inactive');
  });
  test('onglet introuvable et session inactive : la relance devient LA principale (une seule)', () => {
    const l = actionsFor(open('idle'), { noTab: true });
    expect(main(l)).toEqual(['relaunch']);
  });
  test('onglet introuvable mais session au travail : relance impossible, on retente l’onglet', () => {
    expect(main(actionsFor(open('busy'), { noTab: true }))).toEqual(['focus']);
  });
  test('à distance : pas d’« Afficher l’onglet » (l’onglet est sur le poste) ; lecture seule : écritures grisées', () => {
    expect(ids(actionsFor(open('idle'), { remote: true }))).not.toContain('focus');
    const ro = actionsFor(open('idle'), { remote: true, canWrite: false });
    expect(get(ro, 'close')).toMatchObject({ disabled: true, why: 'lecture seule à distance' });
    expect(get(ro, 'copy').disabled).toBe(false);
    expect(main(ro)).toEqual([]);
  });
  test('favori : libellé selon l’état', () => {
    expect(get(actionsFor(open('idle', { fav: true })), 'fav').label).toBe('★ Favori');
    expect(get(actionsFor(open('idle')), 'fav').label).toBe('☆ Favori');
  });
});

describe('actionsFor : autres cas', () => {
  test('fermée : rouvrir en principal, masquer / ré-afficher, ni fermer ni relancer', () => {
    const l = actionsFor({ kind: 'closed', key: 'k' });
    expect(ids(l)).toEqual(['reopen', 'copy', 'fav', 'fork', 'hide']);
    expect(main(l)).toEqual(['reopen']);
    expect(get(actionsFor({ kind: 'closed', key: 'k', hidden: true }), 'hide').label).toBe('Ré-afficher dans la liste');
  });
  test('automate sans terminal : seulement le favori, aucune principale', () => {
    const l = actionsFor(open('busy', { headless: true }));
    expect(ids(l)).toEqual(['fav']);
    expect(main(l)).toEqual([]);
  });
  test('run du lanceur : « Reprendre » seulement une fois terminé et s’il a une session', () => {
    const sid = '11111111-2222-3333-4444-555555555555';
    expect(ids(actionsFor({ kind: 'run', key: 'hd:1', run: { running: true, sessionId: sid } }))).toEqual(['launcher']);
    const done = actionsFor({ kind: 'run', key: 'hd:1', run: { running: false, sessionId: sid } });
    expect(ids(done)).toEqual(['resume', 'launcher']);
    expect(main(done)).toEqual(['resume']);
    expect(ids(actionsFor({ kind: 'run', key: 'hd:1', run: { running: false, sessionId: null } }))).toEqual(['launcher']);
  });
  test('jamais plus d’une principale, jamais une principale grisée', () => {
    for (const st of ['idle', 'busy', 'waiting', 'shell'])
      for (const ctx of [{}, { noTab: true }, { remote: true }, { canWrite: false }]) {
        const l = actionsFor(open(st), ctx);
        expect(l.filter((a) => a.primary).length).toBeLessThanOrEqual(1);
        expect(l.some((a) => a.primary && a.disabled)).toBe(false);
      }
  });
});
