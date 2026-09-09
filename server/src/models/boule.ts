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
