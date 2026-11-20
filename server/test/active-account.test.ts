// Compte Claude connecté : mis en avant dans le bandeau de quota de la page.
import { describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { activeAccountUuid, markActiveAccount } from '../src/usage.ts';

describe('compte connecté', () => {
  test('lu dans ~/.claude.json (à côté de ~/.claude), sinon dans le dossier de configuration', () => {
    const home = mkdtempSync(join(tmpdir(), 'sd-acct-')); const claude = join(home, '.claude'); mkdirSync(claude);
    const cfg = { claude } as Config;
    expect(activeAccountUuid(cfg)).toBeNull();
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'a-1', emailAddress: 'x@y' } }));
    expect(activeAccountUuid(cfg)).toBe('a-1');
    writeFileSync(join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'b-2' } }));
    expect(activeAccountUuid(cfg)).toBe('b-2');
  });
  test('seul le relevé du compte connecté est marqué ; inconnu ⇒ aucun', () => {
    const q = [{ uuid: 'a-1', alias: 'a' }, { uuid: 'b-2', alias: 'b' }];
    expect(markActiveAccount(q, 'b-2').map((x) => (x as { active: boolean }).active)).toEqual([false, true]);
    expect(markActiveAccount(q, null).map((x) => (x as { active: boolean }).active)).toEqual([false, false]);
  });
});
