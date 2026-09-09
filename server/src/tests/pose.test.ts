import { describe, expect, it } from 'vitest';
import { DeclarationJokerRequiseError } from '../game-engine/combinaisons.js';
import { peutPoser } from '../game-engine/pose.js';
import { calculerValeurCombinaison } from '../game-engine/combinaisons.js';
import type { Carte, Combinaison } from '../models/index.js';
import { c, coucou, coucouPour, ensemble, joker, jokerPour, tierce } from './fixtures.js';

/**
 * Réf. docs/REGLES.md § « Conditions pour poser » : il faut réunir DEUX
 * conditions cumulatives — au moins 51 points ET au moins une tierce pure.
 */

const mainDe = (...cartes: Carte[]): Carte[] => cartes;

describe('peutPoser', () => {
  it('accepte un brelan de valets et une tierce 7-8-9 de coeur (30 + 24 = 54)', () => {
    const valets = [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')];
    const suite = [c('coeur', 7), c('coeur', 8), c('coeur', 9)];
    const main = mainDe(...valets, ...suite, c('pique', 2));

    expect(peutPoser(main, [ensemble('V', valets), tierce('coeur', suite)])).toBe(true);
  });

  it('accepte exactement 51 points : la quinte flush royale pure', () => {
    const quinte = [c('coeur', 10), c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];
    expect(peutPoser(mainDe(...quinte), [tierce('coeur', quinte)])).toBe(true);
  });

  it('refuse en dessous de 51 points meme avec une tierce pure (30 + 18 = 48)', () => {
    const valets = [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')];
    const suite = [c('coeur', 5), c('coeur', 6), c('coeur', 7)];
    const main = mainDe(...valets, ...suite);

    expect(peutPoser(main, [ensemble('V', valets), tierce('coeur', suite)])).toBe(false);
  });

  it('refuse 51 points sans aucune tierce (brelan d as + brelan de valets = 63)', () => {
    const as = [c('pique', 'A'), c('coeur', 'A'), c('trefle', 'A')];
    const valets = [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')];
    const main = mainDe(...as, ...valets);

    expect(peutPoser(main, [ensemble('A', as), ensemble('V', valets)])).toBe(false);
  });

  it('refuse une tierce contenant un joker normal comme tierce de validation', () => {
    // 5 + joker (le 6) + 7 de trefle = 18, + brelan d as 33 + brelan de valets 30 = 81 points,
    // mais aucune tierce sans joker normal : la pose est refusee.
    const jokerPosee = jokerPour('trefle', 6);
    const suite = [c('trefle', 5), jokerPosee, c('trefle', 7)];
    const as = [c('pique', 'A'), c('coeur', 'A'), c('trefle', 'A')];
    const valets = [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')];
    const main = mainDe(suite[0] as Carte, jokerPosee.carte, suite[2] as Carte, ...as, ...valets);

    expect(peutPoser(main, [tierce('trefle', suite), ensemble('A', as), ensemble('V', valets)])).toBe(false);
  });

  it('accepte le coucou dans la tierce de validation : seule exception des regles', () => {
    // 10 + V + D + coucou (a la place du R) + A = 51, + brelan d as 33 = 84.
    const coucouPosee = coucouPour('coeur', 'R');
    const quinte = [c('coeur', 10), c('coeur', 'V'), c('coeur', 'D'), coucouPosee, c('coeur', 'A')];
    const as = [c('pique', 'A'), c('carreau', 'A'), c('trefle', 'A')];
    const main = mainDe(
      quinte[0] as Carte,
      quinte[1] as Carte,
      quinte[2] as Carte,
      coucouPosee.carte,
      quinte[4] as Carte,
      ...as,
    );

    expect(peutPoser(main, [tierce('coeur', quinte), ensemble('A', as)])).toBe(true);
  });

  it('accepte une tierce pure accompagnee d une autre combinaison contenant un joker', () => {
    // Explicitement autorise : « si le joueur a une tierce pure ET un joker dans
    // une autre combinaison posee en meme temps, c est autorise ».
    // Tierce pure D-R-A de coeur = 31, brelan de valets avec joker = 10 + 10 + 10 = 30,
    // soit 61 points : la tierce de validation est pure, le joker est ailleurs.
    const suite = [c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];
    const valets = [c('pique', 'V'), c('trefle', 'V'), joker()];
    const main = mainDe(...suite, ...valets);

    expect(peutPoser(main, [tierce('coeur', suite), ensemble('V', valets)])).toBe(true);
  });

  it('atteint les 51 points grace a la valeur de la carte remplacee par un joker', () => {
    // Tierce V-joker(D)-R de pique = 30 et tierce pure 7-8-9 de coeur = 24, soit 54.
    // Avec un joker compte pour 0, le total serait de 44 et la pose refusee.
    const jokerDame = jokerPour('pique', 'D');
    const figures = [c('pique', 'V'), jokerDame, c('pique', 'R')];
    const suite = [c('coeur', 7), c('coeur', 8), c('coeur', 9)];
    const main = mainDe(figures[0] as Carte, jokerDame.carte, figures[2] as Carte, ...suite);

    expect(peutPoser(main, [tierce('pique', figures), tierce('coeur', suite)])).toBe(true);
  });

  it('refuse si une carte proposee n est pas dans la main', () => {
    const suite = [c('coeur', 7), c('coeur', 8), c('coeur', 9)];
    const valets = [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')];
    const main = mainDe(...suite, ...valets.slice(0, 2));

    expect(peutPoser(main, [ensemble('V', valets), tierce('coeur', suite)])).toBe(false);
  });

  it('refuse qu un meme exemplaire de carte serve dans deux combinaisons', () => {
    const asPique = c('pique', 'A');
    const premier = [asPique, c('coeur', 'A'), c('trefle', 'A')];
    const second = [asPique, c('carreau', 'A'), coucou()];
    const main = mainDe(...premier, second[1] as Carte, second[2] as Carte);

    expect(peutPoser(main, [ensemble('A', premier), ensemble('A', second)])).toBe(false);
  });

  it('refuse une suite de 6 cartes non scindee en tierces', () => {
    const suite = [
      c('pique', 9),
      c('pique', 10),
      c('pique', 'V'),
      c('pique', 'D'),
      c('pique', 'R'),
      c('pique', 'A'),
    ];
    expect(peutPoser(mainDe(...suite), [tierce('pique', suite)])).toBe(false);
  });

  it('rejette une pose ou un joker en bout de suite n est pas declare', () => {
    // 7-8-joker de coeur : la suite peut se lire 6-7-8 ou 7-8-9. Pas de lecture
    // par defaut, le joueur doit dire quelle carte son joker represente.
    const j = joker();
    const suite = [c('coeur', 7), c('coeur', 8), j];
    const valets = [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')];
    const main = mainDe(suite[0] as Carte, suite[1] as Carte, j, ...valets);

    expect(() => peutPoser(main, [tierce('coeur', suite), ensemble('V', valets)])).toThrow(
      DeclarationJokerRequiseError,
    );
    expect(() => peutPoser(main, [tierce('coeur', suite), ensemble('V', valets)])).toThrow(
      /declare|remplace/,
    );
  });

  it('accepte la meme pose des que le joker en bout declare la carte representee', () => {
    // Le joker declare le 9 de coeur : la suite se lit 7-8-9 = 24 points,
    // + brelan de valets 30 = 54 points, avec une tierce validante ? non :
    // le joker normal exclut cette tierce de la validation, il faut une autre
    // tierce pure. On en ajoute une : D-R-A de pique = 31.
    const jokerNeuf = jokerPour('coeur', 9);
    const suite = [c('coeur', 7), c('coeur', 8), jokerNeuf];
    const pure = [c('pique', 'D'), c('pique', 'R'), c('pique', 'A')];
    const main = mainDe(suite[0] as Carte, suite[1] as Carte, jokerNeuf.carte, ...pure);

    const proposees = [tierce('coeur', suite), tierce('pique', pure)];
    expect(() => peutPoser(main, proposees)).not.toThrow();
    expect(peutPoser(main, proposees)).toBe(true);
    // 24 + 31 = 55 points
    expect(calculerValeurCombinaison(proposees[0] as Combinaison)).toBe(24);
  });

  it('refuse une proposition vide', () => {
    expect(peutPoser(mainDe(c('coeur', 7)), [])).toBe(false);
  });
});
