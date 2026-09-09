/**
 * Joueur, tel qu'il persiste d'un coup à l'autre.
 *
 * Réf. `docs/REGLES.md` § « Bonus quinte flush royale (les croix) » pour
 * `croix`, cumulées sur toute la Boule et converties en -100 points par croix
 * à la toute fin.
 *
 * Tout ce qui n'existe que le temps d'un coup — la main, le fait d'avoir déjà
 * posé — appartient au `Coup` et non au joueur : voir `Coup.mains` et
 * `Coup.recapitulatifs`.
 */

export type JoueurId = string;

export interface Joueur {
  readonly id: JoueurId;
  readonly nom: string;
  /** Croix accumulées depuis le début de la Boule en cours. */
  croix: number;
}
