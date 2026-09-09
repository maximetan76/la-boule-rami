/**
 * Orchestration d'un tour de jeu.
 *
 * Réf. `docs/REGLES.md` § « Déroulement d'un tour de jeu » : le joueur pioche
 * (au talon ou la dernière carte de la défausse), peut poser, puis défausse.
 * Voir aussi § « Règle spéciale : piocher la carte de la défausse » et
 * § « Récupération d'un joker posé ».
 */
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
import { estCombinaisonValide, verifierDeclarationsJokers } from './combinaisons.js';
import { estCarteCollante } from './defausse.js';
import { peutPoser, SEUIL_POSE, verifierFinDeCoupSpeciale } from './pose.js';
import { calculerValeurCombinaison } from './combinaisons.js';

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

const aDejaPose = (coup: Coup, joueurId: JoueurId): boolean =>
  (coup.recapitulatifs[joueurId]?.toursAvecPose.length ?? 0) > 0;

const avecCartes = (combinaison: Combinaison, cartes: readonly CartePosee[]): Combinaison =>
  combinaison.type === 'tierce' ? { ...combinaison, cartes } : { ...combinaison, cartes };

/** Le moteur signe lui-même les combinaisons posées : ni propriétaire ni tour ne sont déclarés. */
const attribuer = (combinaison: Combinaison, proprietaireId: JoueurId, tourDePose: number): Combinaison =>
  combinaison.type === 'tierce'
    ? { ...combinaison, proprietaireId, tourDePose }
    : { ...combinaison, proprietaireId, tourDePose };

export const jouerTour = (
  coup: Coup,
  joueurActifId: JoueurId,
  action: ActionTour,
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
      // Les règles ne disent pas ce qu'il advient d'une pioche épuisée.
      throw new Error('Pioche epuisee : impossible de piocher au talon');
    }
    cartePiochee = pioche.shift() as Carte;
  } else {
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
    if (!estCombinaisonValide(enrichie)) {
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
        `Premiere pose invalide : il faut au moins ${String(SEUIL_POSE)} points et une tierce pure`,
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

    for (const existante of coup.combinaisons) {
      if (!estCarteCollante(cartePiochee, existante)) continue;
      const prolongeCetteSuite = ajouts.some(
        (ajout) =>
          ajout.combinaisonId === existante.id &&
          ajout.cartes.some((cp) => cp.carte.id === cartePiochee.id),
      );
      if (!prolongeCetteSuite) {
        throw new Error(
          'Carte collante : elle ne fait que prolonger une suite deja posee, elle ne peut pas etre prise dans la defausse pour autre chose',
        );
      }
    }

    if (!dejaPose) {
      const porteuse = poses.find((combinaison) =>
        combinaison.cartes.some((cp) => cp.carte.id === cartePiochee.id),
      );
      const valeur = porteuse === undefined ? 0 : calculerValeurCombinaison(porteuse);
      if (valeur < SEUIL_POSE) {
        throw new Error(
          `Sans pose prealable, la combinaison formee avec la carte de la defausse doit atteindre a elle seule ${String(SEUIL_POSE)} points`,
        );
      }
    }
  }

  // --- Application des poses et des ajouts --------------------------------
  const posees = poses.map((combinaison) => {
    const signee = attribuer(combinaison, joueurActifId, coup.numeroTour);
    if (!estCombinaisonValide(signee)) {
      throw new Error(`Combinaison posee invalide : ${signee.id}`);
    }
    return signee;
  });

  // --- Défausse -----------------------------------------------------------
  const mainApresPose = mainApresPioche.filter((carte) => !utilisees.has(carte.id));
  const carteDefaussee = mainApresPose.find((carte) => carte.id === action.carteDefausseeId);
  if (carteDefaussee === undefined) {
    throw new Error(`Carte a defausser ${action.carteDefausseeId} absente de la main`);
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
 * Récupération d'un joker posé.
 *
 * § « Récupération d'un joker posé » : un joueur qui a déjà posé et qui détient
 * la vraie carte représentée par un joker visible peut l'échanger. Le joker
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
  if (!aDejaPose(coup, joueurId)) {
    throw new Error(`${joueurId} doit avoir pose son jeu avant de recuperer un joker`);
  }

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
  if (!estCombinaisonValide(cibleEchangee)) {
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
