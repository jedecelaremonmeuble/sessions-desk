// Point d'entrée du serveur Node du poste de pilotage (lot 2b, étape 2).
//
//   node server/src/main.ts [--port 8767] [--allow-write] [--no-background] [--primary] [--driver <exe>]
//
// À côté du .ps1 (défaut, 8767 + relais 8768) : lecture seule, sans notification ni tâche de fond partagée.
// Sur 8765 (bascule, étape 5, sur go) : rôle « primary », écriture permise.
import { execFile } from 'node:child_process';
import { parseArgs } from './config.ts';
import { DriverClient } from './driver.ts';
import { Server } from './http.ts';
import { Dashboard } from './state.ts';
import { purgeUploads } from './upload.ts';
import { exists } from './util.ts';
import { registerFocusProtocol } from './watch.ts';

/** Identité Tailscale du poste : seul son propriétaire lit et écrit à distance, et le relais ne transmet que ce qui
 *  vise le nom du poste sur le tailnet. Sans elle : aucun accès distant. */
function tailscaleIdentity(exe: string): Promise<{ owner: string; origin: string }> {
  return new Promise((ok, ko) => {
    if (!exists(exe)) { ko(new Error('Tailscale absent')); return; }
    execFile(exe, ['status', '--json'], { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      try {
        const j = JSON.parse(out) as { Self?: { UserID?: unknown; DNSName?: string }; User?: Record<string, { LoginName?: string }> };
        const login = j.User?.[String(j.Self?.UserID)]?.LoginName; const dns = (j.Self?.DNSName ?? '').replace(/\.$/, '');
        if (login && dns) ok({ owner: login, origin: `https://${dns}` });
        else ko(new Error(`tailscale status sans identité (${err ? 'erreur' : 'code 0'}, ${out.length} o) : ${errOut}`));
      } catch (e) { ko(e as Error); }
    });
  });
}

export async function start(argv: string[]): Promise<Server> {
  const cfg = parseArgs(argv);
  const driver = new DriverClient({ exe: cfg.driverExe, log: (l) => process.stderr.write(l + '\n') });
  const d = new Dashboard(cfg, driver);
  const srv = new Server(d);
  if (!cfg.noBackground && cfg.primary) { try { await registerFocusProtocol(cfg.legacyDir); } catch { /* idem */ } }
  try { const id = await tailscaleIdentity(cfg.tailscaleExe); srv.remoteOwner = id.owner; srv.remoteOrigin = id.origin; }
  catch (e) { srv.logError(`écriture à distance désactivée : ${(e as Error).message}`); }
  if (srv.uploadDir) { try { purgeUploads(srv.uploadDir, 30); } catch { /* idem */ } }
  await srv.listen();
  process.stdout.write(`Suivi des sessions (Node) : ${cfg.url}  ${cfg.allowWrite ? 'écriture permise' : 'LECTURE SEULE'}${cfg.primary ? '' : ', à côté du serveur principal'}\n`);
  if (!cfg.noBackground) srv.search.warm();
  srv.onStop = () => { driver.close(); process.exit(0); };
  for (const sig of ['SIGINT', 'SIGBREAK'] as const) process.once(sig, () => { void srv.shutdown(); });   // Ctrl+C / Ctrl+Pause : arrêt propre
  srv.loop().catch((e) => { srv.logError(`boucle : ${(e as Error).message}`); process.exit(1); });
  return srv;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('main.ts')) {
  start(process.argv.slice(2)).catch((e) => { process.stderr.write(`${(e as Error).message}\n`); process.exit(1); });
}
