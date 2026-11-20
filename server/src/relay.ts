// Santé du relais d'accès distant (tailscale serve → 127.0.0.1:<port+1> → serveur).
//
// Trois conditions pour que la page s'ouvre depuis le tailnet :
//   1. le relais écoute sur <port+1> ;
//   2. le serveur connaît l'identité Tailscale du poste (propriétaire + nom sur le tailnet) — sans elle le relais
//      refuse TOUT (« hôte refusé par le relais »). Elle se lit au démarrage par `tailscale status --json` : un
//      serveur lancé avant Tailscale (ouverture de session) la manquait jusqu'au prochain redémarrage ;
//   3. `tailscale serve` renvoie bien vers <port+1>.
// Ce module lit ces faits et en tire un verdict affichable ; le serveur relit l'identité tant qu'elle manque.
import { execFile } from 'node:child_process';
import { T } from './i18n.ts';
import { exists } from './util.ts';

export type Identity = { owner: string; origin: string };

function run(exe: string, args: string[]): Promise<string> {
  return new Promise((ok, ko) => {
    if (!exists(exe)) { ko(new Error(T('Tailscale absent', 'Tailscale not installed'))); return; }
    execFile(exe, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      if (err && !out) ko(new Error((errOut || err.message).trim().split(/\r?\n/).pop() ?? err.message)); else ok(out);
    });
  });
}

/** Identité tirée de `tailscale status --json` : null si le poste n'est pas (encore) connecté au tailnet. */
export function parseIdentity(out: string): Identity | null {
  try {
    const j = JSON.parse(out) as { Self?: { UserID?: unknown; DNSName?: string }; User?: Record<string, { LoginName?: string }> };
    const login = j.User?.[String(j.Self?.UserID)]?.LoginName; const dns = (j.Self?.DNSName ?? '').replace(/\.$/, '');
    return login && dns ? { owner: login, origin: `https://${dns}` } : null;
  } catch { return null; }
}

/** Identité Tailscale du poste : seul son propriétaire lit et écrit à distance, et le relais ne transmet que ce qui
 *  vise le nom du poste sur le tailnet. Sans elle : aucun accès distant. */
export async function tailscaleIdentity(exe: string): Promise<Identity> {
  const out = await run(exe, ['status', '--json']);
  const id = parseIdentity(out);
  if (!id) throw new Error(T(`tailscale status sans identité (${out.length} o) : poste déconnecté du tailnet ?`, `tailscale status without identity (${out.length} B): machine logged out of the tailnet?`));
  return id;
}

/** Port vers lequel `tailscale serve` renvoie la racine du nom du poste (`tailscale serve status --json`) ;
 *  null si rien n'est servi pour ce nom, ou vers autre chose qu'un port local. */
export function parseServePort(out: string, origin: string): number | null {
  try {
    const j = JSON.parse(out) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    const host = origin.replace(/^https?:\/\//i, '').toLowerCase();
    for (const [k, v] of Object.entries(j.Web ?? {})) {
      if (k.replace(/:443$/, '').toLowerCase() !== host) continue;
      const m = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])?:?([0-9]+)\/?$/i.exec(v.Handlers?.['/']?.Proxy ?? '');
      return m ? Number(m[1]) : null;
    }
  } catch { /* illisible */ }
  return null;
}
export async function tailscaleServePort(exe: string, origin: string): Promise<number | null> {
  return parseServePort(await run(exe, ['serve', 'status', '--json']), origin);
}

export type RelayFacts = {
  port: number;                       // port du relais (<port du serveur> + 1)
  listening: boolean; listenError: string | null;
  identity: Identity | null; identityError: string | null;
  servePort: number | null | undefined;   // undefined : pas encore lu ; null : rien de servi
  serveError: string | null;
};
export type RelayHealth = {
  ok: boolean;
  port: number;
  url: string | null;                 // adresse à ouvrir depuis le tailnet
  problems: string[];                 // ce qui manque, en clair
  fix: string | null;                 // commande à lancer quand le bouton n'y peut rien
};

/** Verdict affichable. Le bouton « Relancer » répare 1 et 2 ; pour 3 il faut une commande `tailscale serve`. */
export function relayHealth(f: RelayFacts): RelayHealth {
  const problems: string[] = []; let fix: string | null = null;
  if (!f.listening) problems.push(T(`relais arrêté (port ${f.port})`, `relay stopped (port ${f.port})`) + (f.listenError ? ` : ${f.listenError}` : ''));
  if (!f.identity) problems.push(T('identité Tailscale inconnue : le relais refuse tout', 'Tailscale identity unknown: the relay refuses everything') + (f.identityError ? ` (${f.identityError})` : ''));
  else if (f.servePort === null || (f.servePort !== undefined && f.servePort !== f.port)) {
    problems.push(f.servePort === null ? T('tailscale serve ne sert pas ce poste', 'tailscale serve is not serving this machine')
      : T(`tailscale serve renvoie vers le port ${f.servePort}, pas ${f.port}`, `tailscale serve points to port ${f.servePort}, not ${f.port}`));
    fix = `tailscale serve --bg ${f.port}`;
  } else if (f.serveError) problems.push(T(`tailscale serve illisible : ${f.serveError}`, `tailscale serve unreadable: ${f.serveError}`));
  return { ok: problems.length === 0, port: f.port, url: f.identity?.origin ?? null, problems, fix };
}
