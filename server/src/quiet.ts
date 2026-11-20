// TOURS SANS NOUVEAUTÉ — une session inactive revient « à relire » à chaque fin de tour, or tous les tours ne sont pas
// lancés par toi. Deux d'entre eux n'apportent rien à lire :
//   · le RÉVEIL PROGRAMMÉ (boucle de surveillance) dont la réponse finale est la même qu'au tour d'avant
//     (« Rien de nouveau… » toutes les 15 min) ;
//   · la RELANCE du veilleur (« 🔔 Relance Teams 1/2 — … ») : la session relance le collègue, rien n'est attendu de toi.
// Tout le reste ramène la session : ton message, la réponse d'un collègue, une tâche de fond terminée, un réveil qui
// dit autre chose que la fois d'avant. Dans le doute (fenêtre de lecture coupée, ligne illisible) : le tour compte.
import { netTrim } from './util.ts';

/** Début de la ligne qu'injecte le veilleur pour faire relancer un collègue (Teams ou email). */
export const RELANCE_MARK = '🔔 Relance ';
const PASTED_RX = /^<pasted_content[^>]*>\s*/;

/** Le texte est-il une relance du veilleur ? (Claude Code enveloppe parfois une longue ligne collée.) */
export function isRelance(text: string): boolean { return netTrim(text).replace(PASTED_RX, '').startsWith(RELANCE_MARK); }

interface Turn { relance: boolean; scheduled: boolean; reply: string; end: number }
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Texte d'un déclencheur de tour (message, réveil, notification) ; null pour un simple retour d'outil. */
function triggerText(content: unknown): string | null {
  if (typeof content === 'string') return netTrim(content) ? content : null;
  if (!Array.isArray(content)) return null;
  const t = content.filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text').map((b) => String((b as { text?: unknown }).text ?? '')).join(' ');
  return netTrim(t) ? t : null;
}

/**
 * Fin du dernier tour QUI APPORTE QUELQUE CHOSE, lue dans la fin du transcript (lignes dans l'ordre du fichier) :
 *   · null  — le dernier tour compte : l'horodatage de statut de la session fait foi ;
 *   · { at } — le ou les derniers tours sont sans nouveauté ; `at` (ms) est la fin du dernier tour qui comptait,
 *     0 s'il est hors de la fenêtre lue. La session n'est « à relire » que si `at` est après le dernier « vu ».
 */
export function lastNewsAt(lines: string[]): { at: number; why: 'relance' | 'réveil' } | null {
  let i = lines.length - 1;
  // Tour précédent, lu à reculons : sa dernière réponse, puis ce qui l'a lancé.
  const prevTurn = (): Turn | null => {
    let reply = ''; let end = 0;
    for (; i >= 0; i--) {
      const l = lines[i]!;
      if (!l.startsWith('{"parentUuid"') || l.includes('"isSidechain":true')) continue;
      const isA = l.includes('"type":"assistant"'); const isU = l.includes('"type":"user"');
      if (!isA && !isU) continue;
      if (isA && (reply || !l.includes('"type":"text"'))) continue;
      let j: { type?: unknown; isSidechain?: unknown; timestamp?: unknown; turnOrigin?: unknown; wakeupSource?: unknown; message?: { content?: unknown } };
      try { j = JSON.parse(l); } catch { continue; }
      if (j.isSidechain) continue;
      const at = Date.parse(String(j.timestamp ?? '')) || 0;
      if (j.type === 'assistant') {
        const c = j.message?.content;
        const texts = Array.isArray(c) ? c.filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') : [];
        const t = texts.length ? norm(String((texts[texts.length - 1] as { text?: unknown }).text ?? '')) : '';
        if (t) { reply = t; end = at; }
      } else if (j.type === 'user') {
        const t = triggerText(j.message?.content);
        if (t === null) continue;
        i--;
        return { relance: isRelance(t), scheduled: j.turnOrigin === 'scheduled' || Boolean(j.wakeupSource), reply, end: end || at };
      }
    }
    return null;
  };
  let cur = prevTurn();
  let why: 'relance' | 'réveil' | null = null;
  while (cur) {
    const prev = prevTurn();
    const quiet = cur.relance ? 'relance' : cur.scheduled && prev !== null && cur.reply !== '' && cur.reply === prev.reply ? 'réveil' : null;
    if (!quiet) return why ? { at: cur.end, why } : null;
    why ??= quiet;
    cur = prev;
  }
  return why ? { at: 0, why } : null;
}
