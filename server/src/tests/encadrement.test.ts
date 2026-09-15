import { describe, expect, it } from 'vitest';
import type { Carte } from '../models/index.js';
import {
  DeclarationJokerRequiseError,
  estEnsembleValide,
  verifierDeclarationsJokers,
} from '../game-engine/combinaisons.js';
import { jouerTour } from '../game-engine/tour.js';
import { c, coucou, coucouPour, coup, ensemble, joker, jokerPour, recap, tierce } from './fixtures.js';

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

describe('suite d une seule carte reelle et de trois jokers : jamais en bout', () => {
  it('accepte le valet en deuxieme ou troisieme place : [9]-[10]-V-[D] et [10]-V-[D]-[R]', () => {
    const basse = tierce('coeur', [jokerPour('coeur', 9), jokerPour('coeur', 10), c('coeur', 'V'), coucouPour('coeur', 'D')]);
    const haute = tierce('coeur', [jokerPour('coeur', 10), c('coeur', 'V'), jokerPour('coeur', 'D'), coucouPour('coeur', 'R')]);
    expect(() => verifierDeclarationsJokers([basse])).not.toThrow();
    expect(() => verifierDeclarationsJokers([haute])).not.toThrow();
  });

  it('refuse le valet en bout de suite : V-[D]-[R]-[A] et [8]-[9]-[10]-V', () => {
    const enBas = tierce('coeur', [c('coeur', 'V'), jokerPour('coeur', 'D'), jokerPour('coeur', 'R'), coucouPour('coeur', 'A')]);
    const enHaut = tierce('coeur', [jokerPour('coeur', 8), jokerPour('coeur', 9), coucouPour('coeur', 10), c('coeur', 'V')]);
    expect(() => verifierDeclarationsJokers([enBas])).toThrow(/jamais en bout/);
    expect(() => verifierDeclarationsJokers([enHaut])).toThrow(/jamais en bout/);
  });

  it('pres du bord du jeu, le roi ne se lit que [V]-[D]-R-[A]', () => {
    const seule = tierce('pique', [jokerPour('pique', 'V'), jokerPour('pique', 'D'), c('pique', 'R'), coucouPour('pique', 'A')]);
    const enBout = tierce('pique', [jokerPour('pique', 10), jokerPour('pique', 'V'), coucouPour('pique', 'D'), c('pique', 'R')]);
    expect(() => verifierDeclarationsJokers([seule])).not.toThrow();
    expect(() => verifierDeclarationsJokers([enBout])).toThrow(/jamais en bout/);
  });

  it('refuse un As seule carte reelle parmi trois jokers', () => {
    const suite = tierce('trefle', [c('trefle', 'A'), jokerPour('trefle', 2), jokerPour('trefle', 3), coucouPour('trefle', 4)]);
    expect(() => verifierDeclarationsJokers([suite])).toThrow(/seule carte reelle d une suite/);
  });

  it('valet et trois jokers poses sans declaration : la declaration est exigee', () => {
    const suite = tierce('coeur', [joker(), c('coeur', 'V'), joker(), coucou()]);
    expect(() => verifierDeclarationsJokers([suite])).toThrow(DeclarationJokerRequiseError);
  });

  it('une seule carte reelle ne forme ni un brelan ni un carre', () => {
    const carre = ensemble('V', [c('coeur', 'V'), joker(), joker(), coucou()]);
    const brelan = ensemble(8, [c('trefle', 8), joker(), coucou()]);
    expect(estEnsembleValide(carre)).toBe(false);
    expect(estEnsembleValide(brelan)).toBe(false);
    expect(() => verifierDeclarationsJokers([carre])).toThrow(/au moins deux cartes reelles/);
    expect(estEnsembleValide(ensemble('V', [c('coeur', 'V'), c('pique', 'V'), joker(), coucou()]))).toBe(true);
  });
});
