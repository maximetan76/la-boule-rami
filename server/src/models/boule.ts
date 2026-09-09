/**
 * Une Boule : la série de coups qui constitue une manche complète.
 *
 * Réf. `docs/REGLES.md` § « Structure d'une Boule » et § « Fin de la Boule ».
 */
import type { Coup } from './coup.js';
import type { JoueurId } from './joueur.js';

/** Nombre de coups d'une Boule selon le nombre de joueurs (§ « Structure d'une Boule »). */
export const COUPS_PAR_NOMBRE_DE_JOUEURS: Readonly<Record<number, number>> = {
  3: 9,
  4: 8,
  5: 10,
  6: 12,
};

/** Nombre de coups frichés d'office par défaut, choisi en début de Boule. */
export const COUPS_FRICHES_PAR_DEFAUT = 2;

/** Multiplicateur de fin de coup (§ « Fin d'un coup et scoring »). */
export type TypeVictoire = 'simple' | 'double' | 'triple';

/** Résultat archivé d'un coup terminé. */
export interface ResultatCoup {
  readonly numero: number;
  readonly gagnantId: JoueurId;
  readonly typeVictoire: TypeVictoire;
  /** Le coup faisait partie des coups frichés : facteur x2 supplémentaire. */
  readonly estFriche: boolean;
  /** Points marqués par chaque joueur sur ce coup, multiplicateurs appliqués. */
  readonly scores: Readonly<Record<JoueurId, number>>;
  /** Croix gagnées sur ce coup (quinte flush royale), multiplicateurs appliqués. */
  readonly croixGagnees: Readonly<Record<JoueurId, number>>;
}

/**
 * Score d'un coup pour chaque joueur, multiplicateurs déjà appliqués.
 * Réf. `docs/REGLES.md` § « Fin d'un coup et scoring ».
 */
export interface ScoreCoup {
  readonly gagnantId: JoueurId;
  readonly typeVictoire: TypeVictoire;
  readonly estFriche: boolean;
  /** Facteur appliqué aux montants : (1 | 2 | 3) × 2 si le coup est friché. */
  readonly multiplicateur: number;
  readonly scores: Readonly<Record<JoueurId, number>>;
  readonly croixGagnees: Readonly<Record<JoueurId, number>>;
}

/**
 * Décompte final d'une Boule. Réf. § « Fin de la Boule (tous les coups joués) ».
 */
export interface ResultatBoule {
  /** Somme des scores de chaque joueur sur l'ensemble des coups. */
  readonly scoresCumules: Readonly<Record<JoueurId, number>>;
  /** Joueur(s) au score total le plus bas. */
  readonly gagnantsIds: readonly JoueurId[];
  /** -100 si le score du gagnant est positif, -200 s'il est négatif ; 0 sinon. */
  readonly bonusVictoire: Readonly<Record<JoueurId, number>>;
  /** -100 par croix accumulée pendant la Boule. */
  readonly penalitesCroix: Readonly<Record<JoueurId, number>>;
  /** Score cumulé + bonus de victoire + pénalités de croix. */
  readonly scoresFinaux: Readonly<Record<JoueurId, number>>;
  /**
   * Écarts entre joueurs : `ecarts[a][b]` vaut `scoresFinaux[b] - scoresFinaux[a]`,
   * soit ce que `b` doit à `a` en points — positif quand `a` a le meilleur
   * score. Base de l'enjeu financier optionnel (`Partie.enjeuParPoint`).
   */
  readonly ecarts: Readonly<Record<JoueurId, Readonly<Record<JoueurId, number>>>>;
}

export interface Boule {
  /**
   * Nombre total de coups. Augmente d'un cran à chaque friche généralisée
   * (§ « Structure d'une Boule »).
   */
  nombreCoupsTotal: number;
  /**
   * Nombre de coups frichés, décompté depuis la FIN de la Boule. Augmente
   * lui aussi d'un cran à chaque friche généralisée.
   */
  nombreCoupsFriches: number;
  coupEnCours: Coup | null;
  historique: ResultatCoup[];
  /** Somme des scores de chaque joueur sur les coups déjà joués. */
  scoresCumules: Record<JoueurId, number>;
  /** Croix cumulées sur la Boule, converties en -100 points chacune à la fin. */
  croix: Record<JoueurId, number>;
}
