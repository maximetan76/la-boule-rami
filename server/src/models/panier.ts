/**
 * Un match du « Panier » : la série de manches jouées jusqu'à ce que l'un des
 * deux joueurs en gagne assez pour empocher le montant configuré.
 *
 * Réf. docs/REGLES.md § « Le panier ». Contrairement à une Boule, il n'y a ni
 * points par coup, ni croix, ni double ou triple, ni nombre de coups fixé à
 * l'avance : uniquement un cumul de manches gagnées.
 */
import type { Carte } from './carte.js';
import type { Combinaison } from './combinaison.js';
import type { JoueurId } from './joueur.js';

/** Bornes du nombre de manches à gagner, choisi à la création. */
export const MANCHES_A_GAGNER_MIN = 1;
export const MANCHES_A_GAGNER_MAX = 20;

/** Bornes du montant empoché par le vainqueur, choisi à la création. */
export const MONTANT_MIN = 1;
export const MONTANT_MAX = 1000;

/** Résultat archivé d'une manche terminée. */
export interface ResultatManche {
  readonly numero: number;
  readonly gagnantId: JoueurId;
  /** Ce que le gagnant a posé pour finir : sa main entière, en combinaisons. */
  readonly combinaisons: readonly Combinaison[];
  /** Les mains de tous à l'instant où la manche s'est terminée. */
  readonly mainsRevelees: Readonly<Record<JoueurId, readonly Carte[]>>;
}

export interface MatchPanier {
  /** Les deux joueurs, dans l'ordre fixé au tirage d'ouverture. */
  readonly ordreTable: readonly JoueurId[];
  readonly manchesAGagner: number;
  readonly montant: number;
  readonly manchesGagnees: Readonly<Record<JoueurId, number>>;
  readonly historique: readonly ResultatManche[];
  /** Le premier à avoir atteint `manchesAGagner`, ou `null` en cours de match. */
  readonly vainqueurId: JoueurId | null;
  /**
   * Millisecondes passées à être attendu par la table, par joueur, annonces
   * comprises : le même décompte que celui de La Boule. Absent d'un match
   * antérieur à la mesure.
   */
  readonly tempsDeJeu?: Record<JoueurId, number>;
}
