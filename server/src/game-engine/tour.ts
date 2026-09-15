/**
 * Orchestration d'un tour de jeu.
 *
 * Réf. `docs/REGLES.md` § « Déroulement d'un tour de jeu » : le joueur pioche
 * (au talon ou la dernière carte de la défausse), peut poser, puis défausse.
 * Voir aussi § « Règle spéciale : piocher la carte de la défausse » et
 * § « Récupération d'un joker posé ».
 */
import { estCarteCollante } from './defausse.js';
import type {
  Carte,
  CarteId,
  CartePosee,
  Combinaison,
  CombinaisonId,
  Coup,
  JoueurId,
} from '../models/index.js';
import { estJoker } from './cartes.js';
import { croixALaPose } from './croix.js';
import {
  estCombinaisonProlongeeValide,
  estCombinaisonValide,
  verifierDeclarationsJokers,
} from './combinaisons.js';
import { peutPoser, SEUIL_POSE, verifierFinDeCoupSpeciale } from './pose.js';
import { melangerPaquet } from './distribution.js';

/** Cartes ajoutées à une combinaison déjà visible. */
export interface AjoutCombinaison {
  readonly combinaisonId: CombinaisonId;
  readonly cartes: readonly CartePosee[];
}

export interface ActionTour {
  /** Talon, ou dernière carte de la défausse. */
  readonly source: 'pioche' | 'defausse';
  /** Nouvelles combinaisons posées, formées avec des cartes de la main. */
  readonly poses?: readonly Combinaison[];
  /** Cartes ajoutées aux combinaisons déjà sur la table, la sienne ou celle d'un autre. */
  readonly ajouts?: readonly AjoutCombinaison[];
  readonly carteDefausseeId: CarteId;
  /**
   * Jokers repris sur la table ce tour-ci, rangés dans la main avant la pose.
   * Réf. docs/REGLES.md § « Récupération d'un joker posé » : ils ne servent
   * pas à ouvrir.
   */
  readonly jokersRecuperes?: readonly CarteId[];
}

export interface NouvelEtatCoup {
  readonly coup: Coup;
  /** Le joueur n'a plus de cartes : le coup s'arrête (§ « Fin d'un coup »). */
  readonly coupTermine: boolean;
}

export interface JokerCible {
  readonly combinaisonId: CombinaisonId;
  readonly carteJokerId: CarteId;
}

/**
 * Reforme un talon quand la pioche est épuisée.
 *
 * § « on remélange toutes les cartes de la défausse SAUF la dernière carte
 * visible, qui reste la défausse courante ».
 */
export const reformerTalon = (
  pioche: readonly Carte[],
  defausse: readonly Carte[],
  alea: () => number = Math.random,
): { pioche: Carte[]; defausse: Carte[] } => {
  if (pioche.length > 0) return { pioche: [...pioche], defausse: [...defausse] };

  const sommet = defausse.at(-1);
  const enfouies = defausse.slice(0, -1);
  if (sommet === undefined || enfouies.length === 0) {
    throw new Error('Plus aucune carte a piocher : talon et defausse sont epuises');
  }
  return { pioche: melangerPaquet(enfouies, alea), defausse: [sommet] };
};

const aDejaPose = (coup: Coup, joueurId: JoueurId): boolean =>
  (coup.recapitulatifs[joueurId]?.toursAvecPose.length ?? 0) > 0;

/**
 * La même combinaison, avec d'autres cartes.
 *
 * Un ensemble change de nom en grandissant : le brelan complété par sa
 * quatrième couleur devient un carré. Garder « brelan » le rendrait invalide
 * pour la seule raison qu'il a grandi — `estEnsembleValide` compte trois
 * cartes pour un brelan, quatre pour un carré — et refuserait un ajout que les
 * règles autorisent (§ « Conditions pour poser »). Au-delà de quatre, aucun
 * nom ne convient et la combinaison est jugée invalide, ce qui est voulu.
 */
const avecCartes = (combinaison: Combinaison, cartes: readonly CartePosee[]): Combinaison =>
  combinaison.type === 'tierce'
    ? { ...combinaison, cartes }
    : { ...combinaison, type: cartes.length >= 4 ? 'carre' : 'brelan', cartes };

/**
 * Les poses privées des jokers repris ce tour-ci : chaque combinaison perd ces
 * jokers, et disparaît si elle n'est plus valide sans eux.
 */
const sansJokersRecuperes = (
  poses: readonly Combinaison[],
  jokers: ReadonlySet<CarteId>,
): Combinaison[] =>
  poses.flatMap((combinaison) => {
    if (!combinaison.cartes.some((cp) => jokers.has(cp.carte.id))) return [combinaison];
    const reduite = avecCartes(
      combinaison,
      combinaison.cartes.filter((cp) => !jokers.has(cp.carte.id)),
    );
    return estCombinaisonValide(reduite) ? [reduite] : [];
  });

/**
 * La première pose tient-elle sans les jokers tout juste repris ?
 *
 * Réf. docs/REGLES.md § « Récupération d'un joker posé ». Un joker repris se
 * place où l'on veut quand la pose remplit déjà seule les deux conditions ; il
 * ne peut pas être ce qui les remplit. Symétrique de la carte prise en
 * défausse, qui sert ailleurs mais pas à l'échange qu'elle compléterait.
 */
const ouvreSansJokersRecuperes = (
  main: readonly Carte[],
  poses: readonly Combinaison[],
  jokersRecuperes: readonly CarteId[],
): boolean => {
  const jokers = new Set(jokersRecuperes);
  if (!poses.some((combinaison) => combinaison.cartes.some((cp) => jokers.has(cp.carte.id)))) return true;
  try {
    return peutPoser(main, sansJokersRecuperes(poses, jokers));
  } catch {
    // Une lecture devenue ambiguë sans le joker ne vaut pas pose.
    return false;
  }
};

/** Le moteur signe lui-même les combinaisons posées : ni propriétaire ni tour ne sont déclarés. */
const attribuer = (combinaison: Combinaison, proprietaireId: JoueurId, tourDePose: number): Combinaison =>
  combinaison.type === 'tierce'
    ? { ...combinaison, proprietaireId, tourDePose }
    : { ...combinaison, proprietaireId, tourDePose };

/**
 * Joue un tour complet : pioche, pose éventuelle, défausse.
 *
 * @param alea source d'aléa utilisée pour reformer le talon quand la pioche
 * s'épuise ; injectable pour rendre le remélange reproductible en test.
 */
export const jouerTour = (
  coup: Coup,
  joueurActifId: JoueurId,
  action: ActionTour,
  alea: () => number = Math.random,
): NouvelEtatCoup => {
  if (coup.phase !== 'jeu') {
    throw new Error(`Le coup n'est pas en phase de jeu (phase : ${coup.phase})`);
  }
  if (coup.joueurActifId !== joueurActifId) {
    throw new Error(`Ce n'est pas au tour de ${joueurActifId} mais de ${coup.joueurActifId}`);
  }

  const poses = action.poses ?? [];
  const ajouts = action.ajouts ?? [];
  verifierDeclarationsJokers(poses);

  // --- Pioche -------------------------------------------------------------
  const pioche = [...coup.pioche];
  const defausse = [...coup.defausse];
  let cartePiochee: Carte;

  if (action.source === 'pioche') {
    if (pioche.length === 0) {
      const talon = reformerTalon(pioche, defausse, alea);
      pioche.push(...talon.pioche);
      defausse.length = 0;
      defausse.push(...talon.defausse);
    }
    cartePiochee = pioche.shift() as Carte;
  } else {
    // Réf. docs/REGLES.md § « Règle spéciale : piocher la carte de la
    // défausse » : qui a déjà posé et ne tient plus qu'une carte pioche au talon.
    if (aDejaPose(coup, joueurActifId) && (coup.mains[joueurActifId] ?? []).length === 1) {
      throw new Error('Une seule carte en main apres avoir pose : la defausse ne se prend pas, piochez au talon');
    }
    if (defausse.length === 0) {
      throw new Error('Defausse vide : le premier joueur du coup doit piocher au talon');
    }
    cartePiochee = defausse.pop() as Carte;
  }

  const mainApresPioche = [...(coup.mains[joueurActifId] ?? []), cartePiochee];

  // --- Cartes engagées ----------------------------------------------------
  const enMain = new Set(mainApresPioche.map((carte) => carte.id));
  const utilisees = new Set<CarteId>();
  const engager = (carte: Carte): void => {
    if (!enMain.has(carte.id)) {
      throw new Error(`Carte ${carte.id} absente de la main de ${joueurActifId}`);
    }
    if (utilisees.has(carte.id)) {
      throw new Error(`Carte ${carte.id} engagee deux fois dans le meme tour`);
    }
    utilisees.add(carte.id);
  };

  for (const combinaison of poses) {
    for (const { carte } of combinaison.cartes) engager(carte);
  }
  for (const ajout of ajouts) {
    for (const { carte } of ajout.cartes) engager(carte);
  }

  // --- La carte prise en défausse sur la table -----------------------------
  // Réf. docs/REGLES.md § « Règle spéciale : piocher la carte de la défausse ».
  // Vérifié avant la validité des ajouts : la raison du refus est celle-ci, pas
  // l'ajout invalide qui en découlerait. Deux usages sont interdits :
  // - la poser sur un brelan ou un carré déjà posé, qu'un joker s'y trouve ou
  //   non — reprendre ce joker avec elle est refusé en amont, par `echangerJoker` ;
  // - la coller au bout d'une suite déjà posée (carte collante), la sienne
  //   comprise.
  // Une carte qui ne touche pas la suite reste permise : 6-7-8 posé, le 4
  // ramassé et le 5 de la main complètent 4-5-6-7-8.
  if (action.source === 'defausse') {
    for (const ajout of ajouts) {
      if (!ajout.cartes.some((cp) => cp.carte.id === cartePiochee.id)) continue;
      const cible = coup.combinaisons.find((combinaison) => combinaison.id === ajout.combinaisonId);
      if (cible === undefined) continue;
      if (cible.type !== 'tierce') {
        throw new Error(
          'La carte prise dans la defausse ne se pose pas sur un brelan ou un carre deja pose : elle doit servir dans une nouvelle combinaison',
        );
      }
      if (estCarteCollante(cartePiochee, cible)) {
        throw new Error(
          'Carte collante : prise dans la defausse, elle ne peut pas prolonger une suite deja posee, la votre comprise',
        );
      }
    }
  }

  // --- Combinaisons résultantes -------------------------------------------
  for (const ajout of ajouts) {
    if (!coup.combinaisons.some((combinaison) => combinaison.id === ajout.combinaisonId)) {
      throw new Error(`Combinaison ${ajout.combinaisonId} introuvable sur la table`);
    }
  }

  const combinaisonsMisesAJour = coup.combinaisons.map((combinaison) => {
    const ajout = ajouts.find((candidat) => candidat.combinaisonId === combinaison.id);
    if (ajout === undefined) return combinaison;

    const enrichie = avecCartes(combinaison, [...combinaison.cartes, ...ajout.cartes]);
    // Une combinaison qui grandit n'est pas une pose : elle n'a pas de plafond.
    if (!estCombinaisonProlongeeValide(enrichie)) {
      throw new Error(`Ajout invalide sur la combinaison ${combinaison.id}`);
    }
    return enrichie;
  });

  // --- Droit de poser -----------------------------------------------------
  const dejaPose = aDejaPose(coup, joueurActifId);
  // § « Fin de coup automatique » : poser ses 14 cartes d'un coup, seul ou en
  // s'aidant des combinaisons visibles, dispense des deux conditions habituelles.
  const enrichies = combinaisonsMisesAJour.filter((combinaison) =>
    ajouts.some((ajout) => ajout.combinaisonId === combinaison.id),
  );
  const finSpeciale = verifierFinDeCoupSpeciale(mainApresPioche, [...poses, ...enrichies]);

  if (!dejaPose && !finSpeciale) {
    if (poses.length === 0 && ajouts.length > 0) {
      throw new Error(
        "Il faut avoir pose son jeu avant d'ajouter des cartes sur les combinaisons en place",
      );
    }
    if (poses.length > 0 && !peutPoser(mainApresPioche, poses)) {
      throw new Error(
        `Premiere pose invalide : il faut au moins ${String(SEUIL_POSE)} points et une tierce franche`,
      );
    }
    if (poses.length > 0 && !ouvreSansJokersRecuperes(mainApresPioche, poses, action.jokersRecuperes ?? [])) {
      throw new Error(
        `Le joker tout juste recupere ne peut pas servir a ouvrir : sans lui, votre premiere pose n atteint pas ${String(SEUIL_POSE)} points avec une tierce franche`,
      );
    }
  }

  // --- Contraintes propres à la pioche en défausse -------------------------
  if (action.source === 'defausse') {
    if (!utilisees.has(cartePiochee.id)) {
      throw new Error(
        'La carte prise dans la defausse doit etre utilisee immediatement dans une combinaison posee',
      );
    }

    // Rien de plus à vérifier ici pour une première pose : la carte prise doit
    // servir dans une combinaison posée — c'est contrôlé juste au-dessus — et
    // la pose elle-même répond aux conditions ordinaires, déjà exigées plus
    // haut par `peutPoser`. Réf. docs/REGLES.md § « Règle spéciale : piocher la
    // carte de la défausse » : ce sont les 51 points de l'ensemble posé qui
    // comptent, pas ceux de la seule combinaison qui porte cette carte.
  }

  // --- Application des poses et des ajouts --------------------------------
  const posees = poses.map((combinaison) => {
    const signee = attribuer(combinaison, joueurActifId, coup.numeroTour);
    if (!estCombinaisonValide(signee)) {
      throw new Error(`Combinaison posee invalide : ${signee.id}`);
    }
    // Réf. § « Bonus quinte flush royale » : les croix s'arrêtent ici, à la
    // pose, et nulle part ailleurs.
    return { ...signee, croix: croixALaPose(signee, poses, action.jokersRecuperes ?? []) };
  });

  // --- Défausse -----------------------------------------------------------
  const mainApresPose = mainApresPioche.filter((carte) => !utilisees.has(carte.id));
  const carteDefaussee = mainApresPose.find((carte) => carte.id === action.carteDefausseeId);
  if (carteDefaussee === undefined) {
    throw new Error(`Carte a defausser ${action.carteDefausseeId} absente de la main`);
  }
  // Réf. docs/REGLES.md § « Déroulement d'un tour de jeu » : un joker ne se
  // défausse jamais, qu'il vienne de la donne, de la pioche ou d'une reprise.
  if (estJoker(carteDefaussee)) {
    throw new Error(
      carteDefaussee.type === 'coucou'
        ? 'Le coucou ne se defausse jamais : il ne quitte la main que pour une combinaison'
        : 'Un joker ne se defausse jamais : il ne quitte la main que pour une combinaison',
    );
  }
  const mainFinale = mainApresPose.filter((carte) => carte.id !== carteDefaussee.id);
  defausse.push(carteDefaussee);

  // --- Récapitulatif, tour suivant ----------------------------------------
  const precedent = coup.recapitulatifs[joueurActifId] ?? {
    toursAvecPose: [],
    aAjouteSurCombinaisonAutrui: false,
  };
  const aPoseCeTour = posees.length > 0 || ajouts.length > 0;
  const surAutrui = ajouts.some((ajout) => {
    const cible = coup.combinaisons.find((combinaison) => combinaison.id === ajout.combinaisonId);
    return cible !== undefined && cible.proprietaireId !== joueurActifId;
  });

  const recapitulatif = {
    toursAvecPose:
      aPoseCeTour && !precedent.toursAvecPose.includes(coup.numeroTour)
        ? [...precedent.toursAvecPose, coup.numeroTour]
        : [...precedent.toursAvecPose],
    aAjouteSurCombinaisonAutrui: precedent.aAjouteSurCombinaisonAutrui || surAutrui,
  };

  const coupTermine = mainFinale.length === 0;
  const indexSuivant = (coup.ordreJoueurs.indexOf(joueurActifId) + 1) % coup.ordreJoueurs.length;
  // `ordreJoueurs[0]` joue en premier : y revenir marque un tour de table complet.
  const numeroTour = indexSuivant === 0 ? coup.numeroTour + 1 : coup.numeroTour;

  return {
    coup: {
      ...coup,
      mains: { ...coup.mains, [joueurActifId]: mainFinale },
      pioche,
      defausse,
      combinaisons: [...combinaisonsMisesAJour, ...posees],
      recapitulatifs: { ...coup.recapitulatifs, [joueurActifId]: recapitulatif },
      joueurActifId: coupTermine ? joueurActifId : (coup.ordreJoueurs[indexSuivant] as JoueurId),
      numeroTour: coupTermine ? coup.numeroTour : numeroTour,
      phase: coupTermine ? 'termine' : coup.phase,
      gagnantId: coupTermine ? joueurActifId : coup.gagnantId,
    },
    coupTermine,
  };
};

/**
 * Ce qu'un échange de joker exige, qu'il soit replacé dans la foulée ou plus
 * tard dans le tour : un joker qui déclare ce qu'il représente, et la vraie
 * carte correspondante.
 *
 * Réf. docs/REGLES.md § « Récupération d'un joker posé » : l'échange se fait à
 * tout moment du tour, jeu déjà ouvert ou non. Ce que le joker repris permet
 * ensuite se juge à la pose (`jouerTour`), pas ici.
 */
const verifierEchange = (
  coup: Coup,
  carteReelle: Carte,
  jokerCible: JokerCible,
): { readonly cible: Combinaison; readonly jokerPosee: CartePosee } => {
  const cible = coup.combinaisons.find((combinaison) => combinaison.id === jokerCible.combinaisonId);
  if (cible === undefined) {
    throw new Error(`Combinaison ${jokerCible.combinaisonId} introuvable sur la table`);
  }

  const jokerPosee = cible.cartes.find((cp) => cp.carte.id === jokerCible.carteJokerId);
  if (jokerPosee === undefined || !estJoker(jokerPosee.carte)) {
    throw new Error(`Aucun joker d'identifiant ${jokerCible.carteJokerId} dans cette combinaison`);
  }
  if (jokerPosee.remplace === null) {
    throw new Error('Ce joker ne declare pas la carte qu il represente : echange impossible');
  }

  const { couleur, valeur } = jokerPosee.remplace;
  if (
    carteReelle.type !== 'normale' ||
    carteReelle.couleur !== couleur ||
    carteReelle.valeur !== valeur
  ) {
    throw new Error(
      `La carte proposee n est pas celle que le joker represente (${String(valeur)} de ${couleur})`,
    );
  }

  return { cible, jokerPosee };
};

/** La carte piochée ce tour-ci, et d'où `jouerTour` ira la prendre. */
export interface CartePiocheeDuTour {
  readonly carte: Carte;
  readonly source: 'pioche' | 'defausse';
}

/**
 * Échange la vraie carte contre un joker posé, sans exiger qu'il soit replacé
 * dans la même action.
 *
 * § « Récupération d'un joker posé » : le joker repris doit être replacé au
 * même tour. Cette fonction ne fait que l'échange ; l'obligation se vérifie à
 * la clôture du tour, quand tout ce que le joueur a composé est connu.
 *
 * La vraie carte vient de la main, ou de la carte piochée au talon ce tour-ci.
 * Dans ce second cas, le joker prend la place de la carte piochée en tête du
 * talon, là où `jouerTour` ira la chercher : le moteur « pioche » alors le
 * joker, qui est bien ce que le joueur tient.
 *
 * La carte prise dans la défausse, elle, ne reprend jamais de joker (§ «
 * Récupération d'un joker posé ») : elle peut servir dans une autre
 * combinaison, pas dans cet échange.
 */
export const echangerJoker = (
  coup: Coup,
  joueurId: JoueurId,
  carteReelle: Carte,
  jokerCible: JokerCible,
  cartePiochee: CartePiocheeDuTour | null = null,
): { readonly coup: Coup; readonly joker: Carte } => {
  if (cartePiochee?.source === 'defausse' && cartePiochee.carte.id === carteReelle.id) {
    throw new Error(
      'La carte prise dans la defausse ne peut pas reprendre un joker : elle peut servir dans une autre combinaison',
    );
  }
  const { cible, jokerPosee } = verifierEchange(coup, carteReelle, jokerCible);

  const cibleEchangee = avecCartes(
    cible,
    cible.cartes.map((cp) =>
      cp.carte.id === jokerPosee.carte.id ? { carte: carteReelle, remplace: null } : cp,
    ),
  );
  if (!estCombinaisonProlongeeValide(cibleEchangee)) {
    throw new Error('L echange rendrait la combinaison invalide');
  }

  const combinaisons = coup.combinaisons.map((combinaison) =>
    combinaison.id === cible.id ? cibleEchangee : combinaison,
  );
  const joker = jokerPosee.carte;
  const main = coup.mains[joueurId] ?? [];

  if (main.some((carte) => carte.id === carteReelle.id)) {
    return {
      coup: {
        ...coup,
        combinaisons,
        mains: { ...coup.mains, [joueurId]: [...main.filter((carte) => carte.id !== carteReelle.id), joker] },
      },
      joker,
    };
  }

  if (cartePiochee !== null && cartePiochee.carte.id === carteReelle.id) {
    if (coup.pioche[0]?.id !== carteReelle.id) {
      throw new Error('La carte piochee n est plus en tete du talon');
    }
    return { coup: { ...coup, combinaisons, pioche: [joker, ...coup.pioche.slice(1)] }, joker };
  }

  throw new Error(`La carte ${carteReelle.id} n est pas dans la main de ${joueurId}`);
};

/**
 * Récupération d'un joker posé.
 *
 * § « Récupération d'un joker posé » : un joueur qui détient la vraie carte représentée par un joker visible peut l'échanger. Le joker
 * récupéré doit être IMMÉDIATEMENT replacé dans une combinaison de sa main, au
 * même tour : c'est l'objet du paramètre `replacement`.
 */
export const recupererJoker = (
  coup: Coup,
  joueurId: JoueurId,
  carteReelle: Carte,
  jokerCible: JokerCible,
  replacement: Combinaison | null,
): NouvelEtatCoup => {
  const { cible, jokerPosee } = verifierEchange(coup, carteReelle, jokerCible);

  const main = coup.mains[joueurId] ?? [];
  if (!main.some((carte) => carte.id === carteReelle.id)) {
    throw new Error(`La carte ${carteReelle.id} n est pas dans la main de ${joueurId}`);
  }

  if (replacement === null) {
    throw new Error('Le joker recupere doit etre immediatement replace dans une combinaison');
  }
  if (!replacement.cartes.some((cp) => cp.carte.id === jokerPosee.carte.id)) {
    throw new Error('Le replacement propose ne contient pas le joker recupere');
  }
  const signe = attribuer(replacement, joueurId, coup.numeroTour);
  if (!estCombinaisonValide(signe)) {
    throw new Error('Le joker recupere doit etre replace dans une tierce ou un brelan valide');
  }

  const cartesDuReplacement = signe.cartes
    .map((cp) => cp.carte)
    .filter((carte) => carte.id !== jokerPosee.carte.id);
  for (const carte of cartesDuReplacement) {
    if (carte.id === carteReelle.id || !main.some((enMain) => enMain.id === carte.id)) {
      throw new Error(`La carte ${carte.id} du replacement n est pas disponible en main`);
    }
  }

  const cibleEchangee = avecCartes(
    cible,
    cible.cartes.map((cp) =>
      cp.carte.id === jokerPosee.carte.id ? { carte: carteReelle, remplace: null } : cp,
    ),
  );
  // La cible peut être une suite allongée au fil des tours : la juger avec le
  // plafond de la pose la refuserait pour sa seule longueur.
  if (!estCombinaisonProlongeeValide(cibleEchangee)) {
    throw new Error('L echange rendrait la combinaison invalide');
  }

  const consommees = new Set([carteReelle.id, ...cartesDuReplacement.map((carte) => carte.id)]);
  const precedent = coup.recapitulatifs[joueurId] ?? {
    toursAvecPose: [],
    aAjouteSurCombinaisonAutrui: false,
  };

  return {
    coup: {
      ...coup,
      mains: {
        ...coup.mains,
        [joueurId]: main.filter((carte) => !consommees.has(carte.id)),
      },
      combinaisons: [
        ...coup.combinaisons.map((combinaison) =>
          combinaison.id === cible.id ? cibleEchangee : combinaison,
        ),
        signe,
      ],
      recapitulatifs: {
        ...coup.recapitulatifs,
        [joueurId]: {
          toursAvecPose: precedent.toursAvecPose.includes(coup.numeroTour)
            ? [...precedent.toursAvecPose]
            : [...precedent.toursAvecPose, coup.numeroTour],
          // Placer une carte dans la combinaison d'un autre joueur, c'est
          // s'appuyer sur son jeu visible : cela ferme la porte au « double ».
          aAjouteSurCombinaisonAutrui:
            precedent.aAjouteSurCombinaisonAutrui || cible.proprietaireId !== joueurId,
        },
      },
    },
    coupTermine: false,
  };
};
