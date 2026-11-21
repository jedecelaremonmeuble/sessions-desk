// Brouillons de nouvelle session : formulaire enregistré sans être lancé, gardé dans un fichier d'état du poste.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanDraft, Drafts, MAX_DRAFTS } from '../src/drafts.ts';
import { PAGE_DIR } from './helpers.ts';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const FORM = { cwd: 'C:\\dev\\projet', prompt: '/cadrage HD-111111\nsuite', model: 'sonnet', branch: 'feat/x', tags: [{ axis: 'fonction', v: 'power-dial' }],
  attachments: [{ name: 'capture.png', path: 'C:\\up\\a.png', img: true, size: 2048 }] };

describe('cleanDraft', () => {
  test('formulaire complet : gardé tel quel, champs absents mis à vide', () => {
    expect(cleanDraft(FORM)).toEqual({ ...FORM, forkFrom: '', forkTitle: '', attachments: [{ name: 'capture.png', path: 'C:\\up\\a.png', img: true, size: 2048, pasted: 0 }] });
  });
  test('refusés : vide, trop long, session source invalide, trop de tags, pièce sans chemin', () => {
    expect(cleanDraft({ prompt: '   ' })).toMatch(/vide|empty/);
    expect(cleanDraft({ prompt: 'x'.repeat(20001) })).toMatch(/long/);
    expect(cleanDraft({ prompt: 'a', forkFrom: 'pas-un-id' })).toMatch(/source/);
    expect(cleanDraft({ prompt: 'a', tags: Array(9).fill({ axis: 'fonction', v: 'abc' }) })).toMatch(/8/);
    expect(cleanDraft({ prompt: 'a', attachments: [{ name: 'x' }] })).toMatch(/pièce|attachment/);
    expect(cleanDraft([])).toMatch(/objet|object/);
  });
  test('une session source seule suffit (fork sans premier message)', () => { expect(typeof cleanDraft({ forkFrom: ID1 })).toBe('object'); });
});

describe('Drafts', () => {
  let dir: string, file: string, t: number, ids: string[];
  const store = (): Drafts => new Drafts(file, () => t, () => ids.shift()!);
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sd-drafts-')); file = join(dir, 'sessions-new-drafts.json'); t = 1000; ids = [ID1, ID2]; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('enregistré, relu par un autre serveur du poste, le plus récent en tête', () => {
    const a = store();
    expect(a.save(FORM)).toEqual({ id: ID1 });
    t = 2000; expect(a.save({ prompt: 'deuxième' })).toEqual({ id: ID2 });
    const b = store();
    expect(b.list().map((d) => [d.id, d.prompt, d.createdAt])).toEqual([[ID2, 'deuxième', 2000], [ID1, FORM.prompt, 1000]]);
  });
  test('mise à jour par id : même brouillon, remonte en tête, date de création gardée', () => {
    const a = store(); a.save(FORM); t = 2000; a.save({ prompt: 'autre' });
    t = 3000; expect(a.save({ ...FORM, id: ID1, prompt: 'modifié' })).toEqual({ id: ID1 });
    const d = a.list()[0]!;
    expect([d.id, d.prompt, d.createdAt, d.updatedAt]).toEqual([ID1, 'modifié', 1000, 3000]);
    expect(a.list()).toHaveLength(2);
  });
  test('id inconnu (lancé ou supprimé ailleurs) : un brouillon neuf, rien de perdu', () => {
    const a = store(); expect(a.save({ id: ID2, prompt: 'texte tapé' })).toEqual({ id: ID1 });
  });
  test('supprimé : vrai une fois, faux ensuite', () => {
    const a = store(); a.save(FORM);
    expect(a.remove(ID1)).toBe(true); expect(a.remove(ID1)).toBe(false); expect(store().list()).toEqual([]);
  });
  test('plafond : au-delà de ' + MAX_DRAFTS + ', refus lisible', () => {
    writeFileSync(file, JSON.stringify(Array.from({ length: MAX_DRAFTS }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, prompt: 'p' + i, updatedAt: i }))));
    expect(store().save({ prompt: 'de trop' })).toMatchObject({ error: expect.stringMatching(/50/) });
  });
  test('fichier abîmé ou ligne invalide : ignorés, jamais fatals', () => {
    writeFileSync(file, '{ pas du json');
    expect(store().list()).toEqual([]);
    writeFileSync(file, JSON.stringify([{ id: 'x', prompt: 'a' }, { id: ID1, prompt: 'bon' }, null]));
    expect(store().list().map((d) => d.prompt)).toEqual(['bon']);
  });
  test('écrit en JSON lisible sur le poste', () => {
    store().save(FORM);
    expect(JSON.parse(readFileSync(file, 'utf8'))[0]).toMatchObject({ id: ID1, cwd: FORM.cwd, branch: 'feat/x' });
  });
});

describe('page : titre d’un brouillon', () => {
  const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const m = /\nfunction draftTitle\(d\) \{[\s\S]*?\n\}\n/.exec(js);
  const draftTitle = new Function('T', `${m![0]}; return draftTitle;`)((fr: string) => fr) as (d: Record<string, unknown>) => string;
  test('première ligne non vide du message, coupée à 90', () => {
    expect(draftTitle({ prompt: '\n  /cadrage HD-111111  \nsuite' })).toBe('/cadrage HD-111111');
    expect(draftTitle({ prompt: 'x'.repeat(100) })).toBe('x'.repeat(90) + '…');
  });
  test('sans message : la session source, sinon un libellé', () => {
    expect(draftTitle({ prompt: '', forkFrom: ID1, forkTitle: 'ma session' })).toBe('⑂ ma session');
    expect(draftTitle({ prompt: '' })).toBe('(sans premier message)');
  });
});
