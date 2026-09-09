import { describe, expect, it } from 'vitest';
import { calculerFinDeBoule } from '../game-engine/fin-de-boule.js';
import { boule } from './fixtures.js';

/** Réf. docs/REGLES.md § « Fin de la Boule (tous les coups joués) ». */

describe('calculerFinDeBoule', () => {
  it('exemple des regles : 340 points, le plus bas et positif, deviennent 240', () => {
    const resultat = calculerFinDeBoule(
      boule({ scoresCumules: { j1: 340, j2: 450, j3: 700, j4: 650 } }),
    );

    expect(resultat.gagnantsIds).toEqual(['j1']);
    expect(resultat.bonusVictoire['j1']).toBe(-100);
    expect(resultat.scoresFinaux).toEqual({ j1: 240, j2: 450, j3: 700, j4: 650 });
  });

  it('exemple des regles : -80 points, le plus bas et negatif, deviennent -280', () => {
    const resultat = calculerFinDeBoule(
      boule({ scoresCumules: { j1: -80, j2: 450, j3: 700, j4: 650 } }),
    );

    expect(resultat.bonusVictoire['j1']).toBe(-200);
    expect(resultat.scoresFinaux['j1']).toBe(-280);
  });

  it('calcule les ecarts entre chaque paire de joueurs sur les scores finaux', () => {
    const resultat = calculerFinDeBoule(
      boule({ scoresCumules: { j1: 340, j2: 450, j3: 700, j4: 650 } }),
    );

    // j1 finit a 240 : les autres lui doivent leur ecart.
    expect(resultat.ecarts['j1']).toEqual({ j2: 210, j3: 460, j4: 410 });
    // La matrice est antisymetrique.
    expect(resultat.ecarts['j2']?.['j1']).toBe(-210);
    expect(resultat.ecarts['j3']?.['j4']).toBe(-50);
    expect(resultat.ecarts['j1']?.['j1']).toBeUndefined();
  });

  it('applique -100 points par croix, apres le bonus de victoire', () => {
    const resultat = calculerFinDeBoule(
      boule({
        scoresCumules: { j1: 340, j2: 450, j3: 700, j4: 650 },
        croix: { j1: 1, j2: 2 },
      }),
    );

    expect(resultat.penalitesCroix).toEqual({ j1: -100, j2: -200, j3: 0, j4: 0 });
    // j1 : 340 - 100 (victoire) - 100 (croix) = 140 ; j2 : 450 - 200 = 250.
    expect(resultat.scoresFinaux).toEqual({ j1: 140, j2: 250, j3: 700, j4: 650 });
  });

  it('les croix ne changent pas le gagnant de la Boule', () => {
    // j2 accumule assez de croix pour finir sous j1, mais le bonus de victoire
    // se decide sur les scores cumules, avant les croix.
    const resultat = calculerFinDeBoule(
      boule({ scoresCumules: { j1: 340, j2: 450 }, croix: { j2: 5 } }),
    );

    expect(resultat.gagnantsIds).toEqual(['j1']);
    expect(resultat.bonusVictoire).toEqual({ j1: -100, j2: 0 });
    expect(resultat.scoresFinaux).toEqual({ j1: 240, j2: -50 });
  });

  it('accorde le bonus a chaque joueur a egalite au score le plus bas', () => {
    const resultat = calculerFinDeBoule(boule({ scoresCumules: { j1: 200, j2: 200, j3: 400 } }));
    expect(resultat.gagnantsIds).toEqual(['j1', 'j2']);
    expect(resultat.scoresFinaux).toEqual({ j1: 100, j2: 100, j3: 400 });
  });

  it('traite un score de zero comme non negatif', () => {
    const resultat = calculerFinDeBoule(boule({ scoresCumules: { j1: 0, j2: 400 } }));
    expect(resultat.bonusVictoire['j1']).toBe(-100);
  });

  it('refuse une Boule sans joueur', () => {
    expect(() => calculerFinDeBoule(boule())).toThrow();
  });
});
