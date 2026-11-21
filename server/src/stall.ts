// TRACE DE PERFORMANCE du serveur : durée de chaque phase du démarrage, et gels de la boucle d'événements.
//
// Un gel se voit de l'EXTÉRIEUR de la boucle : un fil de travail (worker) lit un battement que le fil principal écrit
// toutes les 250 ms dans une mémoire partagée. Il écrit donc même pendant un gel qui ne finit jamais, là où un minuteur
// du fil principal ne se réveillerait qu'après. Pour chaque gel, il note la dernière PHASE annoncée par le fil
// principal et le CPU consommé par le process pendant le gel :
//   - CPU ≈ durée du gel : le serveur CALCULAIT (notre code est en cause) ;
//   - CPU ≈ 0 : le serveur ATTENDAIT (disque, antivirus, machine saturée), pas notre code.
// Fichier : <temp>\sessions-desk-node-<port>.perf.log, une ligne par événement, mis de côté (.old) au-delà de 1 Mo.
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

/** Phases annoncées par le fil principal : c'est la dernière annoncée qu'un gel désigne. */
export const PHASES = ['démarrage', 'état', 'veille', 'fermées', 'attente', 'requête', 'index', 'recherche'] as const;
export type Phase = typeof PHASES[number];

const sab = new SharedArrayBuffer(16);
const beat = new Float64Array(sab, 0, 1);
const phase = new Int32Array(sab, 8, 1);
beat[0] = Date.now();

/** Annonce ce que fait le fil principal (coût : une écriture en mémoire partagée). */
export function setPhase(p: Phase): void { Atomics.store(phase, 0, PHASES.indexOf(p)); }

/** Verdict d'un gel à partir du CPU consommé pendant sa durée. */
export function stallVerdict(wallMs: number, cpuMs: number): string {
  const r = wallMs > 0 ? cpuMs / wallMs : 0;
  if (r >= 0.6) return 'le serveur calculait (code)';
  if (r <= 0.2) return 'le serveur attendait (disque, antivirus ou machine, pas le code)';
  return 'calcul et attente mêlés';
}

/** Ligne de démarrage : durée de chaque phase, total, CPU ; « LENT » au-delà de slowMs. */
export function startupLine(steps: [string, number][], totalMs: number, cpuMs: number, slowMs = 5000): string {
  const parts = steps.map(([n, ms]) => `${n} ${Math.round(ms)} ms`).join(' · ');
  return `démarrage${totalMs >= slowMs ? ' LENT' : ''} : ${parts} · total ${Math.round(totalMs)} ms (CPU ${Math.round(cpuMs)} ms, ${stallVerdict(totalMs, cpuMs)})`;
}

export function perfLine(file: string, msg: string): void {
  try { appendFileSync(file, `${new Date().toISOString().slice(0, 19)} ${msg}\r\n`, 'utf8'); } catch { /* idem */ }
}
function rotate(file: string): void {
  try { if (statSync(file).size > 1 << 20) renameSync(file, file + '.old'); } catch { /* absent */ }
}

// Le fil de travail, en JavaScript simple (évalué) : rien à charger, rien qui puisse lui-même attendre le fil principal.
const WORKER = `
const { workerData: w } = require('node:worker_threads'); const fs = require('node:fs');
const beat = new Float64Array(w.sab, 0, 1); const phase = new Int32Array(w.sab, 8, 1);
const log = (m) => { try { fs.appendFileSync(w.file, new Date().toISOString().slice(0, 19) + ' ' + m + '\\r\\n', 'utf8'); } catch {} };
const ms = (u) => (u.user + u.system) / 1000;
let okCpu = process.cpuUsage(), okAt = Date.now(), stall = null;
setInterval(() => {
  const now = Date.now(), age = now - beat[0];
  if (!stall) {
    if (age <= w.threshold) { okCpu = process.cpuUsage(); okAt = now; return; }
    stall = { from: beat[0], cpu: okCpu, cpuAt: okAt, phase: w.phases[Atomics.load(phase, 0)] ?? '?', told: now };
    log('boucle figée depuis ' + age + ' ms (phase ' + stall.phase + ')');
    return;
  }
  const cpuMs = ms(process.cpuUsage(stall.cpu)), wall = now - stall.cpuAt;
  if (age <= w.threshold) {
    log('boucle débloquée après ' + (beat[0] - stall.from) + ' ms (phase ' + stall.phase + ') : CPU ' + Math.round(cpuMs) + ' ms sur ' + wall + ' ms, ' + verdict(wall, cpuMs));
    stall = null; okCpu = process.cpuUsage(); okAt = now;
  } else if (now - stall.told >= w.repeatMs) {
    stall.told = now;
    log('boucle toujours figée depuis ' + age + ' ms (phase ' + stall.phase + ') : CPU ' + Math.round(cpuMs) + ' ms sur ' + wall + ' ms, ' + verdict(wall, cpuMs));
  }
}, w.everyMs);
`;

export interface StallWatch { stop(): Promise<void> }

/** Démarre le battement (fil principal) et le guetteur (fil de travail). Ne retient jamais le process. */
export function startStallWatch(file: string, o: { thresholdMs?: number; everyMs?: number; beatMs?: number; repeatMs?: number } = {}): StallWatch {
  rotate(file);
  const beatMs = o.beatMs ?? 250;
  beat[0] = Date.now();
  const t = setInterval(() => { beat[0] = Date.now(); }, beatMs); t.unref();
  // Le verdict est injecté dans le worker depuis sa source : une seule définition des seuils.
  const w = new Worker(`const verdict = ${stallVerdict.toString()};\n${WORKER}`, {
    eval: true,
    workerData: { sab, file, phases: [...PHASES], threshold: o.thresholdMs ?? 2000, everyMs: o.everyMs ?? 500, repeatMs: o.repeatMs ?? 60_000 },
  });
  w.unref();
  w.on('error', () => undefined);
  return { async stop() { clearInterval(t); await w.terminate(); } };
}
