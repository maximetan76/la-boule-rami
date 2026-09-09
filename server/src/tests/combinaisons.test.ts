import { describe, expect, it } from 'vitest';
import {
  calculerValeurCombinaison,
  estTiercePure,
  estTierceValidante,
  estTierceValide,
} from '../game-engine/combinaisons.js';
import { c, coucou, coucouPour, ensemble, joker, jokerPour, tierce } from './fixtures.js';

/**
 * Réf. docs/REGLES.md § « Conditions pour poser » (calcul des points, tierce,
 * tierce pure, exception du coucou) et § « Bonus quinte flush royale ».
 */

describe('calculerValeurCombinaison', () => {
  it('additionne les valeurs faciales d une tierce ordinaire', () => {
    // 7 + 8 + 9 = 24
    expect(calculerValeurCombinaison(tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)]))).toBe(24);
  });

  it('compte les figures pour 10 points', () => {
    // V + D + R = 30
    expect(calculerValeurCombinaison(tierce('pique', [c('pique', 'V'), c('pique', 'D'), c('pique', 'R')]))).toBe(30);
  });

  it('compte l as pour 1 point dans une tierce As-2-3', () => {
    expect(calculerValeurCombinaison(tierce('pique', [c('pique', 'A'), c('pique', 2), c('pique', 3)]))).toBe(6);
  });

  it('compte l as pour 1 point dans une tierce As-2-3-4-5', () => {
    const t = tierce('trefle', [c('trefle', 'A'), c('trefle', 2), c('trefle', 3), c('trefle', 4), c('trefle', 5)]);
    expect(calculerValeurCombinaison(t)).toBe(15);
  });

  it('compte l as pour 11 points dans une tierce D-R-A', () => {
    // 10 + 10 + 11 = 31
    expect(calculerValeurCombinaison(tierce('coeur', [c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')]))).toBe(31);
  });

  it('vaut 51 points pour une quinte flush royale pure', () => {
    // 10 + V + D + R + A = 10 + 10 + 10 + 10 + 11 = 51 (§ Bonus quinte flush royale)
    const quinte = tierce('coeur', [
      c('coeur', 10),
      c('coeur', 'V'),
      c('coeur', 'D'),
      c('coeur', 'R'),
      c('coeur', 'A'),
    ]);
    expect(calculerValeurCombinaison(quinte)).toBe(51);
  });

  it('compte l as pour 11 points dans un brelan d as', () => {
    expect(calculerValeurCombinaison(ensemble('A', [c('pique', 'A'), c('coeur', 'A'), c('trefle', 'A')]))).toBe(33);
  });

  it('compte un brelan de valets 30 points et un carre de 8 pour 32', () => {
    expect(calculerValeurCombinaison(ensemble('V', [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')]))).toBe(30);
    const carre = ensemble(8, [c('pique', 8), c('coeur', 8), c('trefle', 8), c('carreau', 8)]);
    expect(calculerValeurCombinaison(carre)).toBe(32);
  });

  it('ne compte aucun point de pose pour un joker normal', () => {
    // 5 + (joker a la place du 6) + 7 = 12
    expect(calculerValeurCombinaison(tierce('trefle', [c('trefle', 5), jokerPour('trefle', 6), c('trefle', 7)]))).toBe(12);
  });

  it('ne compte aucun point de pose pour le coucou', () => {
    // 10 + V + D + (coucou a la place du R) + A = 10 + 10 + 10 + 0 + 11 = 41
    const quinte = tierce('coeur', [
      c('coeur', 10),
      c('coeur', 'V'),
      c('coeur', 'D'),
      coucouPour('coeur', 'R'),
      c('coeur', 'A'),
    ]);
    expect(calculerValeurCombinaison(quinte)).toBe(41);
  });

  it('refuse de chiffrer une combinaison invalide', () => {
    expect(() => calculerValeurCombinaison(tierce('coeur', [c('coeur', 2), c('coeur', 5), c('coeur', 9)]))).toThrow();
  });
});

describe('estTierceValide', () => {
  it('accepte 3 a 5 cartes consecutives de la meme couleur', () => {
    expect(estTierceValide(tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)]))).toBe(true);
    const cinq = tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9), c('coeur', 10), c('coeur', 'V')]);
    expect(estTierceValide(cinq)).toBe(true);
  });

  it('refuse moins de 3 cartes', () => {
    expect(estTierceValide(tierce('coeur', [c('coeur', 7), c('coeur', 8)]))).toBe(false);
  });

  it('refuse 6 cartes ou plus : la suite doit etre scindee en tierces', () => {
    // § Bonus quinte flush royale, contrainte generale
    const six = tierce('pique', [
      c('pique', 5),
      c('pique', 6),
      c('pique', 7),
      c('pique', 8),
      c('pique', 9),
      c('pique', 10),
    ]);
    expect(estTierceValide(six)).toBe(false);
  });

  it('refuse des couleurs melangees', () => {
    expect(estTierceValide(tierce('coeur', [c('coeur', 7), c('pique', 8), c('coeur', 9)]))).toBe(false);
  });

  it('refuse des cartes non consecutives', () => {
    expect(estTierceValide(tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 10)]))).toBe(false);
  });

  it('refuse un doublon de valeur (2 jeux de 52)', () => {
    expect(estTierceValide(tierce('coeur', [c('coeur', 7), c('coeur', 7), c('coeur', 8)]))).toBe(false);
  });

  it('accepte l as en bas (A-2-3) et en haut (D-R-A)', () => {
    expect(estTierceValide(tierce('pique', [c('pique', 'A'), c('pique', 2), c('pique', 3)]))).toBe(true);
    expect(estTierceValide(tierce('pique', [c('pique', 'D'), c('pique', 'R'), c('pique', 'A')]))).toBe(true);
  });

  it('refuse de boucler autour de l as (R-A-2)', () => {
    expect(estTierceValide(tierce('pique', [c('pique', 'R'), c('pique', 'A'), c('pique', 2)]))).toBe(false);
  });

  it('accepte un joker ou le coucou en remplacement d une carte', () => {
    expect(estTierceValide(tierce('trefle', [c('trefle', 7), joker(), c('trefle', 9)]))).toBe(true);
    expect(estTierceValide(tierce('trefle', [c('trefle', 7), coucou(), c('trefle', 9)]))).toBe(true);
    const deuxJokers = tierce('trefle', [c('trefle', 5), joker(), joker(), c('trefle', 8)]);
    expect(estTierceValide(deuxJokers)).toBe(true);
  });

  it('refuse un joker qui declare une carte incoherente avec la suite', () => {
    expect(estTierceValide(tierce('trefle', [c('trefle', 7), jokerPour('trefle', 4), c('trefle', 9)]))).toBe(false);
  });

  it('refuse une combinaison qui n est pas une tierce', () => {
    expect(estTierceValide(ensemble('V', [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')]))).toBe(false);
  });
});

describe('estTiercePure', () => {
  it('est vraie pour une tierce valide sans aucun joker', () => {
    expect(estTiercePure(tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)]))).toBe(true);
  });

  it('est fausse des qu un joker normal est present', () => {
    expect(estTiercePure(tierce('coeur', [c('coeur', 7), jokerPour('coeur', 8), c('coeur', 9)]))).toBe(false);
  });

  it('est fausse avec le coucou : « une tierce sans aucun joker dedans »', () => {
    expect(estTiercePure(tierce('coeur', [c('coeur', 7), coucouPour('coeur', 8), c('coeur', 9)]))).toBe(false);
  });

  it('est fausse si la tierce n est pas valide', () => {
    expect(estTiercePure(tierce('coeur', [c('coeur', 2), c('coeur', 5), c('coeur', 9)]))).toBe(false);
  });
});

describe('estTierceValidante', () => {
  it('accepte une tierce pure', () => {
    expect(estTierceValidante(tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)]))).toBe(true);
  });

  it('accepte le coucou : seule exception des regles', () => {
    expect(estTierceValidante(tierce('coeur', [c('coeur', 7), coucouPour('coeur', 8), c('coeur', 9)]))).toBe(true);
  });

  it('refuse un joker normal', () => {
    expect(estTierceValidante(tierce('coeur', [c('coeur', 7), jokerPour('coeur', 8), c('coeur', 9)]))).toBe(false);
  });
});
