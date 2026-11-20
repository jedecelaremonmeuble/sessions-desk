// Cartes de questions de l'orchestrateur (src/cards.ts) : answerBody (pure), puis lookupCards / answerCard / CardsFeed
// contre une FAUSSE commande des cartes (SD_LAUNCHER_CARDS_API) — jamais un vrai ticket.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { answerBody, answerCard, CardsFeed, lookupCards } from '../src/cards.ts';

describe('answerBody : ce que la commande reçoit', () => {
  test('choix, texte libre, réponses vides retirées, numéros acceptés', () => {
    expect(answerBody({ hd: 42, card: 7, answers: [{ questionId: 'q1', selected: ['a'] }, { questionId: 'date', other: '  27/11 ' }, { questionId: 'vide', selected: [], other: ' ' }] }))
      .toEqual({ hd: '42', card: '7', answers: [{ questionId: 'q1', selected: ['a'], other: null }, { questionId: 'date', selected: [], other: '27/11' }] });
  });
  test('demande invalide', () => {
    const ok = { hd: '42', card: '7', answers: [{ questionId: 'q', selected: ['a'] }] };
    expect(answerBody(ok)).not.toBeNull();
    for (const j of [null, [ok], 'x', { ...ok, hd: '0' }, { ...ok, hd: '../1' }, { ...ok, card: 'abc' }, { ...ok, answers: [] }, { ...ok, answers: 'x' },
      { ...ok, answers: [{ selected: ['a'] }] }, { ...ok, answers: [{ questionId: '--dry-run', selected: ['a'] }] }, { ...ok, answers: [{ questionId: 'q', selected: 'a' }] },
      { ...ok, answers: [{ questionId: 'q', selected: ['a b'] }] }, { ...ok, answers: [{ questionId: 'q', other: 3 }] }, { ...ok, answers: [{ questionId: 'q', other: 'x'.repeat(2001) }] },
      { ...ok, answers: [{ questionId: 'q', selected: [], other: '  ' }] }, { ...ok, answers: Array.from({ length: 9 }, () => ({ questionId: 'q', selected: ['a'] })) }]) expect(answerBody(j)).toBeNull();
  });
});

describe('contre une fausse commande des cartes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-cards-'));
  const api = join(dir, 'fake_cards.py'), log = join(dir, 'argv.json'), seenAnswers = join(dir, 'answers.json'), count = join(dir, 'count.txt');
  writeFileSync(api, [
    'import json, sys, os',
    `log, seen, count = ${JSON.stringify(log)}, ${JSON.stringify(seenAnswers)}, ${JSON.stringify(count)}`,
    'open(log, "w", encoding="utf-8").write(json.dumps(sys.argv[1:], ensure_ascii=False))',
    'card = {"id": 7, "interaction": 1, "kind": "arbitrage", "flavor": "arbitrage", "addressee": "é", "neighbours": 0, "questions": [{"id": "q", "header": "H", "question": "Q ?", "options": [{"id": "a", "label": "A"}]}]}',
    'cmd = sys.argv[1]',
    'if cmd == "pending":',
    '    n = int(open(count).read()) + 1 if os.path.exists(count) else 1',
    '    open(count, "w").write(str(n))',
    '    print("bruit avant"); print(json.dumps({"token": "ok", "cards": [{"hd": "42", "title": "T", **card}], "errors": [], "more": 0}))',
    'elif cmd == "cards":',
    '    print(json.dumps({"token": "ok", "hd": sys.argv[2], "cards": [] if sys.argv[2] == "9" else [card]}))',
    'elif cmd == "answer":',
    '    open(seen, "w", encoding="utf-8").write(open(sys.argv[sys.argv.index("--answers-file") + 1], encoding="utf-8").read())',
    '    if sys.argv[2] == "9": print(json.dumps({"ok": False, "gone": True, "error": "cette carte n\'attend plus de réponse"})); sys.exit(1)',
    '    if sys.argv[2] == "8": print("Traceback"); sys.exit(2)',
    '    print(json.dumps({"ok": True, "note": 4242}))',
  ].join('\n'), 'utf8');
  const env = { ...process.env, SD_LAUNCHER_CARDS_API: api };
  const bare = { ...process.env, SD_LAUNCHER_CARDS_API: '' };
  // Un relevé d'arrière-plan peut encore tenir le dossier (cwd de la commande) : on réessaie.
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

  test('lookupCards : cartes d’un ticket, relues à chaque appel ; numéro invalide refusé sans rien lancer', async () => {
    const r = await lookupCards('42', env);
    expect((r.cards as { id: number; addressee: string }[])[0]).toMatchObject({ id: 7, addressee: 'é' });
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(['cards', '42']);
    expect(await lookupCards('4 2', env)).toEqual({ error: 'demande invalide' });
  });
  test('non configuré ou introuvable ⇒ erreur dite, rien lancé', async () => {
    expect(await lookupCards('42', bare, null)).toEqual({ error: 'cartes non configurées (modules.launcher.cardsApi)' });
    expect((await lookupCards('42', bare, { cardsApi: join(dir, 'absent.py'), python: 'python' })).error).toContain('introuvable');
    expect((await lookupCards('42', bare, { cardsApi: api, python: 'python' })).hd).toBe('42');
  });
  test('answerCard : réponses passées par fichier, tel quel ; note rendue', async () => {
    const r = await answerCard({ hd: '42', card: '7', answers: [{ questionId: 'q', selected: ['a'], other: 'a "b" & é' }] }, env);
    expect(r).toEqual({ ok: true, note: 4242 });
    const argv = JSON.parse(readFileSync(log, 'utf8')) as string[];
    expect(argv.slice(0, 4)).toEqual(['answer', '42', '7', '--answers-file']);
    expect(JSON.parse(readFileSync(seenAnswers, 'utf8'))).toEqual({ answers: [{ questionId: 'q', selected: ['a'], other: 'a "b" & é' }] });
    expect(() => readFileSync(argv[4]!, 'utf8')).toThrow();   // le fichier temporaire est retiré
  });
  test('answerCard : carte qui n’attend plus, commande en panne, corps invalide', async () => {
    const body = (hd: string) => ({ hd, card: '7', answers: [{ questionId: 'q', selected: ['a'] }] });
    expect(await answerCard(body('9'), env)).toEqual({ ok: false, gone: true, error: 'cette carte n\'attend plus de réponse' });
    expect(await answerCard(body('8'), env)).toEqual({ ok: false, error: 'cartes illisibles : la commande a échoué' });
    expect(await answerCard({ hd: '42', card: '7', answers: [] }, env)).toEqual({ ok: false, error: 'demande invalide' });
  });
  test('CardsFeed : relevé rendu sans attendre, rafraîchi en arrière-plan, carte répondue retirée tout de suite', async () => {
    const feed = new CardsFeed(null, env);
    expect(feed.configured).toBe(true);
    expect(feed.current().token).toBe('unknown');           // premier appel : rien encore, le relevé part
    const v = await feed.refresh();
    expect(v.token).toBe('ok');
    expect((feed.current().cards as unknown[]).length).toBe(1);
    const before = Number(readFileSync(count, 'utf8'));
    feed.current(); feed.current();
    expect(Number(readFileSync(count, 'utf8'))).toBe(before);   // relevé frais : pas de nouvelle lecture
    feed.drop('42', '7');
    expect(feed.current().cards).toEqual([]);
    await new Promise((r) => setTimeout(r, 1500));          // laisse finir le relevé d'arrière-plan que `drop` a déclenché
  });
  test('CardsFeed éteint sans commande', () => {
    const feed = new CardsFeed(null, bare);
    expect(feed.configured).toBe(false);
    expect(feed.current()).toEqual({ token: 'off', cards: [], errors: [] });
  });
});
