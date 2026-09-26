/**
 * La « cervelle » d'un joueur automatique, séparée de son mécanisme.
 *
 * Le serveur décide QUAND un robot joue (`reevaluerLesBots`, dans
 * `server/handlers.ts`) et applique ce qu'il décide avec les mêmes règles que
 * pour tout le monde. Une stratégie ne décide que QUOI jouer, et ne voit que ce
 * qu'un joueur humain verrait à sa place : l'état filtré, pour lui.
 *
 * Un tour se décide en deux temps, comme autour d'une vraie table : d'où
 * piocher, d'abord, sans connaître la carte du talon ; puis quoi poser et quoi
 * jeter, une fois la carte en main.
 */
import type { Annonce, Carte, CarteId, Combinaison } from '../models/index.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';

export type Source = 'pioche' | 'defausse';

/** Ce que le robot fait de son tour, une fois la carte prise. */
export interface FinDeTour {
  /** Ce qu'il pose. Au panier : rien, ou toute sa main pour finir. */
  readonly poses: readonly Combinaison[];
  readonly carteDefausseeId: CarteId;
}

/**
 * Ce qu'un robot retient d'un tour à l'autre, et qu'il a vu comme n'importe
 * quel joueur : rien de caché.
 */
export interface MemoireDuRobot {
  /** Cartes que l'adversaire a prises dans la défausse, ce coup-ci. */
  prisesDeLAdversaire: Carte[];
  /** La dernière carte qu'il a jetée, et la hauteur de la pile juste après. */
  derniereDefausse: { readonly carte: Carte; readonly hauteurDeLaPile: number } | null;
}

export const memoireVierge = (): MemoireDuRobot => ({ prisesDeLAdversaire: [], derniereDefausse: null });

export interface Strategie {
  /** Pendant les annonces, quand il a la parole. */
  annoncer(vue: EtatCoupFiltre, memoire: MemoireDuRobot): Annonce;
  /** Au début de son tour : le talon, ou la carte du dessus de la défausse. */
  choisirSource(vue: EtatCoupFiltre, memoire: MemoireDuRobot): Source;
  /** La carte prise en main : ce qu'il pose, ce qu'il jette. */
  finirTour(vue: EtatCoupFiltre, carte: Carte, source: Source, memoire: MemoireDuRobot): FinDeTour;
}
