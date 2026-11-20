// PIÈCES JOINTES (/api/upload) — portage de Front.Upload / Front.CleanName / Front.PurgeUploads.
// Le fichier est écrit sur le poste et la page insère son CHEMIN dans le message. Garde-fous : 20 Mo, liste de types,
// nom JAMAIS repris tel quel (nettoyé, préfixé d'un identifiant), écriture sous ~/.claude/uploads<suffixe>/<jour>/.
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import { trimChars } from './util.ts';

export const MAX_UPLOAD = 20 * 1024 * 1024;
const UPLOAD_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.txt', '.log', '.csv', '.json', '.md']);
const EXT_OF_TYPE: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json', 'text/markdown': '.md',
};

/** Uri.UnescapeDataString : décode ce qui est décodable, laisse le reste tel quel (ne lève jamais). */
export function unescapeData(s: string): string {
  try { return decodeURIComponent(s); } catch {
    const dec = new TextDecoder('utf-8', { fatal: true });
    return s.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
      const hex = run.match(/%[0-9A-Fa-f]{2}/g)!; const bytes = hex.map((h) => parseInt(h.slice(1), 16));
      let out = ''; let i = 0;
      while (i < bytes.length) {
        const b = bytes[i]!;
        const n = b < 0x80 ? 1 : b >= 0xc2 && b < 0xe0 ? 2 : b >= 0xe0 && b < 0xf0 ? 3 : b >= 0xf0 && b < 0xf5 ? 4 : 0;
        if (n && i + n <= bytes.length) { try { out += dec.decode(new Uint8Array(bytes.slice(i, i + n))); i += n; continue; } catch { /* invalide */ } }
        out += hex[i]; i++;
      }
      return out;
    });
  }
}
/** Path.GetExtension */
export function extension(n: string): string {
  const i = n.lastIndexOf('.'); const sep = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
  return i > sep && i < n.length - 1 ? n.slice(i) : '';
}

export function cleanName(raw: string | null | undefined, type: string | null | undefined): string {
  let n = unescapeData(raw ?? '');
  n = n.replace(/\\/g, '/'); const k = n.lastIndexOf('/'); if (k >= 0) n = n.slice(k + 1);
  n = n.normalize('NFD').replace(/\p{Mn}/gu, '');
  n = n.replace(/[^A-Za-z0-9._-]+/g, '_');
  while (n.includes('..')) n = n.replaceAll('..', '.');
  n = trimChars(n, '._- ');
  let ext = extension(n).toLowerCase();
  let stem = trimChars(n.slice(0, n.length - ext.length), '._-');
  const mime = (type ?? '').split(';')[0]!.trim().toLowerCase();
  if (ext === '' && EXT_OF_TYPE[mime]) ext = EXT_OF_TYPE[mime]!;
  if (ext === '.jpeg') ext = '.jpg';
  if (stem.length > 60) stem = stem.slice(0, 60).replace(/[._-]+$/, '');
  if (stem.length === 0) stem = mime.startsWith('image/') ? 'capture' : 'fichier';
  return stem + ext;
}

function localDay(d = new Date()): string { const p = (x: number): string => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

export interface Reply { status: number; body: Record<string, unknown> }

export async function upload(req: IncomingMessage, uploadDir: string | null): Promise<Reply> {
  if (uploadDir === null) return { status: 503, body: { error: 'pièces jointes désactivées' } };
  const lenH = req.headers['content-length'];
  if (lenH === undefined) { req.resume(); return { status: 411, body: { error: 'longueur du fichier inconnue' } }; }
  const len = Number(lenH);
  if (len === 0) return { status: 400, body: { error: 'fichier vide' } };
  if (len > MAX_UPLOAD) { req.resume(); return { status: 413, body: { error: 'fichier trop gros (20 Mo au plus)' } }; }
  const fn = req.headers['x-file-name'];
  const name = cleanName(Array.isArray(fn) ? fn.join(',') : fn, req.headers['content-type']);
  if (!UPLOAD_EXT.has(extension(name).toLowerCase())) { req.resume(); return { status: 415, body: { error: 'type de fichier refusé (images, pdf, txt, log, csv, json, md)' } }; }
  const root = resolve(uploadDir).replace(/\\+$/, '') + '\\';
  const dir = join(root, localDay());
  const file = resolve(dir, randomBytes(4).toString('hex') + '-' + name);
  if (!file.toLowerCase().startsWith(root.toLowerCase())) { req.resume(); return { status: 400, body: { error: 'nom de fichier invalide' } }; }
  mkdirSync(dir, { recursive: true });
  let total = 0; let over = false;
  try {
    await new Promise<void>((ok, ko) => {
      const ws = createWriteStream(file, { flags: 'wx' });
      ws.on('error', ko);
      req.on('data', (c: Buffer) => { if (over) return; total += c.length; if (total > MAX_UPLOAD) { over = true; return; } ws.write(c); });
      req.on('end', () => ws.end(ok));
      req.on('error', ko);
    });
  } catch (e) {
    try { unlinkSync(file); } catch { /* absent */ }
    return { status: 500, body: { error: 'écriture impossible : ' + (e as Error).message } };
  }
  if (over || total === 0) {
    try { unlinkSync(file); } catch { /* absent */ }
    return total === 0 ? { status: 400, body: { error: 'fichier vide' } } : { status: 413, body: { error: 'fichier trop gros (20 Mo au plus)' } };
  }
  return { status: 200, body: { path: file, name, size: total } };
}

/** Purge des dossiers datés plus vieux que N jours (une capture peut montrer des données client). */
export function purgeUploads(uploadDir: string, days: number): number {
  let n = 0;
  const t = new Date(); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - days);
  let names: string[]; try { names = readdirSync(uploadDir); } catch { return 0; }
  for (const d of names) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (!m) continue;
    const day = new Date(+m[1]!, +m[2]! - 1, +m[3]!);
    if (day.getMonth() !== +m[2]! - 1 || day >= t) continue;
    try { rmSync(join(uploadDir, d), { recursive: true, force: true }); n++; } catch { /* verrouillé */ }
  }
  return n;
}
