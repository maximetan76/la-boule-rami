/**
 * Orchestration au niveau Boule : composition de la table coup après coup,
 * coups frichés, cumul des scores et fin de la série.
 *
 * Réf. `docs/REGLES.md` § « Structure d'une Boule » et § « Joueurs et
 * matériel ».
 */
import type { ArchiveCoup, Boule, Carte, Joueur, JoueurId, ScoreCoup } from '../models/index.js';
import { COUPS_FRICHES_PAR_DEFAUT, COUPS_PAR_NOMBRE_DE_JOUEURS } from '../models/index.js';
import { estJoker, rang } from './cartes.js';

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
  archive?: ArchiveCoup,
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
        // Ce qui s'est posé et ce qui est resté en main : de quoi revenir sur
        // ce coup plus tard dans la Boule, sans en rien recalculer.
        ...(archive === undefined
          ? {}
          : {
              combinaisons: archive.combinaisons.map((combinaison) => ({ ...combinaison })),
              mainsRevelees: Object.fromEntries(
                Object.entries(archive.mainsRevelees).map(([joueurId, cartes]) => [
                  joueurId,
                  [...cartes],
                ]),
              ),
              ...(archive.poseFinale === undefined ? {} : { poseFinale: [...archive.poseFinale] }),
            }),
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

/**
 * Coups frichés ajoutés pendant la Boule par les friches généralisées, au-delà
 * de ce qui avait été choisi au départ.
 */
export const surplusDeCoupsFriches = (boule: Boule, coupsFrichesDepart: number): number =>
  Math.max(0, boule.nombreCoupsFriches - coupsFrichesDepart);

/**
 * Coups frichés de départ d'une Boule rejouée avec le même groupe : les 2 par
 * défaut, plus le surplus de la Boule qui s'achève, sans dépasser le nombre de
 * coups de la nouvelle Boule. Boule configurée à 2, trois friches généralisées
 * en route (5 à la fin) : la suivante démarre à 2 + 3 = 5.
 */
export const coupsFrichesPourLaSuivante = (
  boule: Boule,
  coupsFrichesDepart: number,
  coupsDeLaBoule: number,
): number => Math.min(COUPS_FRICHES_PAR_DEFAUT + surplusDeCoupsFriches(boule, coupsFrichesDepart), coupsDeLaBoule);

/** Résultat du tirage d'ouverture d'une Boule. */
export interface TirageOuverture {
  /** Joueurs assis dans l'ordre croissant des cartes tirées. */
  readonly ordreTable: JoueurId[];
  /** Celui qui a tiré la carte la plus basse ; il occupe le premier siège. */
  readonly donneurInitial: JoueurId;
  /**
   * Jokers tirés, conservés en main pour la distribution du premier coup.
   * Chaque joueur y figure, avec une liste vide s'il n'a rien tiré de tel.
   */
  readonly cartesConserveesParJoueur: Map<JoueurId, Carte[]>;
  /**
   * Toutes les cartes tirées par chaque joueur, dans l'ordre du tirage : la
   * première, puis celles des retirages en cas d'égalité.
   */
  readonly cartesTirees: Map<JoueurId, Carte[]>;
}

/**
 * Rang d'une carte au tirage d'ouverture, du plus bas au plus haut : joker
 * normal et coucou sont ex æquo au rang le plus bas, puis 2 à 10, valet, dame,
 * roi, et l'as au plus haut.
 *
 * C'est un classement propre au tirage : il ne se confond pas avec la lecture
 * de l'as dans une suite, où il vaut 1 ou 14 selon sa position.
 */
export const rangDeTirage = (carte: Carte): number => (estJoker(carte) ? 0 : rang(carte.valeur, true));

/**
 * Tirage d'ouverture : chaque joueur tire une carte, la plus basse donne, et
 * les sièges suivent l'ordre croissant des cartes tirées.
 *
 * En cas d'égalité, seuls les joueurs concernés retirent, et cette seconde
 * carte ne départage qu'eux : leur position face aux autres joueurs reste celle
 * de leur première carte. L'opération se répète tant que l'égalité persiste.
 *
 * @param paquetMelange cartes étalées face cachée ; elles sont tirées dans
 * l'ordre, d'abord une par joueur, puis une par joueur encore à départager.
 */
export const tirerSiegesEtDonneurInitial = (
  joueurs: readonly Joueur[],
  paquetMelange: readonly Carte[],
): TirageOuverture => {
  if (joueurs.length === 0) {
    throw new Error('Impossible de tirer les sieges sans joueur');
  }

  const tirages = new Map<JoueurId, Carte[]>(joueurs.map((joueur) => [joueur.id, []]));
  let curseur = 0;

  const tirerPour = (joueurId: JoueurId): void => {
    const carte = paquetMelange[curseur];
    if (carte === undefined) {
      throw new Error('Paquet epuise : impossible de departager le tirage');
    }
    curseur += 1;
    (tirages.get(joueurId) as Carte[]).push(carte);
  };

  /**
   * Ordonne un groupe de joueurs par leur carte de rang `profondeur`, en
   * faisant retirer les seuls sous-groupes encore à égalité. La récursion reste
   * confinée au groupe : c'est ce qui empêche une seconde carte de déplacer un
   * joueur par rapport à quelqu'un qui n'était pas à égalité avec lui.
   */
  const ordonner = (ids: readonly JoueurId[], profondeur: number): JoueurId[] => {
    if (ids.length <= 1) return [...ids];

    const groupes = new Map<number, JoueurId[]>();
    for (const joueurId of ids) {
      const cartes = tirages.get(joueurId) as Carte[];
      while (cartes.length <= profondeur) tirerPour(joueurId);
      const rangTire = rangDeTirage(cartes[profondeur] as Carte);
      groupes.set(rangTire, [...(groupes.get(rangTire) ?? []), joueurId]);
    }

    return [...groupes.keys()]
      .sort((a, b) => a - b)
      .flatMap((rangTire) => ordonner(groupes.get(rangTire) as JoueurId[], profondeur + 1));
  };

  const ordreTable = ordonner(
    joueurs.map((joueur) => joueur.id),
    0,
  );

  // Un joker tiré reste en main pour la distribution du premier coup, à
  // n'importe quel tour de tirage.
  const cartesConserveesParJoueur = new Map<JoueurId, Carte[]>(
    joueurs.map((joueur) => [
      joueur.id,
      (tirages.get(joueur.id) as Carte[]).filter(estJoker),
    ]),
  );

  return {
    ordreTable,
    donneurInitial: ordreTable[0] as JoueurId,
    cartesConserveesParJoueur,
    cartesTirees: new Map([...tirages].map(([joueurId, cartes]) => [joueurId, [...cartes]])),
  };
};
