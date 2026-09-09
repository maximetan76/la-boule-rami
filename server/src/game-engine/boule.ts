/**
 * Orchestration au niveau Boule : composition de la table coup après coup,
 * coups frichés, cumul des scores et fin de la série.
 *
 * Réf. `docs/REGLES.md` § « Structure d'une Boule » et § « Joueurs et
 * matériel ».
 */
import type { Boule, Joueur, JoueurId, ScoreCoup } from '../models/index.js';
import { COUPS_FRICHES_PAR_DEFAUT, COUPS_PAR_NOMBRE_DE_JOUEURS } from '../models/index.js';

/** Nombre de joueurs mis sur le côté à 5 ou 6 joueurs (§ « Joueurs et matériel »). */
export const JOUEURS_SUR_LE_COTE = 2;

/** À partir de ce nombre de joueurs, 2 joueurs ne jouent pas la main. */
const SEUIL_JOUEURS_SUR_LE_COTE = 5;

/** Ce que renvoie `orchestrerPhaseFricheOuJoue` quand personne ne joue le coup. */
export interface FricheGeneralisee {
  readonly toutLeMondeAFriche: true;
}

export interface CompositionCoup {
  /** Joueurs qui jouent le coup, en commençant à la gauche du donneur. */
  readonly joueursActifs: JoueurId[];
  /** Joueurs « sur le côté », qui ne jouent pas ce coup. */
  readonly joueursAssis: JoueurId[];
  readonly donneurId: JoueurId;
}

/** Modulo toujours positif : `-1 % 5` vaut -1 en JavaScript. */
const modulo = (valeur: number, base: number): number => ((valeur % base) + base) % base;

/**
 * Prépare une Boule.
 *
 * @param joueurs joueurs dans l'ordre de la table.
 * @param nombreCoupsFriches coups frichés d'office, choisis en début de Boule.
 */
export const initialiserBoule = (
  joueurs: readonly Joueur[],
  nombreCoupsFriches: number = COUPS_FRICHES_PAR_DEFAUT,
): Boule => {
  const nombreCoupsTotal = COUPS_PAR_NOMBRE_DE_JOUEURS[joueurs.length];
  if (nombreCoupsTotal === undefined) {
    // Les règles ne donnent un nombre de coups que de 3 à 6 joueurs.
    throw new Error(`Aucun nombre de coups defini pour ${String(joueurs.length)} joueurs`);
  }
  if (nombreCoupsFriches < 0 || nombreCoupsFriches > nombreCoupsTotal) {
    throw new Error(
      `Nombre de coups friches hors limites : ${String(nombreCoupsFriches)} pour ${String(nombreCoupsTotal)} coups`,
    );
  }

  const scoresCumules: Record<JoueurId, number> = {};
  const croix: Record<JoueurId, number> = {};
  for (const { id } of joueurs) {
    scoresCumules[id] = 0;
    croix[id] = 0;
  }

  return {
    ordreTable: joueurs.map((joueur) => joueur.id),
    nombreCoupsTotal,
    nombreCoupsFriches,
    coupEnCours: null,
    historique: [],
    scoresCumules,
    croix,
  };
};

/**
 * Composition de la table pour un coup donné.
 *
 * § « la rotation des joueurs assis se fait dans l'ordre, en remplaçant
 * systématiquement le donneur du coup précédent » : les deux joueurs sur le
 * côté d'un coup sont les donneurs des deux coups précédents. À chaque coup, le
 * donneur qui vient de servir rejoint le côté et celui qui y est depuis deux
 * coups revient en jeu.
 *
 * Le donneur avance d'un siège par coup dans l'ordre de la table. Les règles ne
 * disent pas explicitement comment il tourne : c'est la seule rotation
 * compatible avec la règle ci-dessus, puisqu'elle garantit qu'un donneur n'est
 * jamais sur le côté au moment de servir. Elle fixe aussi, par prolongement
 * vers l'arrière, quels joueurs sont sur le côté au tout premier coup.
 *
 * Tout ne dépend ici que de `numeroCoup`. C'est ce qui fait qu'un coup rejoué
 * pour friche généralisée garde son donneur et sa composition : le numéro de
 * coup n'avance pas, donc rien ne tourne. Un donneur maintenu en place n'est
 * pas non plus compté deux fois dans la rotation des joueurs sur le côté, qui
 * se lit elle aussi sur les numéros de coups et non sur les donneurs passés.
 * Utiliser `numeroCoupCourant` évite au appelant de se tromper de numéro.
 */
export const determinerJoueursAssis = (boule: Boule, numeroCoup: number): CompositionCoup => {
  const taille = boule.ordreTable.length;
  if (taille === 0) {
    throw new Error('Boule sans joueur');
  }
  if (numeroCoup < 1) {
    throw new Error(`Numero de coup invalide : ${String(numeroCoup)}`);
  }

  const siege = (rang: number): JoueurId => boule.ordreTable[modulo(rang, taille)] as JoueurId;

  // Le donneur du coup n occupe le siège n - 1 (le coup 1 est servi par le
  // premier joueur de la table).
  const donneurId = siege(numeroCoup - 1);

  const joueursAssis =
    taille >= SEUIL_JOUEURS_SUR_LE_COTE
      ? // Donneurs des deux coups précédents.
        [siege(numeroCoup - 2), siege(numeroCoup - 3)]
      : [];

  // L'ordre de jeu commence à la gauche du donneur et saute ceux qui sont sur
  // le côté (§ « Phase Friche / Je joue »).
  const joueursActifs: JoueurId[] = [];
  for (let decalage = 1; decalage <= taille; decalage += 1) {
    const joueurId = siege(numeroCoup - 1 + decalage);
    if (!joueursAssis.includes(joueurId)) joueursActifs.push(joueurId);
  }

  return { joueursActifs, joueursAssis, donneurId };
};

/**
 * Le coup fait-il partie des coups frichés ?
 *
 * § « Ce sont toujours les DERNIERS coups de la Boule qui sont frichés, le
 * décompte partant de la fin » : le décalage suit donc automatiquement les
 * rallonges dues aux friches généralisées.
 */
export const estCoupFriche = (boule: Boule, numeroCoup: number): boolean =>
  numeroCoup > boule.nombreCoupsTotal - boule.nombreCoupsFriches;

const estFricheGeneralisee = (
  resultat: ScoreCoup | FricheGeneralisee,
): resultat is FricheGeneralisee => 'toutLeMondeAFriche' in resultat;

/**
 * Enregistre l'issue d'un coup.
 *
 * Cas normal : les scores et les croix du coup s'ajoutent aux cumuls et le coup
 * rejoint l'historique.
 *
 * Friche généralisée : § « ce coup est rejoué à la même place, avec le MÊME
 * donneur [...] seul le nombre de coups frichés augmente d'un cran ». Rien
 * n'est marqué, l'historique ne bouge pas, et le même numéro de coup reste
 * attendu — c'est ce qui fait rester le donneur en place.
 */
export const enregistrerResultatCoup = (
  boule: Boule,
  numeroCoup: number,
  resultat: ScoreCoup | FricheGeneralisee,
): Boule => {
  const attendu = boule.historique.length + 1;
  if (numeroCoup !== attendu) {
    throw new Error(`Coup ${String(numeroCoup)} enregistre hors de son rang (attendu : ${String(attendu)})`);
  }

  if (estFricheGeneralisee(resultat)) {
    // La Boule garde son nombre de coups scorés : le coup est simplement
    // rejoué à la même place, avec le même donneur. Seul le compteur de coups
    // frichés avance, ce qui décale les numéros concernés en partant de la fin.
    return {
      ...boule,
      nombreCoupsFriches: Math.min(boule.nombreCoupsFriches + 1, boule.nombreCoupsTotal),
    };
  }

  const scoresCumules: Record<JoueurId, number> = { ...boule.scoresCumules };
  const croix: Record<JoueurId, number> = { ...boule.croix };
  for (const joueurId of boule.ordreTable) {
    scoresCumules[joueurId] = (scoresCumules[joueurId] ?? 0) + (resultat.scores[joueurId] ?? 0);
    croix[joueurId] = (croix[joueurId] ?? 0) + (resultat.croixGagnees[joueurId] ?? 0);
  }

  return {
    ...boule,
    scoresCumules,
    croix,
    historique: [
      ...boule.historique,
      {
        numero: numeroCoup,
        gagnantId: resultat.gagnantId,
        typeVictoire: resultat.typeVictoire,
        estFriche: resultat.estFriche,
        scores: resultat.scores,
        croixGagnees: resultat.croixGagnees,
      },
    ],
  };
};

/**
 * Numéro du coup à jouer. Il n'avance qu'une fois le coup effectivement joué
 * et enregistré : une friche généralisée le laisse en place, et avec lui le
 * donneur et la composition de la table.
 */
export const numeroCoupCourant = (boule: Boule): number => boule.historique.length + 1;

/** Tous les coups de la Boule ont-ils été joués ? */
export const estBouleTerminee = (boule: Boule): boolean =>
  boule.historique.length >= boule.nombreCoupsTotal;
