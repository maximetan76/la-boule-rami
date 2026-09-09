/**
 * Joueur.
 *
 * Réf. `docs/REGLES.md` § « Conditions pour poser » pour `aPose` (la pose est
 * une bascule : tant qu'un joueur n'a pas posé 51 points + une tierce pure, il
 * ne peut ni compléter les combinaisons des autres, ni piocher en défausse) et
 * § « Bonus quinte flush royale (les croix) » pour `croix`, cumulées sur toute
 * la Boule et converties en -100 points par croix à la toute fin.
 */
import type { Carte } from './carte.js';

export type JoueurId = string;

export interface Joueur {
  readonly id: JoueurId;
  readonly nom: string;
  /** Main cachée : ne doit jamais être transmise aux autres clients. */
  main: Carte[];
  /** A déjà posé son jeu lors du coup en cours (51 points + tierce pure). */
  aPose: boolean;
  /** Croix accumulées depuis le début de la Boule en cours. */
  croix: number;
}
