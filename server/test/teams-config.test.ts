// Surveillant Teams : ses réglages sont `modules.teams` du fichier de configuration du poste ; un fichier illisible
// l'arrête en le disant (au lieu de tourner tout éteint sans bruit).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const script = fileURLToPath(new URL('../src/teams-watcher.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'sd-teams-cfg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, SD_TEAMS_WAITS_DIR: join(dir, 'waits'), USERPROFILE: dir, HOME: dir, ...env } });

test('config.json illisible : arrêt, code 1, et le message nomme le fichier', () => {
  const f = join(dir, 'casse.json'); writeFileSync(f, '{ "modules": { "teams": { "enabled": true } }, }');
  const r = run(['status', '--config', f]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('casse.json');
  expect(r.stderr).toContain('illisible');
});

test('SD_CONFIG est lu comme --config', () => {
  const f = join(dir, 'casse2.json'); writeFileSync(f, '{');
  const r = run(['status'], { SD_CONFIG: f });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('casse2.json');
});
