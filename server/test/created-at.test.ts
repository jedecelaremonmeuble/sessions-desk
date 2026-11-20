// Date de création d'une session (tri « par création » de la liste) : 1er horodatage du transcript.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { transcriptCreatedAt } from '../src/util.ts';

const dir = mkdtempSync(join(tmpdir(), 'sd-created-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, lines: string[]): string => { const p = join(dir, name); writeFileSync(p, lines.join('\n') + '\n'); return p; };

describe('transcriptCreatedAt', () => {
  test('1er horodatage du fichier, même si la 1re ligne n\'en porte pas', () => {
    const p = file('a.jsonl', [
      '{"type":"permission-mode","permissionMode":"default"}',
      '{"parentUuid":null,"type":"user","timestamp":"2026-11-18T08:15:00.000Z"}',
      '{"parentUuid":"x","type":"assistant","timestamp":"2026-11-20T10:00:00.000Z"}',
    ]);
    expect(transcriptCreatedAt(p)).toBe(Date.UTC(2026, 10, 18, 8, 15));
  });
  test('sans horodatage : date de création du fichier', () => {
    const p = file('b.jsonl', ['{"type":"ai-title","aiTitle":"x"}']);
    expect(transcriptCreatedAt(p)).toBe(Math.trunc(statSync(p).birthtimeMs));
  });
  test('fichier absent : null', () => {
    expect(transcriptCreatedAt(join(dir, 'absent.jsonl'))).toBeNull();
  });
});
