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
  reportDeFriches,
  initialiserBoule as initialiserLaBoule,
  surplusDeCoupsFriches,
} from '../game-engine/boule.js';
import { calculerFinDeBoule } from '../game-engine/fin-de-boule.js';
import { joueur } from './fixtures.js';
import type { Boule, JoueurId, ScoreCoup } from '../models/index.js';

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

const quatreJoueurs = () => ['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id));

describe('nombre de coups choisi a la creation', () => {
  it('remplace celui des regles, et borne toujours les coups friches', () => {
    const quatre = ['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id));
    expect(initialiserLaBoule(quatre, 2).nombreCoupsTotal).toBe(8);
    expect(initialiserLaBoule(quatre, 2, 5).nombreCoupsTotal).toBe(5);
    expect(initialiserLaBoule(quatre, 12, 12).nombreCoupsFriches).toBe(12);
    expect(() => initialiserLaBoule(quatre, 6, 5)).toThrow(/coups friches hors limites/);
  });
});

describe('coups friches et report, friche generalisee par friche generalisee', () => {
  // Réf. docs/REGLES.md § « Structure d'une Boule » : Boule de 8 coups, 2 frichés.
  const jouerLesCoups = (depart: Boule, jusquAvant: number): Boule => {
    let boule = depart;
    for (let numero = boule.historique.length + 1; numero < jusquAvant; numero += 1) {
      boule = enregistrerResultatCoup(boule, numero, score());
    }
    return boule;
  };
  const friches = (depart: Boule, numero: number, nombre: number): Boule => {
    let boule = depart;
    for (let friche = 0; friche < nombre; friche += 1) {
      boule = enregistrerFricheGeneralisee(boule, numero, { toutLeMondeAFriche: true });
    }
    return boule;
  };
  const coupsFriches = (boule: Boule): number[] =>
    Array.from({ length: boule.nombreCoupsTotal }, (_, index) => index + 1).filter((numero) =>
      estCoupFriche(boule, numero),
    );

  it('exemple 1 : deux friches au coup 3, K passe de 2 a 4, coups 5 a 8 friches, aucun report', () => {
    const boule = friches(jouerLesCoups(initialiserLaBoule(quatreJoueurs(), 2), 3), 3, 2);
    expect(boule.nombreCoupsFriches).toBe(4);
    expect(coupsFriches(boule)).toEqual([5, 6, 7, 8]);
    expect(estCoupFriche(boule, 3)).toBe(false);
    expect(estCoupFriche(boule, 4)).toBe(false);
    expect(boule.reportDeFriches).toBe(0);
  });

  it('exemple 2 : trois friches au coup 5, seule la troisieme depasse les 4 coups restants : report 1', () => {
    let boule = jouerLesCoups(initialiserLaBoule(quatreJoueurs(), 2), 5);
    boule = friches(boule, 5, 1);
    expect(boule.nombreCoupsFriches).toBe(3);
    boule = friches(boule, 5, 1);
    expect(boule.nombreCoupsFriches).toBe(4);
    expect(boule.reportDeFriches).toBe(0);
    boule = friches(boule, 5, 1);
    expect(boule.nombreCoupsFriches).toBe(4);
    expect(coupsFriches(boule)).toEqual([5, 6, 7, 8]);
    expect(boule.reportDeFriches).toBe(1);
  });

  it('exemple 3 : une nouvelle friche au coup 6, 5 voulus pour 3 coups restants : le report passe a 3', () => {
    let boule = friches(jouerLesCoups(initialiserLaBoule(quatreJoueurs(), 2), 5), 5, 3);
    boule = friches(jouerLesCoups(boule, 6), 6, 1);
    expect(boule.nombreCoupsFriches).toBe(3);
    expect(coupsFriches(boule).filter((numero) => numero >= 6)).toEqual([6, 7, 8]);
    expect(boule.reportDeFriches).toBe(3);
  });

  it('report de 6, Boule suivante d un seul coup : 8 voulus, 1 coup friche, 7 pour celle d apres', () => {
    const a = { ...initialiserLaBoule(quatreJoueurs(), 2), reportDeFriches: 6 };
    const versB = reportDeFriches(a, { coupsFrichesConfigures: 2, coupsDeLaSuivante: 1 });
    expect(versB).toEqual({ coupsFrichesDepart: 1, excedent: 7 });

    const b = enregistrerResultatCoup(initialiserLaBoule(quatreJoueurs(), versB.coupsFrichesDepart, 1, versB.excedent), 1, score());
    expect(estCoupFriche(b, 1)).toBe(true);
    expect(reportDeFriches(b, { coupsFrichesConfigures: 2, coupsDeLaSuivante: 8 })).toEqual({ coupsFrichesDepart: 8, excedent: 1 });
  });

  it('chaine de deux Rejouer : le report de B vaut (2 + R_A + G) - M, et C herite exactement de lui', () => {
    // A : 8 coups, base 2, les friches des exemples 2 et 3 → R_A = 3.
    let a = friches(jouerLesCoups(initialiserLaBoule(quatreJoueurs(), 2), 5), 5, 3);
    a = jouerLesCoups(friches(jouerLesCoups(a, 6), 6, 1), 9);
    expect(estBouleTerminee(a)).toBe(true);
    const reportA = a.reportDeFriches ?? 0;
    expect(reportA).toBe(3);

    // B, premier Rejouer : 4 coups. 2 + 3 = 5 voulus : entièrement frichée, 1 d'avance.
    const coupsB = 4;
    const versB = reportDeFriches(a, { coupsFrichesConfigures: 2, coupsDeLaSuivante: coupsB });
    expect(versB).toEqual({ coupsFrichesDepart: 4, excedent: 1 });
    let b = initialiserLaBoule(quatreJoueurs(), versB.coupsFrichesDepart, coupsB, versB.excedent);
    // G = 2 friches généralisées au coup 1, puis au coup 3 une troisième.
    b = friches(b, 1, 2);
    b = friches(jouerLesCoups(b, 3), 3, 1);
    b = jouerLesCoups(b, coupsB + 1);
    expect(estBouleTerminee(b)).toBe(true);
    // Au coup 3, 5 voulus pour 2 coups restants : l'écart est de 3.
    expect(b.reportDeFriches).toBe(1 + 1 + 1 + 3);
    // Sur les deux friches du coup 1 — celles qui saturent dès le départ — la
    // formule (2 + R_A + G) - M se retrouve exactement.
    const bSeul = friches(initialiserLaBoule(quatreJoueurs(), versB.coupsFrichesDepart, coupsB, versB.excedent), 1, 2);
    expect(bSeul.reportDeFriches).toBe(2 + reportA + 2 - coupsB);

    // C, deuxième Rejouer depuis B : son report hérité est exactement celui de B.
    const versC = reportDeFriches(b, { coupsFrichesConfigures: 2, coupsDeLaSuivante: 8 });
    expect(versC).toEqual({ coupsFrichesDepart: 8, excedent: 2 + 6 - 8 });
    const c = initialiserLaBoule(quatreJoueurs(), versC.coupsFrichesDepart, 8, versC.excedent);
    expect(c.nombreCoupsFriches).toBe(8);
    expect(c.reportDeFriches).toBe(0);
  });

  it('report de 6 et Boule de 8 coups frichee de bout en bout : 5 friches au coup 1 donnent 5 de report', () => {
    const a = { ...initialiserLaBoule(quatreJoueurs(), 2), reportDeFriches: 6 };
    const versB = reportDeFriches(a, { coupsFrichesConfigures: 2, coupsDeLaSuivante: 8 });
    let b = initialiserLaBoule(quatreJoueurs(), versB.coupsFrichesDepart, 8, versB.excedent);
    expect(b.nombreCoupsFriches).toBe(8);
    b = friches(b, 1, 5);
    // (2 + 6 + 5) - 8 : chaque friche tardive fait croître le report.
    expect(b.reportDeFriches).toBe(5);
  });
});

describe('Boules enregistrees avant le suivi du report', () => {
  it('lit encore une Boule enregistree avant le decompte, par difference avec le depart', () => {
    const { frichesGeneralisees: _oublie, reportDeFriches: _aussi, ...ancienne } = {
      ...initialiserLaBoule(['j1', 'j2', 'j3', 'j4'].map((id) => joueur(id)), 2),
      nombreCoupsFriches: 5,
    };
    expect(surplusDeCoupsFriches(ancienne, 2)).toBe(3);
    expect(
      reportDeFriches(ancienne, { coupsFrichesConfigures: 2, coupsFrichesDepart: 2, excedentRecu: 0, coupsDeLaSuivante: 8 }),
    ).toEqual({ coupsFrichesDepart: 5, excedent: 0 });
  });
});
