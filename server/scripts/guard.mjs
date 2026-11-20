// GARDE DES RÉFÉRENCES INTERNES — rien de propre à l'équipe d'origine ne doit entrer dans ce qui est publié.
//
//   node server/scripts/guard.mjs            fichiers suivis par git, hors fichiers dispensés (PRIVATE ci-dessous)
//   node server/scripts/guard.mjs --text     le texte reçu sur l'entrée standard (titre de PR, messages de commit)
//
// Motifs génériques : ci-dessous. Noms propres (collègues, clients) : jamais dans le dépôt — variable
// SD_GUARD_NAMES, une expression régulière d'alternatives (secret de CI). Exceptions : guard-allow.txt, une par
// ligne « chemin <tab> expression régulière <tab> raison » ; une exception ne vaut que pour ce fichier.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

/** Dispensés du contrôle des références internes : le serveur PowerShell historique (non publié) et l'étiqueteur de
 *  tags, publié tel quel — ses règles décrivent le dépôt de l'équipe d'origine. La recherche de secrets (gitleaks),
 *  elle, lit tout. */
export const PRIVATE = [/^legacy\/(?!sessions-dashboard-page\/)/, /^server\/src\/tagger(\.ts|-config\.json)$/, /^server\/test\/tagger\.test\.ts$/];
/** Jamais lus : générés, ou le garde lui-même (il porte les motifs). */
const SKIP = [/^server\/package-lock\.json$/, /^server\/scripts\/guard(\.mjs|-allow\.txt)$/, /^server\/test\/guard\.test\.ts$/, /\.(png|ico|jpg|gif|exe|dll)$/i];

/** Numéros de ticket manifestement fictifs, admis dans les jeux de tests. */
const FAKE_TICKET = /^(?:(\d)\1{5}|123456|654321)$/;

/** [nom, expression, filtre facultatif sur la correspondance]. */
export const RULES = [
  ['organisation', /jd2m|jedeclaremonmeuble|jedecelaremonmeuble|elm-conseil/gi],
  ['produit interne', /hubdesk|hd_api|auto[_-]diagnostic/gi],
  ['chemin du poste', /[a-z]:[\\/]+sources\b|\bjunic\b|[\\/]users[\\/](?!moi\b|me\b|user\b|x\b|runner)[a-z0-9._-]+/gi],
  ['ticket réel', /\bHD-(\d{6})\b/gi, (m) => !FAKE_TICKET.test(m[1])],
  ['adresse', /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi, (m) => !/(^|\.)(example\.(com|org|net)|exemple\.fr|anthropic\.com|users\.noreply\.github\.com|unq\.gbl\.spaces|thread\.v2)$/i.test(m[1]) && !/^\d/.test(m[1])],
  ['document interne', /docs\/[A-Za-z0-9]+-Cadrage\.md|[A-Za-z0-9]+-Cadrage\.md/g],
];

export function namesRule(env = process.env) {
  const src = (env.SD_GUARD_NAMES ?? '').trim();
  if (!src) return null;
  return ['nom propre', new RegExp('(?<![\\p{L}\\p{N}_])(?:' + src + ')(?![\\p{L}\\p{N}_])', 'giu')];
}

export function parseAllow(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const [path, re, reason] = l.split('\t');
    if (!path || !re || !reason) throw new Error(`guard-allow.txt : « chemin <tab> expression <tab> raison » attendu — ${l}`);
    out.push({ path, re: new RegExp(re, 'i') });
  }
  return out;
}

/** Constats d'un texte : { rule, line, match }. `allow` : expressions qui excusent la LIGNE entière. */
export function scan(text, rules, allow = []) {
  const found = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (allow.some((a) => a.test(line))) continue;
    for (const [rule, re, keep] of rules) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) if (!keep || keep(m)) found.push({ rule, line: i + 1, match: m[0] });
    }
  }
  return found;
}

export const isPrivate = (path) => PRIVATE.some((r) => r.test(path));

function main(argv) {
  const rules = [...RULES]; const names = namesRule(); if (names) rules.push(names);
  if (argv.includes('--text')) {
    const found = scan(readFileSync(0, 'utf8'), rules);
    for (const f of found) console.error(`texte:${f.line}: ${f.rule} — ${f.match}`);
    if (found.length) { console.error(`\n${found.length} référence(s) interne(s) dans le texte (titre de PR ou message de commit).`); return 1; }
    return 0;
  }
  let allow = [];
  try { allow = parseAllow(readFileSync(join(HERE, 'guard-allow.txt'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
    .filter((f) => !isPrivate(f) && !SKIP.some((r) => r.test(f)));
  let n = 0;
  for (const f of files) {
    let text; try { text = readFileSync(join(REPO, f), 'utf8'); } catch { continue; }
    for (const x of scan(text, rules, allow.filter((a) => a.path === f).map((a) => a.re))) { console.error(`${f}:${x.line}: ${x.rule} — ${x.match}`); n++; }
  }
  if (n) { console.error(`\n${n} référence(s) interne(s) dans ${files.length} fichiers publiés. Corriger, ou justifier dans server/scripts/guard-allow.txt.`); return 1; }
  console.log(`garde : ${files.length} fichiers publiés, aucune référence interne${names ? '' : ' (noms propres non contrôlés : SD_GUARD_NAMES absent)'}.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
