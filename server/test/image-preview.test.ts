// Aperçu des images citées par chemin dans la conversation : extraction des chemins par la page (imagePaths, extraite
// de app.js et exécutée seule) et lecture côté serveur (image.ts : chemin admis, signature vérifiée, plafond).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { imagePathOk, MAX_IMAGE, readImage, sniffImage } from '../src/image.ts';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const m = /\nfunction imagePaths\(text\) \{[\s\S]*?\n\}\n/.exec(js);
if (!m) throw new Error('imagePaths introuvable dans la page');
const imagePaths = new Function(`${m[0]}; return imagePaths;`)() as (t: unknown) => string[];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const dir = mkdtempSync(join(tmpdir(), 'sd-image-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('page : chemins d\'images dans un message', () => {
  test('entre accents graves, comme Claude les écrit, dans l\'ordre du texte', () => {
    const t = 'Captures :\n- `C:\\Temp\\shots\\screenshot-1-0.jpg` (volet)\n- `C:\\Temp\\shots\\screenshot-2-1.png` (post-call)';
    expect(imagePaths(t)).toEqual(['C:\\Temp\\shots\\screenshot-1-0.jpg', 'C:\\Temp\\shots\\screenshot-2-1.png']);
  });
  test('entre guillemets ou chevrons : espaces admis ; nu : jusqu\'au premier blanc, ponctuation finale retirée', () => {
    expect(imagePaths('Capture : "C:\\Users\\a\\My Pictures\\x.png"')).toEqual(['C:\\Users\\a\\My Pictures\\x.png']);
    expect(imagePaths('voir « D:/captures/écran 1.webp »')).toEqual(['D:/captures/écran 1.webp']);
    expect(imagePaths('Fichier C:\\tmp\\a.gif. Puis C:\\tmp\\b.PNG, et (C:\\tmp\\c.jpeg)')).toEqual(['C:\\tmp\\a.gif', 'C:\\tmp\\b.PNG', 'C:\\tmp\\c.jpeg']);
  });
  test('sans doublon (casse ignorée), huit au plus', () => {
    expect(imagePaths('`C:\\a.png` puis C:\\A.PNG')).toEqual(['C:\\a.png']);
    expect(imagePaths(Array.from({ length: 12 }, (_, i) => `\`C:\\s\\${i}.png\``).join(' '))).toHaveLength(8);
  });
  test('ignorés : relatif, autre extension, partage réseau, flux NTFS, URL', () => {
    for (const t of ['`docs/demo.gif`', '`C:\\x\\notes.txt`', '`\\\\serveur\\partage\\x.png`', '`//serveur/x.png`', '`C:\\x.png:flux.png`',
      'https://example.com/x.png', '', null]) expect(imagePaths(t), String(t)).toEqual([]);
  });
});

describe('serveur : chemin admis', () => {
  test('disque local seulement', () => {
    expect(imagePathOk('C:\\Temp\\x.png', 'win32')).toBe(true);
    expect(imagePathOk('c:/temp/x.JPG', 'win32')).toBe(true);
    expect(imagePathOk('/tmp/x.png', 'linux')).toBe(true);
    for (const p of ['\\\\serveur\\partage\\x.png', '//serveur/x.png', '\\\\?\\C:\\x.png', 'x.png', '..\\x.png', '/tmp/x.png', 'C:\\x.svg',
      'C:\\x.png:flux.png', 'C:\\x".png', 'C:\\x\n.png', '']) expect(imagePathOk(p, 'win32'), p).toBe(false);
    expect(imagePathOk(null)).toBe(false);
    expect(imagePathOk('//serveur/x.png', 'linux')).toBe(false);
  });
  test('signatures reconnues ; le reste n\'est pas une image', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('BM'))).toBe('image/bmp');
    expect(sniffImage(Buffer.from('<svg onload="x()">'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('serveur : lecture', () => {
  const at = (name: string, body: Buffer | string): string => { const f = join(dir, name); writeFileSync(f, body); return f; };
  test('une vraie image : servie avec le type de sa signature', () => {
    const r = readImage(at('capture.jpg', PNG));
    expect(r.status).toBe(200); expect(r.type).toBe('image/png'); expect(r.body.equals(PNG)).toBe(true);
  });
  test('refus : déguisée, vide, absente, trop grosse, dossier, chemin invalide', () => {
    expect(readImage(at('faux.png', '<html>')).status).toBe(415);
    expect(readImage(at('vide.png', '')).status).toBe(415);
    expect(readImage(join(dir, 'absente.png')).status).toBe(404);
    expect(readImage(at('gros.png', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE)]))).status).toBe(413);
    const sub = join(dir, 'dossier.png'); mkdirSync(sub);
    expect(readImage(sub).status).toBe(404);
    expect(readImage('relatif.png').status).toBe(400);
  });
});
