// Page : un menu du terminal SANS options numérotées (/mcp, /permissions…) reconnu à son pied, pour le piloter au pavé
// de touches. parseKeyMenu est extraite de app.js et exécutée seule, sur des écrans relevés dans Claude Code 2.1.330.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');   // poste en autocrlf : fins de ligne CRLF
const m = /\nfunction parseKeyMenu\(text\) \{[\s\S]*?\n\}\n/.exec(js);
if (!m) throw new Error('parseKeyMenu introuvable dans la page');
const parseKeyMenu = new Function(`${m[0]}; return parseKeyMenu;`)() as (text: string) => { body: string; foot: string } | null;

const BAR = '─'.repeat(60), TOP = '▔'.repeat(60);
const BEFORE = ['❯ bonjour', '', '● OK', '', '✻ Brewed for 6s · done 8:16'];
const MCP = [...BEFORE, TOP, '  MCP servers', '  3 servers', '', '    Local MCPs (C:\\Users\\someone\\.claude.json)', '  ❯ ✔ notes                                       12 tools',
  '    ⚠ billing                                     needs sign-in', '', '  Learn more: https://example.com/docs/mcp', '', '  ↑/↓ to navigate · Enter to view · Esc to close'].join('\n');
const SERVER = [...BEFORE, TOP, '  notes', '  MCP server', '', '  Status:           ✔ connected', '', '  ❯ View tools', '    Re-authenticate', '    Reconnect', '    Back', '',
  '  ↑/↓ to navigate · Enter to select · Esc to go back'].join('\n');
const PERMS = [...BEFORE, TOP, '  Permissions  Recently blocked   Allow   Ask   Deny   Workspace', '', '  Claude Code won\'t ask before using allowed tools.', '',
  '  ╭──────────────────────────────╮', '  │ ⌕ Search…                    │', '  ╰──────────────────────────────╯', '  ❯ Add a new rule…', '    Bash(cat:*)', '    ↓ 39 more', '',
  '  ↓ to navigate · ←/→ to switch · / to search · Esc to close'].join('\n');
const PROMPT = [...BEFORE, '', BAR, '❯ ', BAR, '  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt'].join('\n');

describe('parseKeyMenu', () => {
  test('/mcp : le menu depuis son trait d\'ouverture, le pied comme repère', () => {
    const r = parseKeyMenu(MCP)!;
    expect(r.foot).toBe('↑/↓ to navigate · Enter to view · Esc to close');
    expect(r.body.split('\n')[0]).toBe('  MCP servers');
    expect(r.body).toContain('❯ ✔ notes'); expect(r.body).not.toContain('Brewed'); expect(r.body).not.toContain('Esc to close');
    expect(MCP).toContain(r.foot);                      // le serveur le cherche tel quel à l'écran
  });
  test('sous-écran d\'un serveur : pied « Esc to go back »', () => {
    const r = parseKeyMenu(SERVER)!;
    expect(r.foot).toBe('↑/↓ to navigate · Enter to select · Esc to go back'); expect(r.body).toContain('❯ View tools');
  });
  test('/permissions : onglets et cadre de recherche rendus tels quels', () => {
    const r = parseKeyMenu(PERMS)!;
    expect(r.foot).toMatch(/\/ to search · Esc to close$/);
    expect(r.body.split('\n')[0]).toBe('  Permissions  Recently blocked   Allow   Ask   Deny   Workspace');
    expect(r.body).toContain('│ ⌕ Search…'); expect(r.body.split('\n').at(-1)).toBe('    ↓ 39 more');
  });
  test('invite ordinaire, écran vide, session au travail : pas un menu', () => {
    expect(parseKeyMenu(PROMPT)).toBeNull(); expect(parseKeyMenu('')).toBeNull();
    expect(parseKeyMenu([...BEFORE, '✽ Orbiting… (2s · esc to interrupt)', BAR, '❯ ', BAR].join('\n'))).toBeNull();
  });
  test('pied trop haut dans l\'écran (texte de conversation qui le cite) : ignoré', () => {
    expect(parseKeyMenu(['  ↑/↓ to navigate · Enter to view · Esc to close', ...Array.from({ length: 20 }, () => 'ligne'), BAR, '❯ ', BAR].join('\n'))).toBeNull();
  });
});
