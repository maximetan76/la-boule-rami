/**
 * La stratégie élémentaire : de quoi faire tourner une table, rien de plus.
 *
 * Elle dit « je joue » chaque fois qu'elle a la parole, pioche au talon et jette
 * la première carte qui n'est pas un joker — le même geste que le serveur joue
 * pour un joueur parti. Elle ne pose jamais. C'est le robot de la table de
 * démonstration de La Boule, tel qu'il a toujours joué.
 */
import { estJoker } from '../game-engine/cartes.js';
import type { Strategie } from './strategie.js';

export const strategieElementaire: Strategie = {
  annoncer: () => 'je-joue',
  choisirSource: () => 'pioche',
  finirTour: (vue, carte) => {
    const aJeter = [carte, ...vue.moi.main].find((candidate) => !estJoker(candidate));
    if (aJeter === undefined) throw new Error('Aucune carte a jeter : la main ne compte que des jokers');
    return { poses: [], carteDefausseeId: aJeter.id };
  },
};
