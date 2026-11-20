// LANGUE DES MESSAGES RENDUS À LA PAGE — anglais ou français.
//
// Chaque texte destiné à l'utilisateur s'écrit `T('texte français', 'English text')` : les deux versions côte à côte,
// sans table de clés à tenir à jour. La langue est celle de la requête en cours (en-tête `X-SD-Lang`, posé par la
// page sur chaque appel), retrouvée par AsyncLocalStorage : aucune fonction n'a à la faire suivre en paramètre.
// Hors requête (tâches de fond, journaux) ou sans en-tête : français, le comportement historique.
import { AsyncLocalStorage } from 'node:async_hooks';

export type Lang = 'fr' | 'en';
const current = new AsyncLocalStorage<Lang>();

/** Langue demandée par une requête : `en` ou `fr` (en-tête `X-SD-Lang`), français par défaut. */
export function langOf(header: string | string[] | undefined): Lang {
  const v = (Array.isArray(header) ? header[0] ?? '' : header ?? '').trim().toLowerCase();
  return v.startsWith('en') ? 'en' : 'fr';
}
/** Exécute `fn` (et tout ce qu'elle attend) dans la langue `lang`. */
export function withLang<R>(lang: Lang, fn: () => R): R { return current.run(lang, fn); }
/** Le texte dans la langue de la requête en cours. */
export const T = (fr: string, en: string): string => (current.getStore() === 'en' ? en : fr);
