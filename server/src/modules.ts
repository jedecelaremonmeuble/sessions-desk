// MODULES OPTIONNELS — ce qui n'appartient pas au cœur (liste des sessions, écran, conversation, envoi).
//
// Le cœur ne lit que ~/.claude et pilote des consoles. Tout le reste est une intégration propre à un poste ou à
// une équipe : elle est ÉTEINTE tant que le fichier de configuration ne la nomme pas.
//
//   ~/.claude/sessions-desk/config.json      (autre chemin : --config <fichier>, ou SD_CONFIG)
//   {
//     "modules": {
//       "launcher": { "root": "%LOCALAPPDATA%\\mon-orchestrateur", "cli": "C:\\chemin\\orchestrateur.py", "ticketApi": "C:\\chemin\\tickets.py", "python": "python" },
//       "teams":    { "enabled": true },
//       "tickets":  { "pattern": "ABC-\\d{4}" },
//       "quota":    { "file": "%LOCALAPPDATA%\\mon-orchestrateur\\claude-usage.json" }
//     },
//     "ui": { "pathPrefix": "C:\\code\\mon-depot", "prUrl": "https://github.com/moi/depot/pull/", "ticketUrl": "https://tickets.example.com/t/", "ticketLabel": "Ticket" },
//     "claudeArgs": "--model opus"
//   }
//
// - claudeArgs : options passées à `claude` quand la page ouvre, rouvre ou relance une session. Aucune par défaut ;
//   l'option --claude-args de la ligne de commande passe avant.
//
// - launcher : un orchestrateur externe qui lance des sessions sans terminal. `root` = son dossier de données
//   (runs\, state.json, stages.json, heartbeat.stamp) ; `cli` = la commande qui reçoit les ordres tapés dans la page.
// - teams    : attentes de réponse Teams tenues par teams-watcher.ts (state/teams-waits).
// - tickets  : motif des références de ticket citées dans les prompts (le « sujet actuel » d'une session).
// - quota    : fichier de relevé du quota, écrit par un collecteur qui n'est PAS dans ce dépôt.
//
// Fichier absent, illisible ou module mal décrit ⇒ module éteint : jamais une erreur au démarrage.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface LauncherModule { root: string; cli: string; python: string; ticketApi: string }
/** Ce que la page affiche et qui dépend du poste : préfixe de chemin à ne pas répéter, adresses des PR et des tickets. */
export interface UiConfig { pathPrefix: string; prUrl: string; ticketUrl: string; ticketLabel: string }
export const NO_UI: UiConfig = { pathPrefix: '', prUrl: '', ticketUrl: '', ticketLabel: '' };
export interface Modules {
  launcher: LauncherModule | null;
  teams: boolean;
  tickets: { pattern: string } | null;
  quota: { file: string } | null;
}
export const NO_MODULES: Modules = { launcher: null, teams: false, tickets: null, quota: null };

/** Ce que la page reçoit (`/api/state.modules`) : allumé ou non, jamais un chemin. */
export const modulesView = (m: Modules): Record<string, boolean> =>
  ({ launcher: !!m.launcher, teams: m.teams, tickets: !!m.tickets, quota: !!m.quota });

export interface PathEnv { home: string; localAppData: string; temp: string }

/** `~`, %USERPROFILE%, %LOCALAPPDATA% et %TEMP% en tête ou dans un chemin ; rien d'autre n'est développé. */
export function expandPath(p: string, env: PathEnv): string {
  let s = p.replace(/%USERPROFILE%/gi, env.home).replace(/%LOCALAPPDATA%/gi, env.localAppData).replace(/%TEMP%/gi, env.temp);
  if (s === '~') s = env.home; else if (/^~[\\/]/.test(s)) s = join(env.home, s.slice(2));
  return s;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const absPath = (v: unknown, env: PathEnv): string => { if (typeof v !== 'string' || !v.trim()) return ''; const p = expandPath(v.trim(), env); return isAbsolute(p) ? p : ''; };

/** Un motif de ticket n'est gardé que s'il compile et ne matche pas le vide (sinon chaque prompt aurait un « sujet »). */
export function ticketPattern(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > 200) return null;
  try { return new RegExp(v).test('') ? null : v; } catch { return null; }
}

export function parseModules(raw: unknown, env: PathEnv): Modules {
  const m = obj(obj(raw)?.modules); if (!m) return { ...NO_MODULES };
  const out: Modules = { ...NO_MODULES };
  const l = obj(m.launcher); const root = l ? absPath(l.root, env) : '';
  if (l && root) out.launcher = { root, cli: absPath(l.cli, env), python: typeof l.python === 'string' && l.python.trim() ? l.python.trim() : 'python', ticketApi: absPath(l.ticketApi, env) };
  out.teams = obj(m.teams)?.enabled === true;
  const pat = ticketPattern(obj(m.tickets)?.pattern); if (pat) out.tickets = { pattern: pat };
  const q = obj(m.quota); const file = q ? absPath(q.file, env) : ''; if (file) out.quota = { file };
  return out;
}

const httpUrl = (v: unknown): string => (typeof v === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(v.trim()) ? v.trim() : '');
export function parseUi(raw: unknown, env: PathEnv): UiConfig {
  const u = obj(obj(raw)?.ui); if (!u) return { ...NO_UI };
  const label = typeof u.ticketLabel === 'string' ? u.ticketLabel.trim().slice(0, 30) : '';
  return { pathPrefix: absPath(u.pathPrefix, env), prUrl: httpUrl(u.prUrl), ticketUrl: httpUrl(u.ticketUrl), ticketLabel: label };
}

/** Options passées à `claude` au lancement d'une session : une ligne de 200 caractères au plus, sans « ; » (qui
 *  couperait la ligne de commande de Windows Terminal). Autre chose ⇒ null. */
export function claudeArgsOk(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200 || /[\r\n;]/.test(v)) return null;
  return v.trim();
}
/** Clé de premier niveau `claudeArgs` : absente ou refusée ⇒ aucune option (défaut de la version publique). */
export const parseClaudeArgs = (raw: unknown): string => claudeArgsOk(obj(raw)?.claudeArgs) ?? '';

/** Fichier de configuration du poste, lu une fois : `modules`, `ui` et `claudeArgs`. */
export function loadSettings(file: string, env: PathEnv): { modules: Modules; ui: UiConfig; claudeArgs: string } {
  let raw: unknown;
  try { const text = readFileSync(file, 'utf8'); raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return { modules: { ...NO_MODULES }, ui: { ...NO_UI }, claudeArgs: '' }; }
  return { modules: parseModules(raw, env), ui: parseUi(raw, env), claudeArgs: parseClaudeArgs(raw) };
}
export const loadModules = (file: string, env: PathEnv): Modules => loadSettings(file, env).modules;
