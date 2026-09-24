/**
 * Le temps de jeu de chacun : le temps passé à être attendu par la table.
 *
 * Un seul chronomètre par table, qui suit le joueur attendu — celui qui doit
 * parler pendant les annonces, celui qui doit jouer ensuite. Quand la table
 * attend quelqu'un d'autre, ou plus personne (l'entracte entre deux coups),
 * le temps écoulé est crédité au joueur qu'on attendait, dans la Boule. Le
 * temps de réflexion pendant les annonces compte donc, comme celui d'un tour.
 *
 * Le chronomètre lui-même ne vit qu'en mémoire : un redémarrage du serveur
 * perd au plus le segment en cours, jamais ce qui est déjà crédité.
 */
import type { JoueurId } from '../models/index.js';

/** Ce qui porte un temps de jeu : une Boule, ou un match du panier. */
interface PorteurDeTemps {
  readonly tempsDeJeu?: Record<JoueurId, number>;
}

export interface Chronometre {
  readonly joueurId: JoueurId;
  /** Depuis quand on l'attend, en millisecondes depuis l'époque. */
  readonly depuis: number;
}

export const avancerLeChronometre = <T extends PorteurDeTemps>(
  boule: T | null,
  chronometre: Chronometre | null,
  attendu: JoueurId | null,
  maintenant: number,
): { readonly boule: T | null; readonly chronometre: Chronometre | null } => {
  // Toujours le même joueur attendu : le chronomètre continue de tourner.
  if (chronometre !== null && chronometre.joueurId === attendu) return { boule, chronometre };

  let suite = boule;
  if (chronometre !== null && boule !== null) {
    const ecoule = Math.max(0, maintenant - chronometre.depuis);
    const tempsDeJeu = { ...(boule.tempsDeJeu ?? {}) };
    tempsDeJeu[chronometre.joueurId] = (tempsDeJeu[chronometre.joueurId] ?? 0) + ecoule;
    suite = { ...boule, tempsDeJeu } as T;
  }
  return { boule: suite, chronometre: attendu === null ? null : { joueurId: attendu, depuis: maintenant } };
};
