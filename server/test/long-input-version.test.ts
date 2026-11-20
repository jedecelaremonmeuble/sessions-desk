// Saisie longue et version de Claude Code (src/actions.ts) : jusqu'à la 2.1.328, un long texte tapé d'un bloc
// arrive amputé de son début ; la garde refuse l'envoi plutôt que de livrer une consigne tronquée en silence.
import { describe, expect, test } from 'vitest';
import { OLD_CC_MAX_LINE, truncatesLongInput } from '../src/actions.ts';

describe('truncatesLongInput', () => {
  test('les versions qui tronquent : 2.1.328 et avant', () => {
    for (const v of ['2.1.328', '2.1.327', '2.0.999', '1.9.400', '2.1.328-beta']) expect(truncatesLongInput(v)).toBe(true);
  });
  test('les versions qui reçoivent tout : 2.1.329 et après', () => {
    for (const v of ['2.1.329', '2.1.330', '2.2.0', '3.0.0']) expect(truncatesLongInput(v)).toBe(false);
  });
  test('version inconnue ou illisible : on ne bloque pas à l\'aveugle', () => {
    for (const v of [null, undefined, '', 'inconnue', 2, '2.1']) expect(truncatesLongInput(v)).toBe(false);
  });
  test('le seuil reste sous la taille du morceau perdu (~800 caractères)', () => {
    expect(OLD_CC_MAX_LINE).toBeLessThan(800);
  });
});
