import { describe, expect, it } from 'vitest';
import { jouerTour, recupererJoker } from '../game-engine/tour.js';
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

  it('refuse de piocher au talon epuise', () => {
    const main = [c('pique', 4)];
    const depart = coupJouable(main, { pioche: [] });
    expect(() =>
      jouerTour(depart, 'j1', { source: 'pioche', carteDefausseeId: main[0]!.id }),
    ).toThrow(/pioche/i);
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
