// Fonctions de la page extraites et exécutées seules par les tests (new Function) : T, l'outil de traduction de la
// page, y est lu comme une variable globale. Les tests lisent la page en français.
(globalThis as Record<string, unknown>).T = (fr: string) => fr;
