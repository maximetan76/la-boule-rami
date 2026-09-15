import { describe, expect, it } from 'vitest';
import { compterCroix, croixALaPose, detecterQuinteFlushRoyale } from '../game-engine/croix.js';
import { echangerJoker, jouerTour } from '../game-engine/tour.js';
import { c, coucouPour, coup, jokerPour, recap, tierce } from './fixtures.js';
import type { Carte, Combinaison, Couleur } from '../models/index.js';

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

/** Une combinaison telle que le moteur la signe à la pose, croix arrêtées. */
const poseeDUnCoup = <T extends Combinaison>(combinaison: T): T => ({
  ...combinaison,
  croix: croixALaPose(combinaison),
});

describe('compterCroix', () => {
  it('additionne les croix arretees a la pose : 2 pour une quinte pure, 1 au coucou', () => {
    expect(compterCroix(coup({ combinaisons: [poseeDUnCoup(quintePure())] }), 'j1')).toBe(2);

    const avecCoucou = tierce('pique', [
      c('pique', 10),
      c('pique', 'V'),
      c('pique', 'D'),
      coucouPour('pique', 'R'),
      c('pique', 'A'),
    ]);
    expect(compterCroix(coup({ combinaisons: [poseeDUnCoup(avecCoucou)] }), 'j1')).toBe(1);
  });

  it('cumule les croix de plusieurs quintes', () => {
    const partie = coup({ combinaisons: [poseeDUnCoup(quintePure('coeur')), poseeDUnCoup(quintePure('pique'))] });
    expect(compterCroix(partie, 'j1')).toBe(4);
  });

  it('n accorde rien au joueur qui n a pas pose la quinte', () => {
    expect(compterCroix(coup({ combinaisons: [poseeDUnCoup(quintePure('coeur', 'j1'))] }), 'j2')).toBe(0);
  });

  it('ne juge pas la table en fin de coup : une quinte que la pose n a pas marquee ne rapporte rien', () => {
    expect(compterCroix(coup({ combinaisons: [quintePure()] }), 'j1')).toBe(0);
  });
});

describe('croixALaPose', () => {
  it('ne regarde que la quinte posee : le 9 de la meme couleur pose a cote n y change rien', () => {
    expect(croixALaPose(quintePure('coeur'))).toBe(2);
  });

  it('annule le bonus d une quinte qui porte un joker tout juste repris', () => {
    const coucouRepris = coucouPour('coeur', 10);
    const quinte = tierce('coeur', [coucouRepris, c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')]);
    expect(croixALaPose(quinte)).toBe(1);
    expect(croixALaPose(quinte, [coucouRepris.carte.id])).toBe(0);
  });
});

describe('croix : seule une quinte posee d un seul coup compte, au fil des tours', () => {
  /** Le tour de j1, qui a déjà ouvert son jeu. */
  const tourDeJ1 = (main: Carte[], combinaisons: Combinaison[] = []) =>
    coup({
      mains: { j1: main, j2: [c('pique', 2), c('pique', 4)], j3: [c('trefle', 2)] },
      pioche: [c('carreau', 4), c('carreau', 6)],
      combinaisons,
      recapitulatifs: { j1: recap({ toursAvecPose: [1] }), j2: recap(), j3: recap() },
      numeroTour: 2,
    });
  const royale = (couleur: Couleur) => [c(couleur, 10), c(couleur, 'V'), c(couleur, 'D'), c(couleur, 'R'), c(couleur, 'A')];

  it('les 5 cartes posees d un coup : 2 croix, qui restent quand la quinte grandit plus tard', () => {
    const cartes = royale('coeur');
    const aJeter = c('pique', 3);
    const { coup: apres } = jouerTour(tourDeJ1([...cartes, aJeter]), 'j1', {
      source: 'pioche',
      poses: [tierce('coeur', cartes)],
      carteDefausseeId: aJeter.id,
    });
    expect(compterCroix(apres, 'j1')).toBe(2);

    const quinte = apres.combinaisons[0] as Combinaison;
    const neuf = c('coeur', 9);
    const autreAJeter = c('pique', 5);
    const { coup: prolongee } = jouerTour(tourDeJ1([neuf, autreAJeter], [quinte]), 'j1', {
      source: 'pioche',
      ajouts: [{ combinaisonId: quinte.id, cartes: [{ carte: neuf, remplace: null }] }],
      carteDefausseeId: autreAJeter.id,
    });
    expect(prolongee.combinaisons[0]?.cartes).toHaveLength(6);
    expect(compterCroix(prolongee, 'j1')).toBe(2);
  });

  it('les 5 posees d un coup avec le coucou tenu en main : 1 croix', () => {
    const coucouEnDix = coucouPour('pique', 10);
    const reste = [c('pique', 'V'), c('pique', 'D'), c('pique', 'R'), c('pique', 'A')];
    const aJeter = c('coeur', 3);
    const { coup: apres } = jouerTour(tourDeJ1([coucouEnDix.carte, ...reste, aJeter]), 'j1', {
      source: 'pioche',
      poses: [tierce('pique', [coucouEnDix, ...reste])],
      carteDefausseeId: aJeter.id,
    });
    expect(compterCroix(apres, 'j1')).toBe(1);
  });

  it('A-R-D-V deja posee, le 10 reel ajoute a un tour suivant : aucune croix', () => {
    const quatre = tierce('coeur', [c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')], 'j1', 1);
    const dix = c('coeur', 10);
    const aJeter = c('pique', 3);
    const { coup: apres } = jouerTour(tourDeJ1([dix, aJeter], [quatre]), 'j1', {
      source: 'pioche',
      ajouts: [{ combinaisonId: quatre.id, cartes: [{ carte: dix, remplace: null }] }],
      carteDefausseeId: aJeter.id,
    });
    const quinte = apres.combinaisons[0] as Combinaison;
    expect(detecterQuinteFlushRoyale(quinte)).toBe(true);
    expect(compterCroix(apres, 'j1')).toBe(0);
  });

  it('scenario rapporte : A-R-D-V de coeur posee, coucou recupere ailleurs et place en 10 : aucune croix', () => {
    const quatre = tierce('coeur', [c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')], 'j1', 1);
    const coucouEnSix = coucouPour('trefle', 6);
    const ailleurs = tierce('trefle', [c('trefle', 5), coucouEnSix, c('trefle', 7)], 'j2', 1);
    const six = c('trefle', 6);
    const aJeter = c('pique', 3);
    const { coup: avecEchange, joker: repris } = echangerJoker(tourDeJ1([six, aJeter], [quatre, ailleurs]), 'j1', six, {
      combinaisonId: ailleurs.id,
      carteJokerId: coucouEnSix.carte.id,
    });

    const { coup: apres } = jouerTour(avecEchange, 'j1', {
      source: 'pioche',
      ajouts: [{ combinaisonId: quatre.id, cartes: [{ carte: repris, remplace: { couleur: 'coeur', valeur: 10 } }] }],
      carteDefausseeId: aJeter.id,
      jokersRecuperes: [repris.id],
    });
    const quinte = apres.combinaisons.find((combinaison) => combinaison.id === quatre.id) as Combinaison;
    // Sur la table, c'est bien une quinte au coucou…
    expect(detecterQuinteFlushRoyale(quinte, true)).toBe(true);
    // … mais formée par un ajout, avec un coucou repris : aucune croix.
    expect(compterCroix(apres, 'j1')).toBe(0);
  });

  it('le coucou repris et pose avec les quatre autres cartes d un coup ne rapporte rien non plus', () => {
    const reste = [c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];
    const coucouEnSix = coucouPour('trefle', 6);
    const ailleurs = tierce('trefle', [c('trefle', 5), coucouEnSix, c('trefle', 7)], 'j2', 1);
    const six = c('trefle', 6);
    const aJeter = c('pique', 3);
    const { coup: avecEchange, joker: repris } = echangerJoker(tourDeJ1([six, ...reste, aJeter], [ailleurs]), 'j1', six, {
      combinaisonId: ailleurs.id,
      carteJokerId: coucouEnSix.carte.id,
    });

    const { coup: apres } = jouerTour(avecEchange, 'j1', {
      source: 'pioche',
      poses: [tierce('coeur', [{ carte: repris, remplace: { couleur: 'coeur', valeur: 10 } }, ...reste])],
      carteDefausseeId: aJeter.id,
      jokersRecuperes: [repris.id],
    });
    expect(compterCroix(apres, 'j1')).toBe(0);
  });
});

describe('croix verrouillees des la pose, sans exception', () => {
  // Réf. docs/REGLES.md § « Bonus quinte flush royale ».
  const royale = () => [c('coeur', 10), c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];

  it('la quinte et 7-8-9 de coeur poses dans le meme tour : les 2 croix sont acquises', () => {
    const quinte = royale();
    const suite = [c('coeur', 7), c('coeur', 8), c('coeur', 9)];
    const aJeter = c('pique', 3);
    const { coup: apres } = jouerTour(
      coup({
        mains: { j1: [...quinte, ...suite, aJeter], j2: [c('pique', 2)], j3: [c('trefle', 2)] },
        pioche: [c('carreau', 4)],
        recapitulatifs: { j1: recap({ toursAvecPose: [1] }), j2: recap(), j3: recap() },
      }),
      'j1',
      { source: 'pioche', poses: [tierce('coeur', quinte), tierce('coeur', suite)], carteDefausseeId: aJeter.id },
    );
    expect(compterCroix(apres, 'j1')).toBe(2);
  });

  it('au tour suivant, un autre joueur ajoute le 9 a la quinte : les croix de son poseur restent inchangees', () => {
    const quinte = { ...tierce('coeur', royale(), 'j1', 1), croix: 2 };
    const neuf = c('coeur', 9);
    const aJeter = c('pique', 3);
    const { coup: apres } = jouerTour(
      coup({
        mains: { j1: [c('pique', 2)], j2: [neuf, aJeter], j3: [c('trefle', 2)] },
        pioche: [c('carreau', 4)],
        combinaisons: [quinte],
        joueurActifId: 'j2',
        numeroTour: 2,
        recapitulatifs: { j1: recap({ toursAvecPose: [1] }), j2: recap({ toursAvecPose: [1] }), j3: recap() },
      }),
      'j2',
      { source: 'pioche', ajouts: [{ combinaisonId: quinte.id, cartes: [{ carte: neuf, remplace: null }] }], carteDefausseeId: aJeter.id },
    );
    expect(apres.combinaisons[0]?.cartes).toHaveLength(6);
    expect(compterCroix(apres, 'j1')).toBe(2);
    expect(compterCroix(apres, 'j2')).toBe(0);
  });
});
