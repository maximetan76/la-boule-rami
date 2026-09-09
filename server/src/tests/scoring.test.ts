import { describe, expect, it } from 'vitest';
import { arrondirALaDizaine, calculerScoreCoup, scoreDeLaMain } from '../game-engine/scoring.js';
import { c, coup, coucouPour, recap, tierce } from './fixtures.js';
import type { Carte, Couleur } from '../models/index.js';

/** Réf. docs/REGLES.md § « Fin d'un coup et scoring ». */

/** Une main valant exactement 34 points : As 11 + Roi 10 + 9 + 4. */
const main34 = (): Carte[] => [c('pique', 'A'), c('coeur', 'R'), c('trefle', 9), c('carreau', 4)];
/** Une main valant exactement 35 points : As 11 + Roi 10 + Dame 10 + 4. */
const main35 = (): Carte[] => [c('pique', 'A'), c('coeur', 'R'), c('trefle', 'D'), c('carreau', 4)];

const quintePure = (couleur: Couleur, proprietaire: string) =>
  tierce(
    couleur,
    [c(couleur, 10), c(couleur, 'V'), c(couleur, 'D'), c(couleur, 'R'), c(couleur, 'A')],
    proprietaire,
  );

const coupA3 = (partiel: Parameters<typeof coup>[0] = {}) =>
  coup({
    ordreJoueurs: ['j1', 'j2', 'j3'],
    mains: { j1: [], j2: main34(), j3: main35() },
    recapitulatifs: {
      j1: recap({ toursAvecPose: [2] }),
      j2: recap({ toursAvecPose: [3] }),
      j3: recap({ toursAvecPose: [4] }),
    },
    ...partiel,
  });

describe('arrondirALaDizaine', () => {
  it('arrondit 35 a 40 et 34 a 30, comme dans les regles', () => {
    expect(arrondirALaDizaine(35)).toBe(40);
    expect(arrondirALaDizaine(34)).toBe(30);
  });

  it('arrondit 5 et plus au dessus', () => {
    expect(arrondirALaDizaine(5)).toBe(10);
    expect(arrondirALaDizaine(4)).toBe(0);
    expect(arrondirALaDizaine(0)).toBe(0);
    expect(arrondirALaDizaine(155)).toBe(160);
    expect(arrondirALaDizaine(100)).toBe(100);
  });
});

describe('scoreDeLaMain', () => {
  it('compte l as 11, les figures 10 et arrondit : 34 points donnent 30', () => {
    expect(scoreDeLaMain(main34())).toBe(30);
  });

  it('compte le joker et le coucou 20 points chacun', () => {
    const main = [
      c('pique', 5),
      { type: 'joker', id: 'jk' } as Carte,
      { type: 'coucou', id: 'cc' } as Carte,
    ];
    // 5 + 20 + 20 = 45 -> 50
    expect(scoreDeLaMain(main)).toBe(50);
  });
});

describe('calculerScoreCoup', () => {
  it('victoire simple : -20 pour le gagnant, mains arrondies pour les perdants', () => {
    const score = calculerScoreCoup(coupA3(), 'j1', 'simple', false);
    expect(score.multiplicateur).toBe(1);
    expect(score.scores).toEqual({ j1: -20, j2: 30, j3: 40 });
  });

  it('victoire double : -40 pour le gagnant, scores des perdants doubles (34 -> 30 -> 60)', () => {
    const score = calculerScoreCoup(coupA3(), 'j1', 'double', false);
    expect(score.multiplicateur).toBe(2);
    expect(score.scores).toEqual({ j1: -40, j2: 60, j3: 80 });
  });

  it('victoire triple : -60 pour le gagnant, scores des perdants tripes', () => {
    const score = calculerScoreCoup(coupA3(), 'j1', 'triple', false);
    expect(score.multiplicateur).toBe(3);
    expect(score.scores).toEqual({ j1: -60, j2: 90, j3: 120 });
  });

  it('coup friche : facteur 2 supplementaire sur une victoire simple', () => {
    const score = calculerScoreCoup(coupA3(), 'j1', 'simple', true);
    expect(score.multiplicateur).toBe(2);
    expect(score.scores).toEqual({ j1: -40, j2: 60, j3: 80 });
  });

  it('triple sur coup friche : facteur x6 sur les montants de base', () => {
    const score = calculerScoreCoup(coupA3(), 'j1', 'triple', true);
    expect(score.multiplicateur).toBe(6);
    expect(score.scores).toEqual({ j1: -120, j2: 180, j3: 240 });
  });

  const coupSansPoseDeJ2 = () =>
    coupA3({
      recapitulatifs: {
        j1: recap({ toursAvecPose: [2] }),
        j2: recap({ toursAvecPose: [] }),
        j3: recap({ toursAvecPose: [4] }),
      },
    });

  it('donne 100 points au joueur n ayant pose aucune carte, sans regarder sa main', () => {
    const score = calculerScoreCoup(coupSansPoseDeJ2(), 'j1', 'simple', false);
    // Sa main vaudrait 30 points arrondis : le forfait la remplace.
    expect(score.scores['j2']).toBe(100);
  });

  it('applique les multiplicateurs au forfait comme aux autres perdants', () => {
    const double = calculerScoreCoup(coupSansPoseDeJ2(), 'j1', 'double', false);
    expect(double.scores['j2']).toBe(200);

    const simpleFriche = calculerScoreCoup(coupSansPoseDeJ2(), 'j1', 'simple', true);
    expect(simpleFriche.scores['j2']).toBe(200);
  });

  it('porte le forfait a 600 points sur un triple pendant un coup friche', () => {
    const score = calculerScoreCoup(coupSansPoseDeJ2(), 'j1', 'triple', true);
    expect(score.multiplicateur).toBe(6);
    expect(score.scores['j2']).toBe(600);
    expect(score.scores['j3']).toBe(240);
    // Le gagnant suit le meme facteur x6 sur ses -20 de base.
    expect(score.scores['j1']).toBe(-120);
  });

  it('donne 0 point aux joueurs sur le cote, sans les sortir du decompte', () => {
    const partie = coupA3({ joueursSurLeCote: ['j4'], mains: { j1: [], j2: main34(), j3: main35(), j4: main35() } });
    const score = calculerScoreCoup(partie, 'j1', 'triple', true);
    expect(score.scores['j4']).toBe(0);
    expect(Object.keys(score.scores)).toContain('j4');
  });

  it('compte les croix du coup et les multiplie pour le gagnant en double', () => {
    const partie = coupA3({ combinaisons: [quintePure('coeur', 'j1')] });
    const score = calculerScoreCoup(partie, 'j1', 'double', false);
    expect(score.croixGagnees['j1']).toBe(4);
  });

  it('ne multiplie pas les croix d un joueur qui n est pas le gagnant', () => {
    const partie = coupA3({ combinaisons: [quintePure('coeur', 'j2')] });
    const score = calculerScoreCoup(partie, 'j1', 'triple', false);
    expect(score.croixGagnees['j2']).toBe(2);
  });

  it('n applique pas le facteur friche aux croix', () => {
    const partie = coupA3({ combinaisons: [quintePure('coeur', 'j1')] });
    const surCoupFriche = calculerScoreCoup(partie, 'j1', 'simple', true);
    // Le coup vaut x2 sur les points, mais les croix restent a 2.
    expect(surCoupFriche.multiplicateur).toBe(2);
    expect(surCoupFriche.croixGagnees['j1']).toBe(2);

    const doubleFriche = calculerScoreCoup(partie, 'j1', 'double', true);
    // Seul le double compte pour les croix : x2, pas x4.
    expect(doubleFriche.croixGagnees['j1']).toBe(4);
  });

  it('accorde 1 croix pour une quinte posee avec le coucou', () => {
    const avecCoucou = tierce(
      'pique',
      [c('pique', 10), c('pique', 'V'), c('pique', 'D'), coucouPour('pique', 'R'), c('pique', 'A')],
      'j1',
    );
    const partie = coupA3({ combinaisons: [avecCoucou] });
    const score = calculerScoreCoup(partie, 'j1', 'simple', false);
    expect(score.croixGagnees['j1']).toBe(1);
  });
});
