// Page : fonction PURE de la vue « Conversations Teams » (chatGroups), extraite de app.js et exécutée seule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');   // poste en autocrlf : fins de ligne CRLF
function extract(name: string, sig: string): (...a: unknown[]) => any {
  const m = new RegExp(`\\nfunction ${name}\\(${sig}\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(js);
  if (!m) throw new Error(`${name} introuvable dans la page`);
  return new Function(`${m[0]}; return ${name};`)() as (...a: unknown[]) => any;
}
const chatGroups = extract('chatGroups', 'rows');
const row = (o: Record<string, unknown>) => ({ chatId: 'c', lastAt: 1000, ball: null, unseen: false, sessions: [], ...o });

describe('chatGroups', () => {
  test('trois groupes : à répondre l’emporte sur à voir ; le plus récent d’abord dans chacun', () => {
    const g = chatGroups([
      row({ chatId: 'jour' }), row({ chatId: 'vu', unseen: true }), row({ chatId: 'rep', ball: 'reply', unseen: true }),
      row({ chatId: 'rep2', ball: 'reply', lastAt: 2000 }), row({ chatId: 'ses', ball: 'session', unseen: true, lastAt: 3000 }), row({ chatId: 'att', ball: 'waiting' }),
    ]);
    expect(g.map((x: any) => [x.key, x.rows.map((r: any) => r.chatId)])).toEqual([['reply', ['rep2', 'rep']], ['unseen', ['ses', 'vu']], ['ok', ['jour', 'att']]]);
  });
  test('liste absente : trois groupes vides', () => {
    expect(chatGroups(null).map((x: any) => x.rows.length)).toEqual([0, 0, 0]);
  });
});
