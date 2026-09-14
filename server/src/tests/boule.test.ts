import { describe, expect, it } from 'vitest';
import {
  determinerJoueursAssis,
  enregistrerResultatCoup,
  estBouleTerminee,
  estCoupFriche,
  initialiserBoule,
  numeroCoupCourant,
} from '../game-engine/boule.js';
import { enregistrerResultatCoup as enregistrerFricheGeneralisee } from '../game-engine/boule.js';
import {
  coupsFrichesPourLaSuivante,
  initialiserBoule as initialiserLaBoule,
  surplusDeCoupsFriches,
} from '../game-engine/boule.js';
import { calculerFinDeBoule } from '../game-engine/fin-de-boule.js';
import { joueur } from './fixtures.js';
import type { JoueurId, ScoreCoup } from '../models/index.js';

/** Réf. docs/REGLES.md § « Structure d'une Boule » et § « Joueurs et matériel ». */

const table = (...ids: JoueurId[]) => ids.map((id) => joueur(id));

const score = (partiel: Partial<ScoreCoup> = {}): ScoreCoup => ({
  gagnantId: 'j1',
  typeVictoire: 'simple',
  estFriche: false,
  multiplicateur: 1,
  scores: {},
  croixGagnees: {},
  chocolatId: null,
  ...partiel,
});

describe('initialiserBoule', () => {
  it('fixe le nombre de coups selon le nombre de joueurs', () => {
    expect(initialiserBoule(table('j1', 'j2')).nombreCoupsTotal).toBe(8);
    expect(initialiserBoule(table('j1', 'j2', 'j3')).nombreCoupsTotal).toBe(9);
    expect(initialiserBoule(table('j1', 'j2', 'j3', 'j4')).nombreCoupsTotal).toBe(8);
    expect(initialiserBoule(table('j1', 'j2', 'j3', 'j4', 'j5')).nombreCoupsTotal).toBe(10);
    expect(initialiserBoule(table('j1', 'j2', 'j3', 'j4', 'j5', 'j6')).nombreCoupsTotal).toBe(12);
  });

  it('met tous les scores et toutes les croix a zero', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3'));
    expect(boule.scoresCumules).toEqual({ j1: 0, j2: 0, j3: 0 });
    expect(boule.croix).toEqual({ j1: 0, j2: 0, j3: 0 });
    expect(boule.historique).toEqual([]);
    expect(boule.ordreTable).toEqual(['j1', 'j2', 'j3']);
  });

  it('friche 2 coups d office par defaut, et accepte un autre nombre', () => {
    expect(initialiserBoule(table('j1', 'j2', 'j3', 'j4')).nombreCoupsFriches).toBe(2);
    expect(initialiserBoule(table('j1', 'j2', 'j3', 'j4'), 3).nombreCoupsFriches).toBe(3);
    expect(initialiserBoule(table('j1', 'j2', 'j3', 'j4'), 0).nombreCoupsFriches).toBe(0);
  });

  it('refuse une table dont le nombre de coups n est pas defini par les regles', () => {
    expect(() => initialiserBoule(table('j1'))).toThrow();
    expect(() => initialiserBoule(table('j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7'))).toThrow();
  });

  it('refuse plus de coups friches que de coups', () => {
    expect(() => initialiserBoule(table('j1', 'j2', 'j3', 'j4'), 9)).toThrow();
    expect(() => initialiserBoule(table('j1', 'j2', 'j3', 'j4'), -1)).toThrow();
  });
});

describe('Boule a 2 joueurs', () => {
  const deux = () => initialiserBoule(table('j1', 'j2'));

  it('compte 8 coups, comme a 4 joueurs', () => {
    expect(deux().nombreCoupsTotal).toBe(8);
    expect(deux().nombreCoupsTotal).toBe(initialiserBoule(table('j1', 'j2', 'j3', 'j4')).nombreCoupsTotal);
  });

  it('ne met personne sur le cote : les deux joueurs jouent chaque coup', () => {
    const boule = deux();
    for (let numeroCoup = 1; numeroCoup <= 8; numeroCoup += 1) {
      const composition = determinerJoueursAssis(boule, numeroCoup);
      expect(composition.joueursAssis).toEqual([]);
      expect(composition.joueursActifs).toHaveLength(2);
    }
  });

  it('fait alterner le donneur d un coup a l autre', () => {
    const boule = deux();
    expect(determinerJoueursAssis(boule, 1).donneurId).toBe('j1');
    expect(determinerJoueursAssis(boule, 2).donneurId).toBe('j2');
    expect(determinerJoueursAssis(boule, 3).donneurId).toBe('j1');
  });

  it('ouvre l ordre de jeu par celui qui ne donne pas', () => {
    const boule = deux();
    expect(determinerJoueursAssis(boule, 1).joueursActifs).toEqual(['j2', 'j1']);
    expect(determinerJoueursAssis(boule, 2).joueursActifs).toEqual(['j1', 'j2']);
  });

  it('friche les 2 derniers coups, et suit les friches generalisees', () => {
    let boule = deux();
    expect(estCoupFriche(boule, 6)).toBe(false);
    expect(estCoupFriche(boule, 7)).toBe(true);

    boule = enregistrerResultatCoup(boule, 1, { toutLeMondeAFriche: true });
    expect(boule.nombreCoupsTotal).toBe(8);
    expect(boule.nombreCoupsFriches).toBe(3);
    expect(estCoupFriche(boule, 6)).toBe(true);
  });

  it('se termine au bout de ses 8 coups', () => {
    let boule = deux();
    for (let numeroCoup = 1; numeroCoup <= 7; numeroCoup += 1) {
      boule = enregistrerResultatCoup(boule, numeroCoup, score({ scores: { j1: 10, j2: -20 } }));
    }
    expect(estBouleTerminee(boule)).toBe(false);

    boule = enregistrerResultatCoup(boule, 8, score({ scores: { j1: 10, j2: -20 } }));
    expect(estBouleTerminee(boule)).toBe(true);
    expect(boule.scoresCumules).toEqual({ j1: 80, j2: -160 });
  });
});

describe('determinerJoueursAssis', () => {
  it('ne met personne sur le cote a 3 ou 4 joueurs', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'));
    const coup1 = determinerJoueursAssis(boule, 1);
    expect(coup1.joueursAssis).toEqual([]);
    expect(coup1.joueursActifs).toHaveLength(4);
  });

  it('fait tourner le donneur d un siege a chaque coup', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'));
    expect(determinerJoueursAssis(boule, 1).donneurId).toBe('j1');
    expect(determinerJoueursAssis(boule, 2).donneurId).toBe('j2');
    expect(determinerJoueursAssis(boule, 5).donneurId).toBe('j1');
  });

  it('ouvre l ordre de jeu par le joueur a la gauche du donneur', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'));
    expect(determinerJoueursAssis(boule, 1).joueursActifs).toEqual(['j2', 'j3', 'j4', 'j1']);
    expect(determinerJoueursAssis(boule, 2).joueursActifs).toEqual(['j3', 'j4', 'j1', 'j2']);
  });

  it('met 2 joueurs sur le cote a 5 joueurs', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4', 'j5'));
    const coup1 = determinerJoueursAssis(boule, 1);
    expect(coup1.joueursAssis).toHaveLength(2);
    expect(coup1.joueursActifs).toHaveLength(3);
  });

  it('met 2 joueurs sur le cote a 6 joueurs', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4', 'j5', 'j6'));
    const coup1 = determinerJoueursAssis(boule, 1);
    expect(coup1.joueursAssis).toHaveLength(2);
    expect(coup1.joueursActifs).toHaveLength(4);
  });

  it('remplace systematiquement le donneur du coup precedent sur le cote', () => {
    // § « la rotation des joueurs assis se fait dans l ordre, en remplacant
    // systematiquement le donneur du coup precedent ».
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4', 'j5'));
    for (const numeroCoup of [2, 3, 4, 5, 6]) {
      const precedent = determinerJoueursAssis(boule, numeroCoup - 1);
      const courant = determinerJoueursAssis(boule, numeroCoup);
      expect(courant.joueursAssis).toContain(precedent.donneurId);
    }
  });

  it('fait revenir en jeu le joueur reste le plus longtemps sur le cote', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4', 'j5'));
    const coup1 = determinerJoueursAssis(boule, 1);
    const coup2 = determinerJoueursAssis(boule, 2);

    // Un seul des deux joueurs sur le cote au coup 1 y reste au coup 2.
    const restes = coup1.joueursAssis.filter((id) => coup2.joueursAssis.includes(id));
    expect(restes).toHaveLength(1);
    // L autre est revenu en jeu.
    const revenus = coup1.joueursAssis.filter((id) => coup2.joueursActifs.includes(id));
    expect(revenus).toHaveLength(1);
  });

  it('ne fait jamais donner un joueur mis sur le cote', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4', 'j5', 'j6'));
    for (let numeroCoup = 1; numeroCoup <= 12; numeroCoup += 1) {
      const { donneurId, joueursAssis, joueursActifs } = determinerJoueursAssis(boule, numeroCoup);
      expect(joueursAssis).not.toContain(donneurId);
      expect(joueursActifs).toContain(donneurId);
    }
  });

  it('refuse un numero de coup hors de la Boule', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3'));
    expect(() => determinerJoueursAssis(boule, 0)).toThrow();
  });
});

describe('estCoupFriche', () => {
  it('friche les 2 derniers coups d une Boule de 8', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'));
    expect(estCoupFriche(boule, 6)).toBe(false);
    expect(estCoupFriche(boule, 7)).toBe(true);
    expect(estCoupFriche(boule, 8)).toBe(true);
  });

  it('ne friche aucun coup quand le nombre de coups friches est nul', () => {
    const boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'), 0);
    expect(estCoupFriche(boule, 8)).toBe(false);
  });
});

describe('enregistrerResultatCoup', () => {
  const bouleA4 = () => initialiserBoule(table('j1', 'j2', 'j3', 'j4'));

  it('cumule les scores et les croix, et archive le coup', () => {
    const apres = enregistrerResultatCoup(
      bouleA4(),
      1,
      score({ scores: { j1: -20, j2: 30, j3: 100, j4: 40 }, croixGagnees: { j1: 2 } }),
    );

    expect(apres.scoresCumules).toEqual({ j1: -20, j2: 30, j3: 100, j4: 40 });
    expect(apres.croix).toEqual({ j1: 2, j2: 0, j3: 0, j4: 0 });
    expect(apres.historique).toHaveLength(1);
    expect(apres.historique[0]?.numero).toBe(1);
  });

  it('additionne les coups successifs', () => {
    const apres1 = enregistrerResultatCoup(bouleA4(), 1, score({ scores: { j1: -20, j2: 30 } }));
    const apres2 = enregistrerResultatCoup(apres1, 2, score({ scores: { j1: 40, j2: -20 } }));

    expect(apres2.scoresCumules['j1']).toBe(20);
    expect(apres2.scoresCumules['j2']).toBe(10);
    expect(apres2.historique).toHaveLength(2);
  });

  it('refuse un coup enregistre hors de son rang', () => {
    expect(() => enregistrerResultatCoup(bouleA4(), 2, score())).toThrow();
  });

  it('exemple des regles : 4 joueurs, 8 coups, 2 friches, une friche generalisee', () => {
    // § « la Boule reste a 8 coups et on passe a 3 coups friches en partant de
    // la fin ».
    const apres = enregistrerResultatCoup(bouleA4(), 1, { toutLeMondeAFriche: true });

    expect(apres.nombreCoupsTotal).toBe(8);
    expect(apres.nombreCoupsFriches).toBe(3);
    // Les 3 derniers coups des 8 sont desormais friches.
    expect(estCoupFriche(apres, 5)).toBe(false);
    expect(estCoupFriche(apres, 6)).toBe(true);
    expect(estCoupFriche(apres, 7)).toBe(true);
    expect(estCoupFriche(apres, 8)).toBe(true);
  });

  it('ne fait ni avancer le coup ni bouger les scores lors d une friche generalisee', () => {
    const apres = enregistrerResultatCoup(bouleA4(), 1, { toutLeMondeAFriche: true });

    expect(apres.historique).toEqual([]);
    expect(apres.scoresCumules).toEqual({ j1: 0, j2: 0, j3: 0, j4: 0 });
    // Le coup 1 est rejoue : c est toujours lui qu on attend.
    expect(() => enregistrerResultatCoup(apres, 2, score())).toThrow();
  });

  it('friche un coup de plus a chaque friche generalisee, sans jamais allonger la Boule', () => {
    const une = enregistrerResultatCoup(bouleA4(), 1, { toutLeMondeAFriche: true });
    const deux = enregistrerResultatCoup(une, 1, { toutLeMondeAFriche: true });

    expect(deux.nombreCoupsTotal).toBe(8);
    expect(deux.nombreCoupsFriches).toBe(4);
    expect(estCoupFriche(deux, 4)).toBe(false);
    expect(estCoupFriche(deux, 5)).toBe(true);
    expect(estCoupFriche(deux, 8)).toBe(true);
  });

  it('ne friche jamais plus de coups que la Boule n en compte', () => {
    let boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'), 7);
    boule = enregistrerResultatCoup(boule, 1, { toutLeMondeAFriche: true });
    expect(boule.nombreCoupsFriches).toBe(8);
    boule = enregistrerResultatCoup(boule, 1, { toutLeMondeAFriche: true });
    expect(boule.nombreCoupsFriches).toBe(8);
    expect(estCoupFriche(boule, 1)).toBe(true);
  });
});

describe('donneur et friche generalisee', () => {
  it('garde le meme donneur sur un coup rejoue, puis avance une fois le coup joue', () => {
    // § « ce coup est rejoue a la meme place, avec le MEME donneur ».
    let boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'));
    expect(numeroCoupCourant(boule)).toBe(1);
    const donneurAvant = determinerJoueursAssis(boule, numeroCoupCourant(boule)).donneurId;
    expect(donneurAvant).toBe('j1');

    // Tout le monde friche : le coup 1 est rejoue, meme donneur.
    boule = enregistrerResultatCoup(boule, numeroCoupCourant(boule), { toutLeMondeAFriche: true });
    expect(numeroCoupCourant(boule)).toBe(1);
    expect(determinerJoueursAssis(boule, numeroCoupCourant(boule)).donneurId).toBe('j1');

    // Deuxieme friche generalisee : toujours le meme donneur.
    boule = enregistrerResultatCoup(boule, numeroCoupCourant(boule), { toutLeMondeAFriche: true });
    expect(determinerJoueursAssis(boule, numeroCoupCourant(boule)).donneurId).toBe('j1');

    // Le coup est enfin joue : le donneur avance d un siege.
    boule = enregistrerResultatCoup(boule, numeroCoupCourant(boule), score({ scores: { j1: 10 } }));
    expect(numeroCoupCourant(boule)).toBe(2);
    expect(determinerJoueursAssis(boule, numeroCoupCourant(boule)).donneurId).toBe('j2');
  });

  it('ne fausse pas la rotation des joueurs sur le cote a 5 joueurs', () => {
    let boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4', 'j5'));
    const avant = determinerJoueursAssis(boule, numeroCoupCourant(boule));

    boule = enregistrerResultatCoup(boule, numeroCoupCourant(boule), { toutLeMondeAFriche: true });
    const pendantRejeu = determinerJoueursAssis(boule, numeroCoupCourant(boule));

    // Le rejeu ne bouge ni le donneur ni la composition de la table.
    expect(pendantRejeu).toEqual(avant);

    boule = enregistrerResultatCoup(boule, numeroCoupCourant(boule), score({ scores: { j1: 10 } }));
    const suivant = determinerJoueursAssis(boule, numeroCoupCourant(boule));

    // Le donneur maintenu en place n est compte qu une fois : il part sur le
    // cote au coup suivant, comme apres n importe quel coup joue.
    expect(suivant.joueursAssis).toContain(avant.donneurId);
    expect(suivant.joueursAssis).toHaveLength(2);
    expect(new Set(suivant.joueursAssis).size).toBe(2);
  });
});

describe('estBouleTerminee', () => {
  const jouerCoups = (nombre: number) => {
    let boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'));
    for (let numeroCoup = 1; numeroCoup <= nombre; numeroCoup += 1) {
      boule = enregistrerResultatCoup(boule, numeroCoup, score({ scores: { j1: 10 } }));
    }
    return boule;
  };

  it('est fausse tant que tous les coups ne sont pas joues', () => {
    expect(estBouleTerminee(jouerCoups(7))).toBe(false);
  });

  it('est vraie quand les 8 coups sont joues', () => {
    expect(estBouleTerminee(jouerCoups(8))).toBe(true);
  });

  it('reste a 8 coups malgre une friche generalisee', () => {
    let boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'));
    boule = enregistrerResultatCoup(boule, 1, { toutLeMondeAFriche: true });
    for (let numeroCoup = 1; numeroCoup <= 7; numeroCoup += 1) {
      boule = enregistrerResultatCoup(boule, numeroCoup, score({ scores: { j1: 10 } }));
    }

    expect(estBouleTerminee(boule)).toBe(false);
    boule = enregistrerResultatCoup(boule, 8, score({ scores: { j1: 10 } }));
    expect(estBouleTerminee(boule)).toBe(true);
    expect(boule.historique).toHaveLength(8);
  });
});

describe('articulation avec calculerFinDeBoule', () => {
  it('cloture une Boule entiere a partir des scores cumules et des croix', () => {
    let boule = initialiserBoule(table('j1', 'j2', 'j3', 'j4'));

    // Coup 1 : j1 gagne et decroche 2 croix.
    boule = enregistrerResultatCoup(
      boule,
      1,
      score({ scores: { j1: -20, j2: 200, j3: 300, j4: 250 }, croixGagnees: { j1: 2 } }),
    );
    // Coup 2 : j1 encaisse, les autres aussi.
    boule = enregistrerResultatCoup(
      boule,
      2,
      score({ gagnantId: 'j2', scores: { j1: 360, j2: -20, j3: 400, j4: 400 } }),
    );

    expect(boule.scoresCumules).toEqual({ j1: 340, j2: 180, j3: 700, j4: 650 });
    expect(boule.croix['j1']).toBe(2);

    const resultat = calculerFinDeBoule(boule);
    // j2 a le score cumule le plus bas et gagne la Boule.
    expect(resultat.gagnantsIds).toEqual(['j2']);
    expect(resultat.scoresFinaux['j2']).toBe(80);
    // Les 2 croix de j1 valent -200, appliques apres le bonus de victoire.
    expect(resultat.scoresFinaux['j1']).toBe(140);
  });
});

describe('report des coups friches sur la Boule rejouee', () => {
  it('ajoute aux 2 par defaut le surplus des friches generalisees : 2 au depart, 5 a la fin, la suivante a 5', () => {
    const finie = { ...initialiserLaBoule(['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id))), nombreCoupsFriches: 5, frichesGeneralisees: 3 };
    expect(surplusDeCoupsFriches(finie, 2)).toBe(3);
    expect(coupsFrichesPourLaSuivante(finie, 2, 8)).toBe(5);
  });

  it('repart a 2 sans friche generalisee, meme d un depart choisi plus haut ou plus bas', () => {
    const sansFriche = { ...initialiserLaBoule(['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id))), nombreCoupsFriches: 6 };
    expect(surplusDeCoupsFriches(sansFriche, 6)).toBe(0);
    expect(coupsFrichesPourLaSuivante(sansFriche, 6, 8)).toBe(2);
    const departZero = { ...initialiserLaBoule(['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id)), 0), nombreCoupsFriches: 0 };
    expect(coupsFrichesPourLaSuivante(departZero, 0, 8)).toBe(2);
  });

  it('ne depasse jamais le nombre de coups de la nouvelle Boule', () => {
    const toutFriche = { ...initialiserLaBoule(['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id)), 0), nombreCoupsFriches: 8, frichesGeneralisees: 8 };
    expect(coupsFrichesPourLaSuivante(toutFriche, 0, 8)).toBe(8);
  });
});

describe('surplus de coups friches quand tous les coups deviennent friches', () => {
  it('Boule a 4 joueurs, 8 coups, 2 au depart, 8 a la fin : 6 en plus, et la suivante plafonnee a 8', () => {
    let finie = initialiserLaBoule(['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id)), 2);
    expect(finie.nombreCoupsTotal).toBe(8);
    // Six friches generalisees, toutes au premier coup rejoue.
    for (let friche = 0; friche < 6; friche += 1) {
      finie = enregistrerFricheGeneralisee(finie, 1, { toutLeMondeAFriche: true });
    }
    expect(finie.nombreCoupsFriches).toBe(8);
    expect(surplusDeCoupsFriches(finie, 2)).toBe(6);
    expect(coupsFrichesPourLaSuivante(finie, 2, 8)).toBe(8);

    // Une septieme ne depasse pas le nombre de coups, mais elle compte : le
    // surplus passe a 7.
    finie = enregistrerFricheGeneralisee(finie, 1, { toutLeMondeAFriche: true });
    expect(finie.nombreCoupsFriches).toBe(8);
    expect(surplusDeCoupsFriches(finie, 2)).toBe(7);
  });
});

describe('nombre de coups choisi a la creation', () => {
  it('remplace celui des regles, et borne toujours les coups friches', () => {
    const quatre = ['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id));
    expect(initialiserLaBoule(quatre, 2).nombreCoupsTotal).toBe(8);
    expect(initialiserLaBoule(quatre, 2, 5).nombreCoupsTotal).toBe(5);
    expect(initialiserLaBoule(quatre, 12, 12).nombreCoupsFriches).toBe(12);
    expect(() => initialiserLaBoule(quatre, 6, 5)).toThrow(/coups friches hors limites/);
  });
});

describe('surplus de coups friches au-dela du plafond', () => {
  it('Boule de 2 coups, 2 friches au depart, 5 friches generalisees : 5 en plus, pas 0', () => {
    let boule = initialiserLaBoule(['j1', 'j2'].map((id) => joueur(id)), 2, 2);
    for (let friche = 0; friche < 5; friche += 1) {
      boule = enregistrerFricheGeneralisee(boule, 1, { toutLeMondeAFriche: true });
    }
    // Le compteur de coups friches reste au nombre de coups...
    expect(boule.nombreCoupsFriches).toBe(2);
    // ... mais les cinq friches generalisees comptent toutes.
    expect(boule.frichesGeneralisees).toBe(5);
    expect(surplusDeCoupsFriches(boule, 2)).toBe(5);
    expect(coupsFrichesPourLaSuivante(boule, 2, 8)).toBe(7);
  });

  it('lit encore une Boule enregistree avant le decompte, par difference avec le depart', () => {
    const { frichesGeneralisees: _oublie, ...ancienne } = {
      ...initialiserLaBoule(['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id)), 2),
      nombreCoupsFriches: 5,
    };
    expect(surplusDeCoupsFriches(ancienne, 2)).toBe(3);
  });
});

