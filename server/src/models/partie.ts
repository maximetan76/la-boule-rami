/**
 * Partie : les joueurs autour de la table et la Boule qu'ils disputent.
 *
 * Réf. `docs/REGLES.md` § « Fin de la Boule » : les écarts de points entre
 * joueurs servent de base à un enjeu financier optionnel (ex. 1 € par point).
 */
import type { Boule } from './boule.js';
import type { Joueur } from './joueur.js';

export type PartieId = string;

export type StatutPartie = 'en-attente' | 'en-cours' | 'terminee';

export interface Partie {
  readonly id: PartieId;
  /** De 1 à 6 joueurs (jeu réel à partir de 3). */
  joueurs: Joueur[];
  boule: Boule | null;
  statut: StatutPartie;
  /** Enjeu optionnel, en unité monétaire par point d'écart. `null` = sans enjeu. */
  enjeuParPoint: number | null;
}
