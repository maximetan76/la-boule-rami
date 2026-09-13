import { describe, expect, it } from 'vitest';
import type { Carte } from '../models/index.js';
import { verifierDeclarationsJokers } from '../game-engine/combinaisons.js';
import { jouerTour } from '../game-engine/tour.js';
import { c, coucouPour, coup, jokerPour, recap, tierce } from './fixtures.js';

/**
 * Réf. docs/REGLES.md § « Conditions pour poser » : une tierce d'une seule
 * carte réelle et de deux jokers encadre la carte, et jamais un As.
 */

describe('tierce d une seule carte et de deux jokers : la carte au centre', () => {
  it('accepte le 8 de trefle encadre : [7]-8-[9]', () => {
    const suite = tierce('trefle', [jokerPour('trefle', 7), c('trefle', 8), jokerPour('trefle', 9)]);
    expect(() => verifierDeclarationsJokers([suite])).not.toThrow();
  });

  it('accepte le valet encadre par le 10 et la dame, coucou compris : [10]-V-[D]', () => {
    const suite = tierce('coeur', [jokerPour('coeur', 10), c('coeur', 'V'), coucouPour('coeur', 'D')]);
    expect(() => verifierDeclarationsJokers([suite])).not.toThrow();
  });

  it('accepte le roi encadre par la dame et l as : [D]-R-[A]', () => {
    const suite = tierce('pique', [jokerPour('pique', 'D'), c('pique', 'R'), jokerPour('pique', 'A')]);
    expect(() => verifierDeclarationsJokers([suite])).not.toThrow();
  });

  it('refuse deux jokers du meme cote de la carte : 8-[9]-[10]', () => {
    const suite = tierce('trefle', [c('trefle', 8), jokerPour('trefle', 9), jokerPour('trefle', 10)]);
    expect(() => verifierDeclarationsJokers([suite])).toThrow(/encadrer la carte/);
  });

  it('refuse un As encadre par deux jokers, en haut comme en bas', () => {
    const haut = tierce('trefle', [c('trefle', 'A'), jokerPour('trefle', 'R'), jokerPour('trefle', 'D')]);
    const bas = tierce('trefle', [c('trefle', 'A'), jokerPour('trefle', 2), coucouPour('trefle', 3)]);
    expect(() => verifierDeclarationsJokers([haut])).toThrow(/As ne peut pas etre encadre par deux jokers/);
    expect(() => verifierDeclarationsJokers([bas])).toThrow(/As ne peut pas etre encadre par deux jokers/);
  });

  it('ne touche pas une tierce de deux cartes reelles et d un joker : 8-9-[10]', () => {
    const suite = tierce('trefle', [c('trefle', 8), c('trefle', 9), jokerPour('trefle', 10)]);
    expect(() => verifierDeclarationsJokers([suite])).not.toThrow();
  });

  const coupDejaOuvert = (main: Carte[]) =>
    coup({
      mains: { j1: main, j2: [], j3: [] },
      pioche: [c('carreau', 2)],
      recapitulatifs: {
        j1: recap({ toursAvecPose: [1] }),
        j2: recap({ toursAvecPose: [] }),
        j3: recap({ toursAvecPose: [] }),
      },
    });

  it('accepte au tour meme la pose [7]-8-[coucou=9]', () => {
    const sept = jokerPour('trefle', 7);
    const neuf = coucouPour('trefle', 9);
    const huit = c('trefle', 8);
    const deux = c('pique', 2);
    const depart = coupDejaOuvert([sept.carte, huit, neuf.carte, deux]);

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'pioche',
      poses: [tierce('trefle', [sept, huit, neuf])],
      carteDefausseeId: deux.id,
    });
    expect(apres.combinaisons).toHaveLength(1);
  });

  it('refuse au tour meme la pose d un As encadre', () => {
    const as = c('trefle', 'A');
    const roi = jokerPour('trefle', 'R');
    const dame = jokerPour('trefle', 'D');
    const deux = c('pique', 2);
    const depart = coupDejaOuvert([as, roi.carte, dame.carte, deux]);

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        poses: [tierce('trefle', [as, roi, dame])],
        carteDefausseeId: deux.id,
      }),
    ).toThrow(/As ne peut pas etre encadre par deux jokers/);
  });
});
