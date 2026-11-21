// APERÇU D'UNE IMAGE CITÉE PAR CHEMIN (/api/image?path=…). Claude écrit souvent « Captures : `C:\…\capture.png` » :
// la page affiche une vignette de ce fichier au lieu d'un chemin à recopier dans l'explorateur.
// Garde-fous : chemin ABSOLU, extension d'image, contenu VÉRIFIÉ par sa signature (un .png qui n'en est pas un est
// refusé), 20 Mo au plus, jamais de SVG (il peut porter du script). Le type servi vient de la signature, pas du nom.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { T } from './i18n.ts';

export const MAX_IMAGE = 20 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Chemin acceptable pour un aperçu : absolu sur un disque LOCAL (C:\… sous Windows, /… ailleurs), extension
 *  d'image, sans caractère interdit. Jamais un partage réseau (\\serveur\…, //serveur/…) : l'ouvrir enverrait
 *  l'identité Windows du poste à ce serveur. */
export function imagePathOk(p: string | null | undefined, platform: string = process.platform): p is string {
  if (typeof p !== 'string' || p.length < 4 || p.length > 1024) return false;
  if (/[\u0000-\u001f"<>|?*]/.test(p) || /^[\\/]{2}/.test(p) || p.slice(2).includes(':')) return false;   // « : » plus loin = flux NTFS
  if (!IMAGE_EXT.test(p)) return false;
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : isAbsolute(p);
}

/** Type d'image d'après les premiers octets ; null si ce n'en est pas une connue. */
export function sniffImage(b: Buffer): string | null {
  const at = (i: number, ...x: number[]) => x.every((v, k) => b[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x42, 0x4d)) return 'image/bmp';
  return null;
}

export type ImageReply = { status: number; type: string; body: Buffer };

/** Lit le fichier s'il est une image servable. Les erreurs sont des réponses, jamais des exceptions. */
export function readImage(p: string | null | undefined): ImageReply {
  const fail = (status: number, text: string): ImageReply => ({ status, type: 'text/plain; charset=utf-8', body: Buffer.from(text) });
  const missing = (): ImageReply => fail(404, T('image introuvable', 'image not found'));
  if (!imagePathOk(p)) return fail(400, T('chemin d\'image invalide', 'invalid image path'));
  let fd: number;
  try { fd = openSync(p, 'r'); } catch { return missing(); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return missing();
    if (st.size === 0) return fail(415, T('fichier vide', 'empty file'));
    if (st.size > MAX_IMAGE) return fail(413, T('image trop grosse (20 Mo au plus)', 'image too large (20 MB max)'));
    const body = Buffer.alloc(st.size);
    let n = 0; while (n < st.size) { const r = readSync(fd, body, n, st.size - n, n); if (r <= 0) break; n += r; }
    const type = sniffImage(body);
    if (type === null) return fail(415, T('ce fichier n\'est pas une image', 'this file is not an image'));
    return { status: 200, type, body: n === st.size ? body : body.subarray(0, n) };
  } catch { return fail(500, T('image illisible', 'unreadable image')); }
  finally { try { closeSync(fd); } catch { /* déjà fermé */ } }
}
