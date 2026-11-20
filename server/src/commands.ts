// COMMANDES « / » — ce que la page propose quand on tape « / » dans la zone de réponse, et la garde qui va avec.
//
// Une commande part comme n'importe quel message : la page tape la ligne dans la console, puis Entrée. Trois choses
// manquaient pour s'en servir sans le terminal :
//   - la LISTE : Claude Code ne publie nulle part les commandes d'une session interactive. On la reconstitue : les
//     commandes intégrées (table ci-dessous, à relire à chaque montée de version) + ce qui se lit sur le disque
//     (skills et commandes de l'utilisateur, du dossier de la session et de ses parents, des plugins activés) ;
//   - la GARDE : dans Claude Code, Entrée exécute la suggestion surlignée dès que les lettres tapées ressemblent à
//     un nom — « /mod » lance /model. Une commande absente de la liste est donc refusée, sauf demande explicite
//     (`force`) : la liste peut être en retard sur la session ;
//   - les AVERTISSEMENTS : ce qui ouvre un menu dans le terminal (`dialog`), ce qui ne se rattrape pas (`risky`),
//     ce qui change aussi le réglage par défaut des prochaines sessions (`persist`), ce qui s'exécute tout de
//     suite même pendant un tour (`immediate` ; le reste attend la fin du tour, en file).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { T } from './i18n.ts';
import { isDir, isFile, readJson, stripBom } from './util.ts';

/** `dialog` : 'always' = ouvre toujours un menu ; 'bare' = seulement sans argument (« /mcp » oui, « /mcp reconnect all » non). */
export interface SlashCommand {
  name: string; desc: string; args: string; source: 'builtin' | 'user' | 'project' | 'plugin';
  dialog: '' | 'bare' | 'always'; risky: boolean; persist: boolean; immediate: boolean;
  /** Formes prêtes à l'emploi, sans menu (« /mcp reconnect all »). */
  forms: string[];
}
interface Builtin { n: string; fr: string; en: string; a?: string; d?: 'bare' | 'always'; r?: true; p?: true; i?: true; f?: string[] }

// Relevé sur Claude Code 2.1.x. Une commande qui manque ici n'est pas interdite : la page propose « Envoyer quand même ».
const BUILTINS: readonly Builtin[] = [
  { n: '/add-dir', fr: 'Ajouter un dossier de travail', en: 'Add a working directory', a: '<chemin>' },
  { n: '/agents', fr: 'Sous-agents disponibles', en: 'Available subagents' },
  { n: '/btw', fr: 'Question en aparté, sans interrompre le tour', en: 'Side question, without interrupting the turn', a: '<question>', i: true },
  { n: '/clear', fr: 'Effacer la conversation et repartir de zéro', en: 'Clear the conversation and start over', r: true },
  { n: '/compact', fr: 'Résumer la conversation pour libérer du contexte', en: 'Summarise the conversation to free context', a: '[consignes]' },
  { n: '/config', fr: 'Réglages de Claude Code', en: 'Claude Code settings', a: '[clé=valeur]', d: 'bare', p: true },
  { n: '/context', fr: 'Occupation du contexte', en: 'Context usage' },
  { n: '/copy', fr: 'Copier la dernière réponse', en: 'Copy the last answer', d: 'always' },
  { n: '/cost', fr: 'Consommation (comme /usage)', en: 'Usage (same as /usage)', d: 'always', i: true },
  { n: '/doctor', fr: 'Diagnostic de l’installation', en: 'Installation check', d: 'always' },
  { n: '/effort', fr: 'Niveau d’effort de réflexion', en: 'Reasoning effort level', a: '<low|medium|high|auto>', d: 'bare', p: true, i: true },
  { n: '/exit', fr: 'Quitter la session', en: 'Quit the session', r: true },
  { n: '/export', fr: 'Exporter la conversation', en: 'Export the conversation', a: '[fichier]', d: 'bare' },
  { n: '/fast', fr: 'Mode rapide', en: 'Fast mode', i: true },
  { n: '/help', fr: 'Aide et commandes disponibles', en: 'Help and available commands', d: 'always' },
  { n: '/hooks', fr: 'Hooks configurés', en: 'Configured hooks', d: 'always' },
  { n: '/init', fr: 'Écrire le CLAUDE.md du projet', en: 'Write the project CLAUDE.md' },
  { n: '/login', fr: 'Changer de compte', en: 'Switch account', d: 'always', r: true },
  { n: '/logout', fr: 'Se déconnecter', en: 'Sign out', r: true },
  { n: '/mcp', fr: 'Serveurs MCP : état, reconnexion, authentification', en: 'MCP servers: status, reconnect, sign-in', a: '[reconnect|enable|disable <serveur|all>]', d: 'bare', f: ['/mcp reconnect all'] },
  { n: '/memory', fr: 'Fichiers de mémoire', en: 'Memory files', d: 'always' },
  { n: '/model', fr: 'Changer de modèle', en: 'Switch model', a: '[nom]', d: 'bare', p: true, i: true },
  { n: '/permissions', fr: 'Règles d’autorisation des outils', en: 'Tool permission rules', d: 'always' },
  { n: '/plugin', fr: 'Plugins', en: 'Plugins', a: '[list|install|enable|disable]', d: 'bare' },
  { n: '/rename', fr: 'Renommer la session', en: 'Rename the session', a: '<nom>' },
  { n: '/resume', fr: 'Reprendre une autre conversation', en: 'Resume another conversation', a: '[nom|id]', d: 'bare', r: true },
  { n: '/review', fr: 'Relire le code modifié', en: 'Review the changed code' },
  { n: '/rewind', fr: 'Revenir à un point antérieur', en: 'Rewind to an earlier point', d: 'always', r: true },
  { n: '/skills', fr: 'Skills disponibles', en: 'Available skills', d: 'always' },
  { n: '/status', fr: 'État de la session et du compte', en: 'Session and account status', d: 'always', i: true },
  { n: '/statusline', fr: 'Configurer la barre de statut', en: 'Configure the status line' },
  { n: '/tasks', fr: 'Tâches de fond', en: 'Background tasks', d: 'always', i: true },
  { n: '/usage', fr: 'Quota et consommation', en: 'Quota and usage', d: 'always', i: true },
];

const NAME = /^\/[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
/** La commande d'une ligne : son premier mot s'il a la forme « /nom » (minuscules), sinon null. Un chemin
 *  (« /api/send est cassé ») ou une barre seule n'est pas une commande : le message part comme avant. */
export function commandOf(line: string): string | null {
  const first = line.trimStart().split(/\s/, 1)[0] ?? '';
  return NAME.test(first) ? first.toLowerCase() : null;
}
/** La ligne a-t-elle des arguments après le nom ? (« /mcp » : non ; « /mcp reconnect all » : oui) */
export const hasArgs = (line: string): boolean => /^\s*\S+\s+\S/.test(line);
/** Cette ligne ouvrirait-elle un menu dans le terminal ? */
export const opensDialog = (c: SlashCommand, line: string): boolean => c.dialog === 'always' || (c.dialog === 'bare' && !hasArgs(line));

// ── Lecture du disque ──
/** En-tête YAML d'un fichier Markdown : les clés simples `clé: valeur` (guillemets retirés). Rien d'autre n'est lu. */
export function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(stripBom(text));
  if (!m) return out;
  for (const l of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(l);
    if (kv) out[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}
const head = (file: string): Record<string, string> => { try { return frontmatter(readFileSync(file, 'utf8').slice(0, 8192)); } catch { return {}; } };
const short = (s: string | undefined): string => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > 160 ? t.slice(0, 159) + '…' : t; };
const ls = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
const slug = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');

/** Skills (`skills/<nom>/SKILL.md`) et commandes (`commands/*.md`, un niveau de sous-dossier) d'un dossier `.claude`
 *  ou d'un plugin. `prefix` : nom du plugin (« hookify » ⇒ /hookify:list). */
export function scanDir(root: string, source: SlashCommand['source'], prefix = ''): SlashCommand[] {
  const out: SlashCommand[] = [];
  const add = (raw: string, h: Record<string, string>): void => {
    const n = slug(raw); if (!n || h['user-invocable'] === 'false') return;
    const name = '/' + (prefix ? prefix + ':' : '') + n;
    if (NAME.test(name)) out.push({ name, desc: short(h.description), args: short(h['argument-hint']).slice(0, 80), source, dialog: '', risky: false, persist: false, immediate: false, forms: [] });
  };
  for (const d of ls(join(root, 'skills'))) { const f = join(root, 'skills', d, 'SKILL.md'); if (isFile(f)) { const h = head(f); add(h.name || d, h); } }
  const cmds = join(root, 'commands');
  for (const e of ls(cmds)) {
    const p = join(cmds, e);
    if (e.toLowerCase().endsWith('.md')) add(e.slice(0, -3), head(p));
    else if (isDir(p)) for (const f of ls(p)) if (f.toLowerCase().endsWith('.md')) add(f.slice(0, -3), head(join(p, f)));
  }
  return out;
}

/** Plugins activés (`enabledPlugins` des réglages utilisateur et du projet) → dossier d'installation. */
function pluginDirs(claude: string, projectDirs: string[]): { name: string; dir: string }[] {
  const on = new Set<string>();
  for (const f of [join(claude, 'settings.json'), ...projectDirs.flatMap((d) => [join(d, 'settings.json'), join(d, 'settings.local.json')])]) {
    const e = (readJson(f) as { enabledPlugins?: unknown } | null)?.enabledPlugins;
    if (e && typeof e === 'object') for (const [k, v] of Object.entries(e)) { if (v === true) on.add(k); else if (v === false) on.delete(k); }
  }
  const inst = (readJson(join(claude, 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, unknown> } | null)?.plugins ?? {};
  const out: { name: string; dir: string }[] = [];
  for (const key of on) {
    const list = inst[key]; const first = Array.isArray(list) ? list.find((x) => x && typeof x === 'object' && typeof (x as { installPath?: unknown }).installPath === 'string') : null;
    const dir = first ? (first as { installPath: string }).installPath : '';
    if (dir && isDir(dir)) out.push({ name: slug(key.split('@')[0] ?? ''), dir });
  }
  return out;
}

/** Les dossiers `.claude` du dossier de la session et de ses parents (le plus proche d'abord), hors celui de
 *  l'utilisateur. `top` : dossier au-dessus duquel on ne remonte pas (tests : rien du poste n'est lu). */
export function projectClaudeDirs(cwd: string, claude: string, top = ''): string[] {
  const out: string[] = []; let d = cwd;
  for (let i = 0; d && i < 12; i++) {
    const c = join(d, '.claude');
    if (c.toLowerCase() !== claude.toLowerCase() && isDir(c)) out.push(c);
    const up = dirname(d); if (up === d || d.toLowerCase() === top.toLowerCase()) break; d = up;
  }
  return out;
}

export class Commands {
  readonly claude: string;
  ttlMs = 30_000;
  /** Dossier au-dessus duquel la recherche des `.claude` de projet ne remonte pas ('' : jusqu'à la racine). */
  top = '';
  #cache = new Map<string, { at: number; list: SlashCommand[] }>();
  constructor(claude: string, top = '') { this.claude = claude; this.top = top; }

  /** La liste pour une session lancée dans `cwd` : intégrées, puis projet, utilisateur, plugins ; un nom déjà pris
   *  n'est pas repris (l'intégrée, puis le plus proche du dossier, l'emporte). Relue au plus toutes les 30 s. */
  list(cwd: string): SlashCommand[] {
    const key = cwd.toLowerCase(); let hit = this.#cache.get(key);
    if (!hit || Date.now() - hit.at >= this.ttlMs) {
      const proj = cwd && isDir(cwd) ? projectClaudeDirs(cwd, this.claude, this.top) : [];
      hit = { at: Date.now(), list: [...proj.flatMap((d) => scanDir(d, 'project')), ...(this.claude ? [...scanDir(this.claude, 'user'), ...pluginDirs(this.claude, proj).flatMap((p) => scanDir(p.dir, 'plugin', p.name))] : [])] };
      this.#cache.set(key, hit);
      if (this.#cache.size > 200) this.#cache.delete(this.#cache.keys().next().value!);
    }
    // Les descriptions des intégrées dépendent de la langue de la requête : seul le disque est gardé en cache.
    const all: SlashCommand[] = [
      ...BUILTINS.map((b): SlashCommand => ({ name: b.n, desc: T(b.fr, b.en), args: b.a ?? '', source: 'builtin', dialog: b.d ?? '', risky: !!b.r, persist: !!b.p, immediate: !!b.i, forms: b.f ?? [] })),
      ...hit.list,
    ];
    const seen = new Set<string>();
    return all.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  }

  /** Garde d'un envoi fait depuis la page. null : rien à redire (message ordinaire ou commande admise).
   *  `many` : message groupé — ni commande à risque, ni menu (N sessions bloquées sur un dialogue). */
  check(line: string, cwd: string, force: boolean, many: boolean): { error: string; unknownCommand?: string } | null {
    const name = commandOf(line); if (!name) return null;
    const c = this.list(cwd).find((x) => x.name === name);
    if (!c) return force ? null : { error: T(`commande inconnue : ${name}`, `unknown command: ${name}`), unknownCommand: name };
    if (many && c.risky) return { error: T(`${name} : refusée en message groupé`, `${name}: refused in a grouped message`) };
    if (many && opensDialog(c, line)) return { error: T(`${name} ouvre un menu dans le terminal : refusée en message groupé`, `${name} opens a menu in the terminal: refused in a grouped message`) };
    return null;
  }
}

// ── Raccourcis ──
/** Bouton de la page qui envoie une commande toute faite. `confirm` non vide ⇒ la page demande avant. */
export interface Shortcut { label: string; command: string; confirm: string }
export const defaultShortcuts = (): Shortcut[] => [
  { label: T('Reconnecter les MCP', 'Reconnect MCP servers'), command: '/mcp reconnect all', confirm: '' },
  { label: T('Compacter', 'Compact'), command: '/compact', confirm: '' },
];
/** `ui.shortcuts` de config.json : 8 boutons au plus, chacun une ligne de commande « /… » de 200 caractères au plus.
 *  Clé absente ⇒ null (les raccourcis par défaut) ; liste vide ⇒ aucun bouton. */
export function parseShortcuts(v: unknown): Shortcut[] | null {
  if (!Array.isArray(v)) return null;
  const out: Shortcut[] = [];
  for (const e of v.slice(0, 8)) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>; const txt = (x: unknown, n: number): string => (typeof x === 'string' ? x.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n) : '');
    const command = txt(o.command, 200), label = txt(o.label, 40);
    if (label && commandOf(command)) out.push({ label, command, confirm: txt(o.confirm, 200) });
  }
  return out;
}
