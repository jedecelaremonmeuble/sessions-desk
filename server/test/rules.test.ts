// Règles pures du serveur Node, chacune comparée à ce que fait le .ps1 (valeurs relevées sur le serveur PowerShell).
import { describe, expect, test } from 'vitest';
import { cleanLine } from '../src/actions.ts';
import { formatLocal, psDateString } from '../src/launcher.ts';
import { matchingLines, norm, splitN, tagSlug, tagsMatch } from '../src/search.ts';
import { applyManual, checkTag, cleanTags, Dashboard, ntfsSort, parseManual } from '../src/state.ts';
import { cut, transcriptLine, type Item } from '../src/transcript.ts';
import { cleanName, extension, unescapeData } from '../src/upload.ts';
import { launchMs, roundHalfEven } from '../src/usage.ts';
import { netTrim, psIntZero, psString, psTruthy, splitPathParent, tryParseInt, tryParseUInt } from '../src/util.ts';

describe('tags corrigés à la main (Get-SessionTags, Set-SessionTag)', () => {
  const A = '11111111-2222-3333-4444-555555555555';
  test('fichier manuel : identifiants GUID en minuscules, axes modifiables seulement', () => {
    const m = parseManual({ [A]: { add: [{ axis: 'fonction', v: 'x-y' }, { axis: 'hd', v: 'HD-1' }], remove: { axis: 'outil', v: 'infra' } }, 'AAAAAAAA-2222-3333-4444-555555555555': { add: [] }, x: {} });
    expect([...m.keys()]).toEqual([A]);
    expect(m.get(A)).toEqual({ add: [{ axis: 'fonction', v: 'x-y' }], remove: [{ axis: 'outil', v: 'infra' }] });
    expect(parseManual([1]).size).toBe(0); expect(parseManual(undefined).size).toBe(0);
  });
  test('le manuel gagne : retirés écartés, ajoutés à la fin sans doublon', () => {
    const auto = [{ axis: 'outil', v: 'infra', src: 'fichiers' }, { axis: 'domaine', v: 'Compta', src: 'hd' }];
    expect(applyManual(auto, { add: [{ axis: 'domaine', v: 'Compta' }, { axis: 'fonction', v: 'f-x' }], remove: [{ axis: 'outil', v: 'infra' }] }))
      .toEqual([{ axis: 'domaine', v: 'Compta', src: 'hd' }, { axis: 'fonction', v: 'f-x', src: 'manuel' }]);
    expect(applyManual(null, { add: [], remove: [] })).toBeNull();
    expect(applyManual(auto, undefined)).toBe(auto);
  });
  test('refus nommés', () => {
    const vocab = { domaines: ['Compta'], outils: ['infra'] };
    expect(checkTag('x', 'outil', 'infra', vocab)).toBe('session inconnue');
    expect(checkTag(A, 'origine', 'automate', vocab)).toBe('axe non modifiable (domaine, outil ou fonction)');
    expect(checkTag(A, 'domaine', 'Autre', vocab)).toBe('domaine hors liste');
    expect(checkTag(A, 'fonction', 'ab', vocab)).not.toBeNull(); expect(checkTag(A, 'fonction', 'a-b-c-d-e-f', vocab)).not.toBeNull();
    expect(checkTag(A, 'fonction', 'power-dial', vocab)).toBeNull(); expect(checkTag(A, 'outil', 'infra', vocab)).toBeNull();
  });
});

describe('tags des sessions (Get-SessionTags)', () => {
  test('axe connu, valeur texte de 1 à 60 caractères, src texte sinon vide, 20 au plus ; null si rien ne reste', () => {
    expect(cleanTags([{ axis: 'outil', v: 'infra', src: 'fichiers' }, { axis: 'x', v: 'y' }, { axis: 'hd', v: '' }, { axis: 'hd', v: 1 }, null, 'a', [1], { axis: 'domaine', v: 'Compta', src: 2 }]))
      .toEqual([{ axis: 'outil', v: 'infra', src: 'fichiers' }, { axis: 'domaine', v: 'Compta', src: '' }]);
    expect(cleanTags([{ axis: 'fonction', v: 'x'.repeat(60) }])).toHaveLength(1);
    expect(cleanTags([{ axis: 'fonction', v: 'x'.repeat(61) }])).toBeNull();
    expect(cleanTags(Array.from({ length: 25 }, (_, i) => ({ axis: 'hd', v: 'HD-' + i })))).toHaveLength(20);
    expect(cleanTags({ axis: 'outil', v: 'infra' })).toBeNull(); expect(cleanTags(undefined)).toBeNull(); expect(cleanTags([])).toBeNull();
  });
});

describe('filtres de tags dans la recherche (Test-TagTokens)', () => {
  test('valeur écrite sans accents, mots reliés par « - » ; chaque filtre exigé ; « tag: » = tout axe', () => {
    expect(tagSlug('Tickets & vues')).toBe('tickets-vues'); expect(tagSlug('Téléphonie')).toBe('telephonie'); expect(tagSlug(' -BDC & paiement- ')).toBe('bdc-paiement');
    const tags = [{ axis: 'domaine', v: 'Téléphonie' }, { axis: 'fonction', v: 'power-dial' }];
    expect(tagsMatch(tags, ['domaine:telephonie', 'tag:power-dial'])).toBe(true);
    expect(tagsMatch(tags, ['domaine:telephonie', 'outil:infra'])).toBe(false);
    expect(tagsMatch(tags, ['fonction:power'])).toBe(false);
    expect(tagsMatch(null, ['tag:x'])).toBe(false); expect(tagsMatch(null, [])).toBe(true);
  });
});

describe('conversions PowerShell', () => {
  test('Trim .NET : U+FEFF n\'est pas un blanc (String.prototype.trim le retire)', () => {
    expect(netTrim('\ufeff x \u00a0')).toBe('\ufeff x');
    expect(netTrim('\u2028\u3000a\t')).toBe('a');
  });
  test('« "$x" » : null → vide, tableau joint par une espace, booléen en True/False', () => {
    expect(psString(null)).toBe(''); expect(psString(['a', 1])).toBe('a 1'); expect(psString(true)).toBe('True'); expect(psString(12)).toBe('12');
  });
  test('vérité PowerShell', () => {
    expect(psTruthy([])).toBe(false); expect(psTruthy([0])).toBe(false); expect(psTruthy([0, 0])).toBe(true); expect(psTruthy('false')).toBe(true); expect(psTruthy({})).toBe(true);
  });
  test('[int]::TryParse / [uint32]::TryParse / [int]"0$x"', () => {
    expect(tryParseInt(' +12 ')).toBe(12); expect(tryParseInt('1.0')).toBeNull(); expect(tryParseInt('2147483648')).toBeNull();
    expect(tryParseUInt('-1')).toBeNull(); expect(tryParseUInt('4294967295')).toBe(4294967295);
    expect(psIntZero(12)).toBe(12); expect(psIntZero(null)).toBe(0); expect(() => psIntZero('abc')).toThrow();
  });
  test('Split-Path -Parent', () => {
    expect(splitPathParent('C:\\a\\b')).toBe('C:\\a'); expect(splitPathParent('C:\\a')).toBe('C:\\'); expect(splitPathParent('C:\\')).toBe('');
  });
  test('arrondi .NET au pair (Math.Round, [int] d\'un double)', () => {
    expect(roundHalfEven(2.5)).toBe(2); expect(roundHalfEven(3.5)).toBe(4); expect(roundHalfEven(1.125, 2)).toBe(1.12); expect(roundHalfEven(-0.4)).toBe(-0);
  });
  test('ordre de Get-ChildItem (NTFS : majuscules, comme du texte)', () => {
    expect(ntfsSort(['37240.json', '105268.json', 'b.json', 'A.json'])).toEqual(['105268.json', '37240.json', 'A.json', 'b.json']);
  });
  test('String.Split(sep, n)', () => { expect(splitN('a b c d', ' ', 3)).toEqual(['a', 'b', 'c d']); });
});

describe('dates du lanceur', () => {
  test('ConvertTo-LaunchMs : ISO Z, décalage ; nombre ou texte illisible ⇒ 0', () => {
    expect(launchMs('2026-11-18T10:00:00Z')).toBe(Date.UTC(2026, 10, 18, 10));
    expect(launchMs('2026-11-18T11:00:00+01:00')).toBe(Date.UTC(2026, 10, 18, 10));
    expect(launchMs(1795000000000)).toBe(0); expect(launchMs('pas une date')).toBe(0);
  });
  test('« "$date" » interpolée par PowerShell : MM/dd/yyyy HH:mm:ss (clé d\'alerte du quota)', () => {
    expect(psDateString('2026-11-18T09:05:07Z')).toBe('11/18/2026 09:05:07');
    expect(psDateString('pas une date')).toBe('pas une date');
  });
  test('formatLocal : « ddd dd/MM HH:mm »', () => { expect(formatLocal(Date.now())).toMatch(/^\S+ \d{2}\/\d{2} \d{2}:\d{2}$/); });
});

describe('écran et envoi', () => {
  test('Test-ScreenIdle : « esc to interrupt » en pied, ou « ✻ Verbe… (12s » ⇒ au travail', () => {
    expect(Dashboard.screenIdle('❯ \n────\n  ? for shortcuts')).toBe(true);
    expect(Dashboard.screenIdle('x\n✻ Pondering… (12s · esc to interrupt)\n❯ ')).toBe(false);
    expect(Dashboard.screenIdle('✻ Pondering… (3s)\n❯ ')).toBe(false);
    expect(Dashboard.screenIdle('')).toBe(false);
  });
  test('ligne d\'activité : verbe et tokens du tour lus sur l\'écran', () => {
    expect(Dashboard.screenSpin('x\n✻ Pondering… (12s · ↓ 1.2k tokens · esc to interrupt)\n❯ ')).toEqual({ verb: 'Pondering', tokens: '↓ 1.2k' });
    expect(Dashboard.screenSpin('✶ Cogitating… (esc to interrupt · ctrl+t to show todos)\n❯ ')).toEqual({ verb: 'Cogitating', tokens: null });
    expect(Dashboard.screenSpin('· Writing tests…\n❯ ')).toEqual({ verb: 'Writing tests', tokens: null });
    expect(Dashboard.screenSpin('❯ Relis ça…\n⏺ Lecture…')).toBeNull();   // invite et outil : pas la ligne d'activité
    expect(Dashboard.screenSpin('❯ \n────\n  ? for shortcuts')).toBeNull();
    expect(Dashboard.screenSpin(null)).toBeNull();
  });
  test('ligne envoyée : sauts de ligne et tabulations ⇒ espace, contrôles retirés', () => {
    expect(netTrim(cleanLine('  a\r\n\tb\u0007c\u007f '))).toBe('a bc');
  });
});

describe('conversation', () => {
  test('Cut : « […] (N caractères de plus) », N au format de la culture', () => {
    const s = cut('x'.repeat(31234), 30000);
    expect(s.startsWith('x'.repeat(30000) + ' […] (')).toBe(true);
    expect(s.replace(/\D/g, '')).toBe('1234');
  });
  test('rendu : réflexion, méta, sous-agent filtrés ; outil résumé ; commande /model', () => {
    const out: Item[] = [];
    transcriptLine(JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'thinking', thinking: 'S' }, { type: 'text', text: 'je regarde' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status', description: 'Statut git' } }] } }), out);
    transcriptLine(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'M' } }), out);
    transcriptLine(JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'A' } }), out);
    transcriptLine(JSON.stringify({ type: 'user', message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' } }), out);
    transcriptLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'fatal' }] } }), out);
    expect(out).toEqual([
      { at: 't', r: 'assistant', t: 'je regarde' }, { at: 't', r: 'tool', t: 'Statut git\ngit status', n: 'Bash' },
      { at: '', r: 'user', t: '/model opus' }, { at: '', r: 'result', t: 'fatal', e: true }]);
  });
});

describe('recherche', () => {
  test('normalisation : minuscules, sans accents', () => { expect(norm('Été À ÇA')).toBe('ete a ca'); });
  test('MatchingLines : tous les mots sur la même ligne', () => {
    const t = 'a b\nc a\nb c a\n';
    expect(matchingLines(t, ['a', 'c'])).toEqual([1, 4, 7, 2, 8, 13]);
    expect(matchingLines(t, ['zz'])).toEqual([]);
  });
});

describe('pièces jointes', () => {
  test('nom nettoyé : accents retirés, caractères sûrs, « .. » écrasés, type déduit', () => {
    expect(cleanName("Capture d'écran 2026-11-17.png", 'image/png')).toBe('Capture_d_ecran_2026-11-17.png');
    expect(cleanName(null, 'image/png')).toBe('capture.png');
    expect(cleanName('..\\..\\..\\settings.json', 'application/json')).toBe('settings.json');
    expect(cleanName('....png', 'application/json')).toBe('png.json');
    expect(cleanName('a.JPEG', null)).toBe('a.jpg');
    expect(cleanName('x'.repeat(70) + '.txt', null)).toBe('x'.repeat(60) + '.txt');
  });
  test('Uri.UnescapeDataString : décode ce qui est décodable, sans lever', () => {
    expect(unescapeData('a%20b')).toBe('a b'); expect(unescapeData('%E9%20%41')).toBe('%E9 A');
  });
  test('Path.GetExtension', () => { expect(extension('a.b.png')).toBe('.png'); expect(extension('a')).toBe(''); expect(extension('a.')).toBe(''); });
});
