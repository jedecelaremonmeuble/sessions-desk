// Point d'entrée du serveur Node du poste de pilotage (lot 2b, étape 2).
//
//   node server/src/main.ts [--port 8767] [--allow-write] [--no-background] [--primary] [--driver <exe>]
//
// À côté du .ps1 (défaut, 8767 + relais 8768) : lecture seule, sans notification ni tâche de fond partagée.
// Sur 8765 (bascule, étape 5, sur go) : rôle « primary », écriture permise.
import { parseArgs } from './config.ts';
import { DriverClient } from './driver.ts';
import { Server } from './http.ts';
import { Dashboard } from './state.ts';
import { purgeUploads } from './upload.ts';
import { registerFocusProtocol } from './watch.ts';

export async function start(argv: string[]): Promise<Server> {
  const cfg = parseArgs(argv);
  const driver = new DriverClient({ exe: cfg.driverExe, log: (l) => process.stderr.write(l + '\n') });
  const d = new Dashboard(cfg, driver);
  const srv = new Server(d);
  if (!cfg.noBackground && cfg.primary) { try { await registerFocusProtocol(cfg.legacyDir); } catch { /* idem */ } }
  await srv.checkRelay(true);   // identité Tailscale : relue ensuite par la boucle tant qu'elle manque (relay.ts)
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
