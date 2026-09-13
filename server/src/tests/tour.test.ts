import { describe, expect, it } from 'vitest';
import { detecterDoubleOuTriple } from '../game-engine/fin-de-coup.js';
import { echangerJoker, jouerTour, recupererJoker } from '../game-engine/tour.js';
import { verifierFinDeCoupSpeciale } from '../game-engine/pose.js';
import { c, coup, ensemble, joker, jokerPour, recap, tierce } from './fixtures.js';
import type { Carte, Combinaison } from '../models/index.js';

/**
 * Réf. docs/REGLES.md § « Déroulement d'un tour de jeu », § « Règle spéciale :
 * piocher la carte de la défausse », § « Récupération d'un joker posé » et
 * § « Fin de coup automatique sans les conditions normales ».
 */

const troisValets = () => [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')];
const suiteCoeur = () => [c('coeur', 7), c('coeur', 8), c('coeur', 9)];

/** Un coup en cours où j1 joue, avec `main` en main et `pioche` au talon. */
const coupJouable = (main: Carte[], partiel: Parameters<typeof coup>[0] = {}) =>
  coup({
    mains: { j1: main, j2: [], j3: [] },
    pioche: [c('carreau', 2), c('carreau', 3)],
    recapitulatifs: {
      j1: recap({ toursAvecPose: [] }),
      j2: recap({ toursAvecPose: [] }),
      j3: recap({ toursAvecPose: [] }),
    },
    ...partiel,
  });

describe('jouerTour — piocher et défausser', () => {
  it('pioche au talon puis defausse, et passe la main au joueur suivant', () => {
    const main = [c('pique', 4)];
    const depart = coupJouable(main);
    const { coup: apres, coupTermine } = jouerTour(depart, 'j1', {
      source: 'pioche',
      carteDefausseeId: main[0]!.id,
    });

    expect(apres.mains['j1']).toHaveLength(1);
    expect(apres.pioche).toHaveLength(1);
    expect(apres.defausse.at(-1)?.id).toBe(main[0]!.id);
    expect(apres.joueurActifId).toBe('j2');
    expect(coupTermine).toBe(false);
  });

  it('refuse de jouer hors de son tour', () => {
    const depart = coupJouable([c('pique', 4)]);
    expect(() => jouerTour(depart, 'j2', { source: 'pioche', carteDefausseeId: 'x' })).toThrow();
  });

  it('refuse de jouer hors de la phase de jeu', () => {
    const depart = coupJouable([c('pique', 4)], { phase: 'annonces' });
    expect(() => jouerTour(depart, 'j1', { source: 'pioche', carteDefausseeId: 'x' })).toThrow();
  });

  it('refuse de piocher dans une defausse vide : le premier joueur doit piocher', () => {
    const depart = coupJouable([c('pique', 4)]);
    expect(() =>
      jouerTour(depart, 'j1', { source: 'defausse', carteDefausseeId: 'x' }),
    ).toThrow(/defausse/i);
  });

  it('reforme un talon avec la defausse quand la pioche est epuisee', () => {
    // § « on remelange toutes les cartes de la defausse SAUF la derniere carte
    // visible, qui reste la defausse courante ».
    const enfouies = [c('trefle', 2), c('trefle', 3), c('trefle', 4)];
    const visible = c('trefle', 5);
    const main = [c('pique', 4)];
    const depart = coupJouable(main, { pioche: [], defausse: [...enfouies, visible] });

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'pioche',
      carteDefausseeId: main[0]!.id,
    });

    // 3 cartes enfouies remelangees, moins celle qui vient d etre piochee.
    expect(apres.pioche).toHaveLength(2);
    expect(apres.pioche.map((carte) => carte.id)).not.toContain(visible.id);
    // La carte visible est restee en jeu, sous la carte qui vient d etre defaussee.
    expect(apres.defausse.map((carte) => carte.id)).toEqual([visible.id, main[0]!.id]);
    // Le nouveau talon ne contient que des cartes anciennement enfouies.
    const idsEnfouis = enfouies.map((carte) => carte.id);
    expect(apres.pioche.every((carte) => idsEnfouis.includes(carte.id))).toBe(true);
    // La carte piochee vient bien du nouveau talon, et la main reste complete.
    expect(apres.mains['j1']).toHaveLength(1);
    expect(idsEnfouis).toContain(apres.mains['j1']![0]!.id);
  });

  it('refuse de piocher quand le talon et la defausse sont epuises', () => {
    const main = [c('pique', 4)];
    const depart = coupJouable(main, { pioche: [], defausse: [c('trefle', 5)] });
    expect(() =>
      jouerTour(depart, 'j1', { source: 'pioche', carteDefausseeId: main[0]!.id }),
    ).toThrow(/epuis/i);
  });

  it('refuse de defausser une carte absente de la main', () => {
    const depart = coupJouable([c('pique', 4)]);
    expect(() =>
      jouerTour(depart, 'j1', { source: 'pioche', carteDefausseeId: 'carte-inconnue' }),
    ).toThrow();
  });

  it('avance le numero de tour quand la table a fait un tour complet', () => {
    const main = [c('pique', 4)];
    const depart = coupJouable(main, { joueurActifId: 'j3', mains: { j1: [], j2: [], j3: main } });
    const { coup: apres } = jouerTour(depart, 'j3', {
      source: 'pioche',
      carteDefausseeId: main[0]!.id,
    });

    expect(apres.joueurActifId).toBe('j1');
    expect(apres.numeroTour).toBe(2);
  });
});

describe('jouerTour — première pose', () => {
  it('accepte une premiere pose a 54 points avec tierce pure', () => {
    const valets = troisValets();
    const suite = suiteCoeur();
    const main = [...valets, ...suite, c('pique', 2)];
    const depart = coupJouable(main);

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'pioche',
      poses: [ensemble('V', valets), tierce('coeur', suite)],
      carteDefausseeId: main[6]!.id,
    });

    expect(apres.combinaisons).toHaveLength(2);
    expect(apres.combinaisons.every((comb) => comb.proprietaireId === 'j1')).toBe(true);
    expect(apres.recapitulatifs['j1']?.toursAvecPose).toEqual([1]);
    // 7 cartes en main, +1 piochee, -6 posees, -1 defaussee.
    expect(apres.mains['j1']).toHaveLength(1);
  });

  it('refuse une premiere pose sous 51 points', () => {
    const valets = troisValets();
    const suite = [c('coeur', 5), c('coeur', 6), c('coeur', 7)];
    const main = [...valets, ...suite, c('pique', 2)];
    const depart = coupJouable(main);

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        poses: [ensemble('V', valets), tierce('coeur', suite)],
        carteDefausseeId: main[6]!.id,
      }),
    ).toThrow(/51|pose/i);
  });

  it('refuse d ajouter sur une combinaison existante sans avoir pose', () => {
    const suiteTable = tierce('coeur', suiteCoeur(), 'j2');
    const dix = c('coeur', 10);
    const main = [dix, c('pique', 2)];
    const depart = coupJouable(main, { combinaisons: [suiteTable] });

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        ajouts: [{ combinaisonId: suiteTable.id, cartes: [{ carte: dix, remplace: null }] }],
        carteDefausseeId: main[1]!.id,
      }),
    ).toThrow(/pose/i);
  });

  it('enregistre l ajout sur la combinaison d un autre joueur', () => {
    const suiteTable = tierce('coeur', suiteCoeur(), 'j2');
    const dix = c('coeur', 10);
    const main = [dix, c('pique', 2)];
    const depart = coupJouable(main, {
      combinaisons: [suiteTable],
      recapitulatifs: {
        j1: recap({ toursAvecPose: [1] }),
        j2: recap({ toursAvecPose: [1] }),
        j3: recap({ toursAvecPose: [] }),
      },
    });

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'pioche',
      ajouts: [{ combinaisonId: suiteTable.id, cartes: [{ carte: dix, remplace: null }] }],
      carteDefausseeId: main[1]!.id,
    });

    expect(apres.combinaisons[0]?.cartes).toHaveLength(4);
    expect(apres.recapitulatifs['j1']?.aAjouteSurCombinaisonAutrui).toBe(true);
  });
});

describe('jouerTour — une tierce posée grandit carte par carte', () => {
  // § « Conditions pour poser » : une suite de 6 cartes ou plus ne se POSE pas
  // d'un coup, elle doit être scindée. Cette contrainte vise la pose, pas la
  // croissance : une tierce déjà sur la table s'allonge par ses extrémités,
  // un ajout à la fois, sans plafond.
  const suiteDeCinq = () =>
    tierce(
      'pique',
      [c('pique', 10), c('pique', 'V'), c('pique', 'D'), c('pique', 'R'), c('pique', 'A')],
      'j2',
    );

  const dejaPose = {
    j1: recap({ toursAvecPose: [1] }),
    j2: recap({ toursAvecPose: [1] }),
    j3: recap({ toursAvecPose: [] }),
  };

  it('accepte une sixieme carte sur une tierce de cinq deja posee', () => {
    const neufPique = c('pique', 9);
    const main = [neufPique, c('carreau', 4)];
    const visible = suiteDeCinq();
    const depart = coupJouable(main, { combinaisons: [visible], recapitulatifs: dejaPose });

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'pioche',
      ajouts: [{ combinaisonId: visible.id, cartes: [{ carte: neufPique, remplace: null }] }],
      carteDefausseeId: main[1]!.id,
    });

    expect(apres.combinaisons.find((comb) => comb.id === visible.id)?.cartes).toHaveLength(6);
  });

  it('refuse toujours de POSER six cartes d un coup', () => {
    // La contrainte de scission reste entiere sur la pose elle-meme.
    const six = [
      c('pique', 9), c('pique', 10), c('pique', 'V'),
      c('pique', 'D'), c('pique', 'R'), c('pique', 'A'),
    ];
    const main = [...six, c('carreau', 4)];
    const depart = coupJouable(main);

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        poses: [tierce('pique', six)],
        carteDefausseeId: main[6]!.id,
      }),
    ).toThrow(/pose/i);
  });

  it('refuse une carte qui ne prolonge pas la suite', () => {
    const septPique = c('pique', 7);
    const main = [septPique, c('carreau', 4)];
    const visible = suiteDeCinq();
    const depart = coupJouable(main, { combinaisons: [visible], recapitulatifs: dejaPose });

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        ajouts: [{ combinaisonId: visible.id, cartes: [{ carte: septPique, remplace: null }] }],
        carteDefausseeId: main[1]!.id,
      }),
    ).toThrow(/Ajout invalide/);
  });
});

describe('jouerTour — un brelan complété devient un carré', () => {
  // § « Conditions pour poser » : un brelan réunit la même valeur en couleurs
  // différentes, un carré en réunit quatre. Compléter un brelan par la couleur
  // manquante est donc l'exact pendant de l'allongement d'une tierce par ses
  // extrémités.
  const brelanVisible = () =>
    ensemble('V', [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')], 'j2');

  it('accepte la quatrieme couleur sur un brelan deja pose', () => {
    const valetCarreau = c('carreau', 'V');
    const suite = suiteCoeur();
    const main = [...suite, valetCarreau, c('pique', 2)];
    const visible = brelanVisible();
    // j1 a deja pose : il a le droit de completer la table.
    const depart = coupJouable(main, {
      combinaisons: [visible],
      recapitulatifs: {
        j1: recap({ toursAvecPose: [1] }),
        j2: recap({ toursAvecPose: [1] }),
        j3: recap({ toursAvecPose: [] }),
      },
    });

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'pioche',
      ajouts: [{ combinaisonId: visible.id, cartes: [{ carte: valetCarreau, remplace: null }] }],
      carteDefausseeId: main[4]!.id,
    });

    const enrichie = apres.combinaisons.find((comb) => comb.id === visible.id);
    expect(enrichie?.cartes).toHaveLength(4);
    expect(enrichie?.type).toBe('carre');
  });

  it('refuse une cinquieme carte sur un carre', () => {
    const carreVisible = ensemble(
      'V',
      [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V'), c('carreau', 'V')],
      'j2',
    );
    const cinquieme = c('pique', 'V');
    const main = [cinquieme, c('pique', 2)];
    const depart = coupJouable(main, {
      combinaisons: [carreVisible],
      recapitulatifs: {
        j1: recap({ toursAvecPose: [1] }),
        j2: recap({ toursAvecPose: [1] }),
        j3: recap({ toursAvecPose: [] }),
      },
    });

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        ajouts: [{ combinaisonId: carreVisible.id, cartes: [{ carte: cinquieme, remplace: null }] }],
        carteDefausseeId: main[1]!.id,
      }),
    ).toThrow(/Ajout invalide/);
  });

  it('refuse une couleur deja presente dans le brelan', () => {
    const secondValetPique = c('pique', 'V');
    const main = [secondValetPique, c('pique', 2)];
    const visible = brelanVisible();
    const depart = coupJouable(main, {
      combinaisons: [visible],
      recapitulatifs: {
        j1: recap({ toursAvecPose: [1] }),
        j2: recap({ toursAvecPose: [1] }),
        j3: recap({ toursAvecPose: [] }),
      },
    });

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        ajouts: [{ combinaisonId: visible.id, cartes: [{ carte: secondValetPique, remplace: null }] }],
        carteDefausseeId: main[1]!.id,
      }),
    ).toThrow(/Ajout invalide/);
  });
});

describe('jouerTour — poser et ajouter dans le même tour', () => {
  // § « Il peut poser ses propres cartes ET ajouter des cartes chez d autres
  // joueurs dans le meme tour. »
  const suitePiqueVisible = () =>
    tierce('pique', [c('pique', 4), c('pique', 5), c('pique', 6)], 'j2');

  it('autorise un ajout chez un adversaire dans le tour meme de la premiere pose', () => {
    const valets = troisValets();
    const suite = suiteCoeur();
    const septPique = c('pique', 7);
    const main = [...valets, ...suite, septPique, c('carreau', 4)];
    const visible = suitePiqueVisible();
    const depart = coupJouable(main, { combinaisons: [visible] });

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'pioche',
      // 30 + 24 = 54 points avec une tierce pure : la premiere pose est valide.
      poses: [ensemble('V', valets), tierce('coeur', suite)],
      ajouts: [{ combinaisonId: visible.id, cartes: [{ carte: septPique, remplace: null }] }],
      carteDefausseeId: main[7]!.id,
    });

    expect(apres.combinaisons.find((comb) => comb.id === visible.id)?.cartes).toHaveLength(4);
    expect(apres.recapitulatifs['j1']?.toursAvecPose).toEqual([1]);
    expect(apres.recapitulatifs['j1']?.aAjouteSurCombinaisonAutrui).toBe(true);
  });

  it('refuse toujours l ajout seul, sans pose valide dans le meme tour', () => {
    const septPique = c('pique', 7);
    const main = [septPique, c('carreau', 4)];
    const visible = suitePiqueVisible();
    const depart = coupJouable(main, { combinaisons: [visible] });

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        ajouts: [{ combinaisonId: visible.id, cartes: [{ carte: septPique, remplace: null }] }],
        carteDefausseeId: main[1]!.id,
      }),
    ).toThrow(/pose/i);
  });

  it('refuse un ajout qui ferait boucler une suite autour de l as', () => {
    const suiteHaute = tierce(
      'pique',
      [c('pique', 'D'), c('pique', 'R'), c('pique', 'A')],
      'j2',
    );
    const deuxPique = c('pique', 2);
    const main = [deuxPique, c('carreau', 4)];
    const depart = coupJouable(main, {
      combinaisons: [suiteHaute],
      recapitulatifs: { j1: recap({ toursAvecPose: [1] }) },
    });

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        ajouts: [{ combinaisonId: suiteHaute.id, cartes: [{ carte: deuxPique, remplace: null }] }],
        carteDefausseeId: main[1]!.id,
      }),
    ).toThrow(/ajout invalide/i);
  });

  it('accepte le valet en prolongement d une suite D-R-A', () => {
    const suiteHaute = tierce(
      'pique',
      [c('pique', 'D'), c('pique', 'R'), c('pique', 'A')],
      'j2',
    );
    const valetPique = c('pique', 'V');
    const main = [valetPique, c('carreau', 4)];
    const depart = coupJouable(main, {
      combinaisons: [suiteHaute],
      recapitulatifs: { j1: recap({ toursAvecPose: [1] }) },
    });

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'pioche',
      ajouts: [{ combinaisonId: suiteHaute.id, cartes: [{ carte: valetPique, remplace: null }] }],
      carteDefausseeId: main[1]!.id,
    });

    expect(apres.combinaisons[0]?.cartes).toHaveLength(4);
  });
});

describe('jouerTour — double et triple', () => {
  const suitePiqueVisible = () =>
    tierce('pique', [c('pique', 4), c('pique', 5), c('pique', 6)], 'j2');

  it('est un triple quand tout est pose en un tour, sans aucun joker ni aide', () => {
    const valets = troisValets();
    const suite = suiteCoeur();
    const main = [...valets, ...suite];
    const depart = coupJouable(main);

    const { coup: apres, coupTermine } = jouerTour(depart, 'j1', {
      source: 'pioche',
      poses: [ensemble('V', valets), tierce('coeur', suite)],
      carteDefausseeId: depart.pioche[0]!.id,
    });

    expect(coupTermine).toBe(true);
    expect(apres.recapitulatifs['j1']?.toursAvecPose).toEqual([1]);
    expect(apres.recapitulatifs['j1']?.aAjouteSurCombinaisonAutrui).toBe(false);
    expect(detecterDoubleOuTriple(apres, 'j1')).toBe('triple');
  });

  it('retombe a double si un joker normal figure dans ses combinaisons', () => {
    // Le joker est dans le brelan, pas dans la tierce : la premiere pose reste
    // valide (24 + 30 = 54 avec une tierce pure), mais le triple est perdu.
    const jokerValet = joker();
    const valets = [c('pique', 'V'), c('trefle', 'V'), jokerValet];
    const suite = suiteCoeur();
    const main = [...valets, ...suite];
    const depart = coupJouable(main);

    const { coup: apres, coupTermine } = jouerTour(depart, 'j1', {
      source: 'pioche',
      poses: [ensemble('V', valets), tierce('coeur', suite)],
      carteDefausseeId: depart.pioche[0]!.id,
    });

    expect(coupTermine).toBe(true);
    expect(detecterDoubleOuTriple(apres, 'j1')).toBe('double');
  });

  it('retombe a simple si le joueur a ajoute chez un adversaire dans ce meme tour', () => {
    // Cas discriminant : tout est pose en un seul tour, mais une carte est
    // partie chez un adversaire — le double est perdu malgre le tour unique.
    const valets = troisValets();
    const suite = suiteCoeur();
    const septPique = c('pique', 7);
    const main = [...valets, ...suite, septPique];
    const visible = suitePiqueVisible();
    const depart = coupJouable(main, { combinaisons: [visible] });

    const { coup: apres, coupTermine } = jouerTour(depart, 'j1', {
      source: 'pioche',
      poses: [ensemble('V', valets), tierce('coeur', suite)],
      ajouts: [{ combinaisonId: visible.id, cartes: [{ carte: septPique, remplace: null }] }],
      carteDefausseeId: depart.pioche[0]!.id,
    });

    expect(coupTermine).toBe(true);
    expect(apres.recapitulatifs['j1']?.toursAvecPose).toEqual([1]);
    expect(detecterDoubleOuTriple(apres, 'j1')).toBe('simple');
  });

  it('garde la marque de l aide recue seize tours apres l ajout chez un adversaire', () => {
    const valets = troisValets();
    const suite = suiteCoeur();
    const septPique = c('pique', 7);
    const trois = [c('pique', 3), c('coeur', 3), c('trefle', 3)];
    const main = [...valets, ...suite, septPique, ...trois];
    const visible = suitePiqueVisible();
    const depart = coupJouable(main, { combinaisons: [visible] });

    // Tour 1 : premiere pose a 54 points, et une carte donnee a la suite de j2.
    const { coup: apresPose } = jouerTour(depart, 'j1', {
      source: 'pioche',
      poses: [ensemble('V', valets), tierce('coeur', suite)],
      ajouts: [{ combinaisonId: visible.id, cartes: [{ carte: septPique, remplace: null }] }],
      carteDefausseeId: depart.pioche[0]!.id,
    });
    expect(apresPose.recapitulatifs['j1']?.aAjouteSurCombinaisonAutrui).toBe(true);
    expect(apresPose.mains['j1']).toHaveLength(3);

    // Seize tours passent, puis j1 finit sa main tout seul, sans rien devoir
    // a personne a ce moment precis.
    const bienPlusTard = {
      ...apresPose,
      joueurActifId: 'j1',
      numeroTour: 17,
      pioche: [c('carreau', 8)],
    };
    const { coup: apresFin, coupTermine } = jouerTour(bienPlusTard, 'j1', {
      source: 'pioche',
      poses: [ensemble(3, trois)],
      carteDefausseeId: bienPlusTard.pioche[0]!.id,
    });

    expect(coupTermine).toBe(true);
    // Le drapeau pose au tour 1 survit a la fin du coup.
    expect(apresFin.recapitulatifs['j1']?.aAjouteSurCombinaisonAutrui).toBe(true);
    expect(detecterDoubleOuTriple(apresFin, 'j1')).toBe('simple');
  });
});

describe('jouerTour — pioche en défausse', () => {
  const quinteMoinsUne = () => [c('coeur', 10), c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R')];

  it('refuse la carte de la defausse si elle n est pas utilisee immediatement', () => {
    const main = [c('pique', 2)];
    const depart = coupJouable(main, {
      defausse: [c('trefle', 5)],
      recapitulatifs: { j1: recap({ toursAvecPose: [1] }) },
    });

    expect(() =>
      jouerTour(depart, 'j1', { source: 'defausse', carteDefausseeId: main[0]!.id }),
    ).toThrow(/immediatement|utilis/i);
  });

  it('refuse la defausse a un joueur qui n a pas pose et dont la combinaison ne fait pas 51', () => {
    const sept = c('trefle', 7);
    const main = [c('trefle', 5), c('trefle', 6), c('pique', 2)];
    const depart = coupJouable(main, { defausse: [sept] });

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'defausse',
        poses: [tierce('trefle', [main[0]!, main[1]!, sept])],
        carteDefausseeId: main[2]!.id,
      }),
    ).toThrow(/51/);
  });

  it('accepte la defausse en premiere pose quand le TOTAL des poses atteint 51', () => {
    // La carte de la defausse n'a pas a porter les 51 points a elle seule :
    // c'est la somme de ce qui est pose ensemble qui compte, comme pour toute
    // premiere pose. Ici la tierce pure coeur 10-V-D vaut 30, et le brelan de
    // rois — forme avec le roi pris a la defausse — en vaut 33 : 63 au total.
    const roiDefausse = c('trefle', 'R');
    const tiercePure = [c('coeur', 10), c('coeur', 'V'), c('coeur', 'D')];
    const deuxRois = [c('pique', 'R'), c('coeur', 'R')];
    const main = [...tiercePure, ...deuxRois, c('pique', 2)];
    const depart = coupJouable(main, { defausse: [roiDefausse] });

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'defausse',
      poses: [
        tierce('coeur', tiercePure),
        ensemble('R', [...deuxRois, roiDefausse]),
      ],
      carteDefausseeId: main[5]!.id,
    });

    expect(apres.combinaisons).toHaveLength(2);
    expect(apres.recapitulatifs['j1']?.toursAvecPose).toEqual([1]);
  });

  it('refuse quand le total des poses n atteint pas 51, meme carte de defausse utilisee', () => {
    // Tierce pure coeur 3-4-5 (12) + brelan de 2 forme avec la carte prise
    // (6) : 18 points, loin des 51.
    const deuxDefausse = c('trefle', 2);
    const tiercePure = [c('coeur', 3), c('coeur', 4), c('coeur', 5)];
    const deuxDeux = [c('pique', 2), c('coeur', 2)];
    const main = [...tiercePure, ...deuxDeux, c('pique', 9)];
    const depart = coupJouable(main, { defausse: [deuxDefausse] });

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'defausse',
        poses: [tierce('coeur', tiercePure), ensemble(2, [...deuxDeux, deuxDefausse])],
        carteDefausseeId: main[5]!.id,
      }),
    ).toThrow(/51/);
  });

  it('accepte la defausse en premiere pose si la combinaison formee atteint 51 points', () => {
    // La quinte flush royale vaut exactement 51 points.
    const as = c('coeur', 'A');
    const main = [...quinteMoinsUne(), c('pique', 2)];
    const depart = coupJouable(main, { defausse: [as] });

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'defausse',
      poses: [tierce('coeur', [...quinteMoinsUne().map((_, i) => main[i]!), as])],
      carteDefausseeId: main[4]!.id,
    });

    expect(apres.combinaisons).toHaveLength(1);
    expect(apres.defausse.at(-1)?.id).toBe(main[4]!.id);
  });

  it('refuse une carte « collante » : le 5 face a une suite 6-7-8-9 posee', () => {
    // § « cette carte est dite collante et NE PEUT PAS etre piochee ».
    const suiteTable = tierce(
      'coeur',
      [c('coeur', 6), c('coeur', 7), c('coeur', 8), c('coeur', 9)],
      'j2',
    );
    const cinq = c('coeur', 5);
    const main = [c('coeur', 3), c('coeur', 4), c('pique', 2)];
    const depart = coupJouable(main, {
      combinaisons: [suiteTable],
      defausse: [cinq],
      recapitulatifs: { j1: recap({ toursAvecPose: [1] }) },
    });

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'defausse',
        poses: [tierce('coeur', [main[0]!, main[1]!, cinq])],
        carteDefausseeId: main[2]!.id,
      }),
    ).toThrow(/collante/i);
  });

  it('accepte une carte « sous-collante » : le 5 face a une suite 7-8-9 posee', () => {
    // § « c est autorise » : la suite posee n est pas touchee.
    const suiteTable = tierce('coeur', suiteCoeur(), 'j2');
    const cinq = c('coeur', 5);
    const main = [c('coeur', 3), c('coeur', 4), c('pique', 2)];
    const depart = coupJouable(main, {
      combinaisons: [suiteTable],
      defausse: [cinq],
      recapitulatifs: { j1: recap({ toursAvecPose: [1] }) },
    });

    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'defausse',
      poses: [tierce('coeur', [main[0]!, main[1]!, cinq])],
      carteDefausseeId: main[2]!.id,
    });

    expect(apres.combinaisons).toHaveLength(2);
  });
});

describe('jouerTour — fin de coup', () => {
  it('termine le coup quand la main est vide apres la defausse', () => {
    const valets = troisValets();
    const suite = suiteCoeur();
    const main = [...valets, ...suite];
    const depart = coupJouable(main);

    const { coup: apres, coupTermine } = jouerTour(depart, 'j1', {
      source: 'pioche',
      poses: [ensemble('V', valets), tierce('coeur', suite)],
      // La carte piochee au talon est la seule a defausser.
      carteDefausseeId: depart.pioche[0]!.id,
    });

    expect(coupTermine).toBe(true);
    expect(apres.mains['j1']).toHaveLength(0);
    expect(apres.gagnantId).toBe('j1');
    expect(apres.phase).toBe('termine');
  });
});

describe('jouerTour — fin de coup automatique sans les conditions normales', () => {
  it('accepte de poser les 14 cartes d un coup sans 51 points ni tierce pure', () => {
    // 4 brelans (42 points, aucune tierce) + 2 cartes ajoutees a une suite
    // deja visible = 14 cartes posees. La pose ordinaire serait refusee.
    const brelans = [
      [c('pique', 2), c('coeur', 2), c('trefle', 2)],
      [c('pique', 3), c('coeur', 3), c('trefle', 3)],
      [c('pique', 4), c('coeur', 4), c('trefle', 4)],
      [c('pique', 5), c('coeur', 5), c('trefle', 5)],
    ];
    const prolongement = [c('carreau', 9), c('carreau', 10)];
    const main = [...brelans.flat(), ...prolongement];
    const suiteVisible = tierce(
      'carreau',
      [c('carreau', 6), c('carreau', 7), c('carreau', 8)],
      'j2',
    );
    const depart = coupJouable(main, { combinaisons: [suiteVisible] });

    const { coup: apres, coupTermine } = jouerTour(depart, 'j1', {
      source: 'pioche',
      poses: [
        ensemble(2, brelans[0]!),
        ensemble(3, brelans[1]!),
        ensemble(4, brelans[2]!),
        ensemble(5, brelans[3]!),
      ],
      ajouts: [
        {
          combinaisonId: suiteVisible.id,
          cartes: prolongement.map((carte) => ({ carte, remplace: null })),
        },
      ],
      carteDefausseeId: depart.pioche[0]!.id,
    });

    expect(coupTermine).toBe(true);
    expect(apres.gagnantId).toBe('j1');
    expect(apres.mains['j1']).toHaveLength(0);
  });

  it('refuse la meme pose s il reste une carte de trop en main', () => {
    const brelans = [
      [c('pique', 2), c('coeur', 2), c('trefle', 2)],
      [c('pique', 3), c('coeur', 3), c('trefle', 3)],
      [c('pique', 4), c('coeur', 4), c('trefle', 4)],
      [c('pique', 5), c('coeur', 5), c('trefle', 5)],
    ];
    // 13 cartes seulement : la fin de coup speciale ne s applique pas et les
    // 42 points des brelans ne suffisent pas a une premiere pose ordinaire.
    const main = [...brelans.flat(), c('carreau', 9)];
    const depart = coupJouable(main);

    expect(() =>
      jouerTour(depart, 'j1', {
        source: 'pioche',
        poses: [
          ensemble(2, brelans[0]!),
          ensemble(3, brelans[1]!),
          ensemble(4, brelans[2]!),
          ensemble(5, brelans[3]!),
        ],
        carteDefausseeId: main[12]!.id,
      }),
    ).toThrow(/51/);
  });
});

describe('verifierFinDeCoupSpeciale', () => {
  // § « poser la TOTALITE de ses 14 cartes d un seul coup, puis defausser la
  // 15eme carte qu il vient de piocher ».
  const quatorzeCartes = (): Carte[] => [
    ...troisValets(),
    ...suiteCoeur(),
    c('pique', 2),
    c('coeur', 2),
    c('trefle', 2),
    c('pique', 5),
    c('pique', 6),
    c('pique', 7),
    c('carreau', 9),
    c('carreau', 10),
  ];

  const posesCompletes = (main: Carte[]): Combinaison[] => [
    ensemble('V', main.slice(0, 3)),
    tierce('coeur', main.slice(3, 6)),
    ensemble(2, main.slice(6, 9)),
    tierce('pique', main.slice(9, 12)),
  ];

  it('accepte 14 cartes posees d un coup, meme sans 51 points ni tierce pure requise', () => {
    const main = quatorzeCartes();
    const quinzieme = c('trefle', 8);
    const poses = posesCompletes(main);
    // Les 2 dernieres cartes de la main rejoignent une suite deja visible.
    const suiteVisible = tierce(
      'carreau',
      [c('carreau', 6), c('carreau', 7), c('carreau', 8)],
      'j2',
    );
    const prolongee = tierce('carreau', [
      ...suiteVisible.cartes,
      { carte: main[12]!, remplace: null },
      { carte: main[13]!, remplace: null },
    ]);

    expect(verifierFinDeCoupSpeciale([...main, quinzieme], [...poses, prolongee])).toBe(true);
  });

  it('refuse s il reste plus d une carte en main', () => {
    const main = quatorzeCartes();
    const quinzieme = c('trefle', 8);
    expect(verifierFinDeCoupSpeciale([...main, quinzieme], posesCompletes(main))).toBe(false);
  });

  it('refuse si une combinaison proposee est invalide', () => {
    const main = quatorzeCartes();
    const quinzieme = c('trefle', 8);
    const poses = posesCompletes(main);
    poses[1] = tierce('coeur', [main[3]!, main[4]!, c('coeur', 'R')]);
    expect(verifierFinDeCoupSpeciale([...main, quinzieme], poses)).toBe(false);
  });

  it('refuse si la main ne compte pas 15 cartes', () => {
    const main = quatorzeCartes();
    expect(verifierFinDeCoupSpeciale(main, posesCompletes(main))).toBe(false);
  });
});

describe('recupererJoker', () => {
  // § « Recuperation d un joker pose » : 5-trefle, joker, 7-trefle, ou le joker
  // remplace le 6 de trefle.
  const combinaisonAvecJoker = (proprietaire = 'j2') => {
    const jokerPosee = jokerPour('trefle', 6);
    return {
      jokerPosee,
      combinaison: tierce('trefle', [c('trefle', 5), jokerPosee, c('trefle', 7)], proprietaire),
    };
  };

  const coupAvecJoker = (mainJ1: Carte[], aPose: number[], proprietaire = 'j2') => {
    const { jokerPosee, combinaison } = combinaisonAvecJoker(proprietaire);
    return {
      jokerPosee,
      combinaison,
      depart: coupJouable(mainJ1, {
        combinaisons: [combinaison],
        recapitulatifs: { j1: recap({ toursAvecPose: aPose }) },
      }),
    };
  };

  it('echange la vraie carte contre le joker, qui repart dans une combinaison de la main', () => {
    const sixTrefle = c('trefle', 6);
    const paire = [c('pique', 8), c('coeur', 8)];
    const { jokerPosee, combinaison, depart } = coupAvecJoker([sixTrefle, ...paire], [1]);

    const replacement = ensemble(8, [...paire, jokerPosee.carte], 'j1');
    const { coup: apres } = recupererJoker(
      depart,
      'j1',
      sixTrefle,
      { combinaisonId: combinaison.id, carteJokerId: jokerPosee.carte.id },
      replacement,
    );

    // Le joker a quitte la tierce, remplace par le vrai 6 de trefle.
    const tierceApres = apres.combinaisons.find((comb) => comb.id === combinaison.id);
    expect(tierceApres?.cartes.map((cp) => cp.carte.id)).toContain(sixTrefle.id);
    expect(tierceApres?.cartes.some((cp) => cp.carte.type === 'joker')).toBe(false);
    // Le joker est immediatement repose dans le brelan de 8.
    expect(apres.combinaisons).toHaveLength(2);
    expect(apres.mains['j1']).toHaveLength(0);
  });

  it('refuse si le joueur n a pas encore pose son jeu', () => {
    const sixTrefle = c('trefle', 6);
    const paire = [c('pique', 8), c('coeur', 8)];
    const { jokerPosee, combinaison, depart } = coupAvecJoker([sixTrefle, ...paire], []);

    expect(() =>
      recupererJoker(
        depart,
        'j1',
        sixTrefle,
        { combinaisonId: combinaison.id, carteJokerId: jokerPosee.carte.id },
        ensemble(8, [...paire, jokerPosee.carte], 'j1'),
      ),
    ).toThrow(/pose/i);
  });

  it('refuse une carte qui ne correspond pas a celle que le joker represente', () => {
    const sixCoeur = c('coeur', 6);
    const paire = [c('pique', 8), c('coeur', 8)];
    const { jokerPosee, combinaison, depart } = coupAvecJoker([sixCoeur, ...paire], [1]);

    expect(() =>
      recupererJoker(
        depart,
        'j1',
        sixCoeur,
        { combinaisonId: combinaison.id, carteJokerId: jokerPosee.carte.id },
        ensemble(8, [...paire, jokerPosee.carte], 'j1'),
      ),
    ).toThrow(/represente|remplace/i);
  });

  it('refuse si le joker recupere n est pas immediatement replace', () => {
    const sixTrefle = c('trefle', 6);
    const { jokerPosee, combinaison, depart } = coupAvecJoker([sixTrefle], [1]);

    expect(() =>
      recupererJoker(
        depart,
        'j1',
        sixTrefle,
        { combinaisonId: combinaison.id, carteJokerId: jokerPosee.carte.id },
        null,
      ),
    ).toThrow(/replac/i);
  });

  it('refuse un replacement qui ne contient pas le joker recupere', () => {
    const sixTrefle = c('trefle', 6);
    const paire = [c('pique', 8), c('coeur', 8)];
    const { jokerPosee, combinaison, depart } = coupAvecJoker([sixTrefle, ...paire], [1]);

    expect(() =>
      recupererJoker(
        depart,
        'j1',
        sixTrefle,
        { combinaisonId: combinaison.id, carteJokerId: jokerPosee.carte.id },
        ensemble(8, [...paire, joker()], 'j1'),
      ),
    ).toThrow(/joker/i);
  });

  it('refuse un replacement invalide', () => {
    const sixTrefle = c('trefle', 6);
    const depareillees = [c('pique', 8), c('coeur', 3)];
    const { jokerPosee, combinaison, depart } = coupAvecJoker([sixTrefle, ...depareillees], [1]);

    expect(() =>
      recupererJoker(
        depart,
        'j1',
        sixTrefle,
        { combinaisonId: combinaison.id, carteJokerId: jokerPosee.carte.id },
        ensemble(8, [...depareillees, jokerPosee.carte], 'j1'),
      ),
    ).toThrow();
  });

  it('permet de recuperer un joker que le joueur a pose lui-meme', () => {
    const sixTrefle = c('trefle', 6);
    const paire = [c('pique', 8), c('coeur', 8)];
    const { jokerPosee, combinaison, depart } = coupAvecJoker([sixTrefle, ...paire], [1], 'j1');

    const { coup: apres } = recupererJoker(
      depart,
      'j1',
      sixTrefle,
      { combinaisonId: combinaison.id, carteJokerId: jokerPosee.carte.id },
      ensemble(8, [...paire, jokerPosee.carte], 'j1'),
    );

    expect(apres.combinaisons).toHaveLength(2);
  });
});

describe('echangerJoker — un echange sans replacement immediat', () => {
  // § « Récupération d'un joker posé » : le joker repris doit être replacé au
  // même tour, mais pas forcément dans la même action.
  const table = () => {
    const joker = jokerPour('coeur', 'V');
    const tierceAvecJoker = tierce('coeur', [c('coeur', 10), joker, c('coeur', 'D')], 'j2');
    return { joker: joker.carte, tierceAvecJoker };
  };
  const dejaPose = {
    j1: recap({ toursAvecPose: [1] }),
    j2: recap({ toursAvecPose: [1] }),
    j3: recap({ toursAvecPose: [] }),
  };

  it('prend la vraie carte dans la main et y met le joker', () => {
    const { joker, tierceAvecJoker } = table();
    const vraiValet = c('coeur', 'V');
    const main = [vraiValet, c('pique', 2)];
    const depart = coupJouable(main, { combinaisons: [tierceAvecJoker], recapitulatifs: dejaPose });

    const { coup: apres, joker: repris } = echangerJoker(depart, 'j1', vraiValet, {
      combinaisonId: tierceAvecJoker.id,
      carteJokerId: joker.id,
    });

    expect(repris.id).toBe(joker.id);
    expect(apres.combinaisons[0]?.cartes.map((cp) => cp.carte.id)).toContain(vraiValet.id);
    expect(apres.combinaisons[0]?.cartes.map((cp) => cp.carte.id)).not.toContain(joker.id);
    expect(apres.mains['j1']?.map((carte) => carte.id)).toEqual([main[1]?.id, joker.id]);
  });

  it('prend la carte piochee au talon, et met le joker la ou le moteur la piochera', () => {
    const { joker, tierceAvecJoker } = table();
    const vraiValet = c('coeur', 'V');
    const depart = coupJouable([c('pique', 2)], {
      combinaisons: [tierceAvecJoker],
      recapitulatifs: dejaPose,
      pioche: [vraiValet, c('carreau', 3)],
    });

    const { coup: apres } = echangerJoker(
      depart, 'j1', vraiValet,
      { combinaisonId: tierceAvecJoker.id, carteJokerId: joker.id },
      { carte: vraiValet, source: 'pioche' },
    );

    expect(apres.pioche[0]?.id).toBe(joker.id);
    expect(apres.combinaisons[0]?.cartes.map((cp) => cp.carte.id)).toContain(vraiValet.id);
  });

  it('prend la carte prise a la defausse, et met le joker a son sommet', () => {
    const { joker, tierceAvecJoker } = table();
    const vraiValet = c('coeur', 'V');
    const depart = coupJouable([c('pique', 2)], {
      combinaisons: [tierceAvecJoker],
      recapitulatifs: dejaPose,
      defausse: [c('trefle', 4), vraiValet],
    });

    const { coup: apres } = echangerJoker(
      depart, 'j1', vraiValet,
      { combinaisonId: tierceAvecJoker.id, carteJokerId: joker.id },
      { carte: vraiValet, source: 'defausse' },
    );

    expect(apres.defausse.at(-1)?.id).toBe(joker.id);
    expect(apres.defausse).toHaveLength(2);
  });

  it('le joker mis a la place de la carte piochee se pose normalement au tour', () => {
    const { joker, tierceAvecJoker } = table();
    const vraiValet = c('coeur', 'V');
    const valets = [c('pique', 'V'), c('trefle', 'V')];
    const aJeter = c('pique', 2);
    const depart = coupJouable([...valets, aJeter], {
      combinaisons: [tierceAvecJoker],
      recapitulatifs: dejaPose,
      pioche: [vraiValet, c('carreau', 3)],
    });

    const { coup: avecEchange } = echangerJoker(
      depart, 'j1', vraiValet,
      { combinaisonId: tierceAvecJoker.id, carteJokerId: joker.id },
      { carte: vraiValet, source: 'pioche' },
    );
    const { coup: apres } = jouerTour(avecEchange, 'j1', {
      source: 'pioche',
      poses: [ensemble('V', [...valets, { carte: joker, remplace: { couleur: 'carreau', valeur: 'V' } }])],
      carteDefausseeId: aJeter.id,
    });

    expect(apres.combinaisons).toHaveLength(2);
    expect(apres.mains['j1']).toHaveLength(0);
    // Pas de doublon : la vraie carte n'est qu'une fois sur la table.
    const toutes = apres.combinaisons.flatMap((comb) => comb.cartes.map((cp) => cp.carte.id));
    expect(toutes.filter((id) => id === vraiValet.id)).toHaveLength(1);
  });

  it('refuse un joueur qui n a pas encore pose', () => {
    const { joker, tierceAvecJoker } = table();
    const vraiValet = c('coeur', 'V');
    const depart = coupJouable([vraiValet], { combinaisons: [tierceAvecJoker] });

    expect(() =>
      echangerJoker(depart, 'j1', vraiValet, { combinaisonId: tierceAvecJoker.id, carteJokerId: joker.id }),
    ).toThrow(/pose/);
  });

  it('refuse une carte qui n est pas celle que le joker represente', () => {
    const { joker, tierceAvecJoker } = table();
    const valetPique = c('pique', 'V');
    const depart = coupJouable([valetPique], { combinaisons: [tierceAvecJoker], recapitulatifs: dejaPose });

    expect(() =>
      echangerJoker(depart, 'j1', valetPique, { combinaisonId: tierceAvecJoker.id, carteJokerId: joker.id }),
    ).toThrow(/represente/);
  });
});
