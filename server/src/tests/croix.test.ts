import { describe, expect, it } from 'vitest';
import { compterCroix, detecterQuinteFlushRoyale } from '../game-engine/croix.js';
import { c, coucouPour, coup, jokerPour, tierce } from './fixtures.js';
import type { Couleur } from '../models/index.js';

/** Réf. docs/REGLES.md § « Bonus quinte flush royale (les croix) ». */

const quintePure = (couleur: Couleur = 'coeur', proprietaire = 'j1', tour = 1) =>
  tierce(
    couleur,
    [c(couleur, 10), c(couleur, 'V'), c(couleur, 'D'), c(couleur, 'R'), c(couleur, 'A')],
    proprietaire,
    tour,
  );

describe('detecterQuinteFlushRoyale', () => {
  it('reconnait une quinte flush royale pure', () => {
    expect(detecterQuinteFlushRoyale(quintePure())).toBe(true);
    expect(detecterQuinteFlushRoyale(quintePure(), true)).toBe(false);
  });

  it('reconnait une quinte flush royale posee avec le coucou', () => {
    const avecCoucou = tierce('pique', [
      c('pique', 10),
      c('pique', 'V'),
      c('pique', 'D'),
      coucouPour('pique', 'R'),
      c('pique', 'A'),
    ]);
    expect(detecterQuinteFlushRoyale(avecCoucou, true)).toBe(true);
    expect(detecterQuinteFlushRoyale(avecCoucou, false)).toBe(false);
  });

  it('refuse une quinte contenant un joker normal', () => {
    const avecJoker = tierce('pique', [
      c('pique', 10),
      c('pique', 'V'),
      c('pique', 'D'),
      jokerPour('pique', 'R'),
      c('pique', 'A'),
    ]);
    expect(detecterQuinteFlushRoyale(avecJoker, false)).toBe(false);
    expect(detecterQuinteFlushRoyale(avecJoker, true)).toBe(false);
  });

  it('refuse une suite de 5 cartes qui ne monte pas jusqu a l as', () => {
    const suite = tierce('coeur', [
      c('coeur', 9),
      c('coeur', 10),
      c('coeur', 'V'),
      c('coeur', 'D'),
      c('coeur', 'R'),
    ]);
    expect(detecterQuinteFlushRoyale(suite)).toBe(false);
  });
});

describe('compterCroix', () => {
  it('accorde 2 croix pour une quinte pure et 1 pour une quinte au coucou', () => {
    expect(compterCroix(coup({ combinaisons: [quintePure()] }), 'j1')).toBe(2);

    const avecCoucou = tierce('pique', [
      c('pique', 10),
      c('pique', 'V'),
      c('pique', 'D'),
      coucouPour('pique', 'R'),
      c('pique', 'A'),
    ]);
    expect(compterCroix(coup({ combinaisons: [avecCoucou] }), 'j1')).toBe(1);
  });

  it('cumule les croix de plusieurs quintes', () => {
    const partie = coup({ combinaisons: [quintePure('coeur'), quintePure('pique')] });
    expect(compterCroix(partie, 'j1')).toBe(4);
  });

  it('n accorde rien au joueur qui n a pas pose la quinte', () => {
    expect(compterCroix(coup({ combinaisons: [quintePure('coeur', 'j1')] }), 'j2')).toBe(0);
  });

  it('annule le bonus si le 9 de la meme couleur est pose au meme tour', () => {
    // § « le joueur ne doit PAS poser la suite complete en une fois s il a une
    // carte supplementaire qui prolongerait la quinte flush ».
    const prolongement = tierce(
      'coeur',
      [c('coeur', 7), c('coeur', 8), c('coeur', 9)],
      'j1',
      1,
    );
    const partie = coup({ combinaisons: [quintePure('coeur', 'j1', 1), prolongement] });
    expect(compterCroix(partie, 'j1')).toBe(0);
  });

  it('conserve le bonus si le 9 est pose a un tour ulterieur', () => {
    // « il doit poser seulement A-K-Q-J-10 et garder le 9 pour un tour ulterieur ».
    const prolongement = tierce(
      'coeur',
      [c('coeur', 7), c('coeur', 8), c('coeur', 9)],
      'j1',
      4,
    );
    const partie = coup({ combinaisons: [quintePure('coeur', 'j1', 1), prolongement] });
    expect(compterCroix(partie, 'j1')).toBe(2);
  });

  it('ignore un prolongement d une autre couleur', () => {
    const autreCouleur = tierce(
      'pique',
      [c('pique', 7), c('pique', 8), c('pique', 9)],
      'j1',
      1,
    );
    const partie = coup({ combinaisons: [quintePure('coeur', 'j1', 1), autreCouleur] });
    expect(compterCroix(partie, 'j1')).toBe(2);
  });
});
