// La demande derrière un run (en-tête du détail) : hdSummary (Get-LauncherHdSummary du .ps1) et lookupHd contre un
// FAUX lecteur de tickets (SD_LAUNCHER_TICKET_API) — jamais le vrai, qui lit un vrai outil de tickets.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { hdSummary, lookupHd } from '../src/launcher.ts';

const TICKET = {
  id: 111111, title: 'Afficher le fuseau horaire', description: 'Le problème :\n\n  client en Chine', status: 'New', priority: 'Medium',
  createdAt: '2026-11-19T12:52:00.815874', assignee: 'abc', requesterAgentId: 'a-1',
  mentionable: [{ agentId: 'a-2', label: 'TECHNIQUE Assistant' }, { agentId: 'a-1', label: 'MARTIN Camille' }],
  linkedClientIds: ['c-1'], interactions: [{ id: 1, text: 'jamais renvoyé' }], autoNoteRefusal: 'x',
  internalRequest: { kind: 'Idee', domain: null, severity: null, teamsWebUrl: 'https://teams.microsoft.com/l/message/1' },
};

describe('hdSummary : ce que l\'en-tête affiche, rien de plus', () => {
  test('demandeur = libellé du participant qui a ouvert la demande ; description ramenée à une ligne', () => {
    expect(hdSummary(TICKET)).toEqual({
      hd: 111111, title: 'Afficher le fuseau horaire', requester: 'MARTIN Camille', createdAt: '2026-11-19T12:52:00.815874',
      status: 'New', priority: 'Medium', assignee: 'abc', kind: 'Idee', domain: null, severity: null, clients: 1,
      teamsUrl: 'https://teams.microsoft.com/l/message/1', description: 'Le problème : client en Chine',
    });
  });
  test('description coupée à 400 caractères, lien Teams hors teams.microsoft.com écarté, demandeur inconnu = null', () => {
    const s = hdSummary({ ...TICKET, description: 'x'.repeat(500), requesterAgentId: 'zz', internalRequest: { teamsWebUrl: 'javascript:alert(1)' }, linkedClientIds: null })!;
    expect(String(s.description)).toHaveLength(400);
    expect(String(s.description).endsWith('…')).toBe(true);
    expect(s.teamsUrl).toBeNull(); expect(s.requester).toBeNull(); expect(s.clients).toBe(0); expect(s.kind).toBeNull();
  });
  test('réponse inexploitable ⇒ null', () => {
    for (const j of [null, [], 'x', {}, { id: 0 }, { id: 'abc' }]) expect(hdSummary(j)).toBeNull();
  });
});

describe('lookupHd : contre un faux lecteur de tickets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-hd-'));
  const api = join(dir, 'fake_tickets.py');
  writeFileSync(api, [
    'import json, sys',
    'if sys.argv[1:3] != ["ticket", sys.argv[2]] or "--max-chars" not in sys.argv: sys.exit(3)',
    'if sys.argv[2] == "404": print("introuvable", file=sys.stderr); sys.exit(1)',
    `print(json.dumps({**json.loads(${JSON.stringify(JSON.stringify(TICKET))}), "id": int(sys.argv[2])}, ensure_ascii=False))`,
  ].join('\n'));
  const env = { ...process.env, SD_LAUNCHER_TICKET_API: api };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('lit la demande et en rend le résumé', async () => {
    const v = await lookupHd('123', env);
    expect(v.hd).toBe(123); expect(v.requester).toBe('MARTIN Camille'); expect(v).not.toHaveProperty('interactions');
  });
  test('échec de la lecture ⇒ erreur lisible ; numéro invalide ⇒ rien lancé', async () => {
    expect((await lookupHd('404', env)).error).toMatch(/demande illisible/);
    for (const hd of ['', '0', '12a', '../1', '1234567890']) expect(await lookupHd(hd, env)).toEqual({ error: 'demande invalide' });
  });
  test('commande tirée du module lanceur (ticketApi) ; module non configuré ⇒ erreur, rien lancé', async () => {
    const bare = { ...process.env }; delete bare.SD_LAUNCHER_CLI; delete bare.SD_LAUNCHER_TICKET_API;
    expect((await lookupHd('88', bare)).error).toMatch(/non configurée/);
    expect((await lookupHd('89', bare, { ticketApi: api, python: 'python' })).requester).toBe('MARTIN Camille');
  });
  test('script absent ⇒ erreur qui le nomme', async () => {
    expect((await lookupHd('77', { ...process.env, SD_LAUNCHER_TICKET_API: join(dir, 'absent.py') })).error).toMatch(/introuvable/);
  });
});
