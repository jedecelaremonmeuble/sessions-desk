// Garde des références internes (scripts/guard.mjs) : ce qu'il refuse, ce qu'il laisse passer.
import { describe, expect, test } from 'vitest';
// @ts-expect-error — script .mjs sans déclaration de types
import { isPrivate, namesRule, parseAllow, RULES, scan } from '../scripts/guard.mjs';

const rulesOf = (text: string, rules = RULES, allow: RegExp[] = []): string[] => scan(text, rules, allow).map((f: { rule: string }) => f.rule);
// Les exemples sont composés à l'exécution : ce fichier ne doit porter aucun des motifs qu'il teste.
const ORG = ['jd', '2m'].join(''); const TOOL = ['hub', 'desk'].join(''); const DISK = ['C:', 'Sources', 'x'].join('\\');

describe('garde : motifs génériques', () => {
  test('organisation, produit interne, chemin du poste', () => {
    expect(rulesOf(`dépôt ${ORG}/x`)).toEqual(['organisation']);
    expect(rulesOf(`lit ${TOOL.toUpperCase()}`)).toEqual(['produit interne']);
    expect(rulesOf(`cd ${DISK}`)).toEqual(['chemin du poste']);
    expect(rulesOf('C:\\Users\\moi\\AppData et C:\\Users\\runneradmin')).toEqual([]);
  });

  test('ticket : un numéro fictif passe, un numéro plausible est refusé', () => {
    for (const ok of ['HD-111111', 'hd-999999', 'HD-123456', 'HD-1', 'HD-\\d{6}']) expect(rulesOf(ok), ok).toEqual([]);
    expect(rulesOf('voir HD-' + '987' + '654')).toEqual(['ticket réel']);
  });

  test('adresse : les domaines d\'exemple et les identifiants de chat passent', () => {
    for (const ok of ['a@example.com', 'x@exemple.fr', 'noreply@anthropic.com', '19:abc@thread.v2', 'a_b@unq.gbl.spaces', 'pkg@1.2.3']) expect(rulesOf(ok), ok).toEqual([]);
    expect(rulesOf('prenom.nom@societe.fr')).toEqual(['adresse']);
  });

  test('document interne', () => {
    expect(rulesOf('voir docs/' + 'Machin' + '-Cadrage.md')).toEqual(['document interne']);
  });
});

describe('garde : noms propres et exceptions', () => {
  test('SD_GUARD_NAMES : mot entier, sans casse ni accent oublié ; absent ⇒ pas de règle', () => {
    expect(namesRule({})).toBeNull();
    const r = [namesRule({ SD_GUARD_NAMES: 'dupont|zo[ée]' })];
    expect(rulesOf('demander à Dupont', r)).toEqual(['nom propre']);
    expect(rulesOf('Zoé relit', r)).toEqual(['nom propre']);
    expect(rulesOf('byDupont, dupontel, zoetrope', r)).toEqual([]);
  });

  test('une exception excuse la ligne, pour son seul fichier', () => {
    const allow = parseAllow(`# commentaire\nserver/x.ts\t${ORG}-dossier\tlu en dur par un tiers\n`);
    expect(allow).toHaveLength(1); expect(allow[0].path).toBe('server/x.ts');
    expect(rulesOf(`const d = '${ORG}-dossier';`, RULES, [allow[0].re])).toEqual([]);
    expect(rulesOf(`const d = '${ORG}-autre';`, RULES, [allow[0].re])).toEqual(['organisation']);
    expect(() => parseAllow('server/x.ts\tmotif')).toThrow(/raison/);
  });

  test('périmètre privé : le serveur historique et l\'étiqueteur, pas la page', () => {
    expect(isPrivate('legacy/sessions-dashboard.ps1')).toBe(true);
    expect(isPrivate('server/src/tagger.ts')).toBe(true);
    expect(isPrivate('legacy/sessions-dashboard-page/app.js')).toBe(false);
    expect(isPrivate('server/src/http.ts')).toBe(false);
  });
});
