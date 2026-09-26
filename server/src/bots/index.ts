/**
 * Les stratégies des joueurs automatiques. Voir `strategie.ts`.
 */
import type { Variante } from '../models/index.js';
import { strategieElementaire } from './elementaire.js';
import { strategiePanier } from './panier.js';
import type { Strategie } from './strategie.js';

export { memoireVierge } from './strategie.js';
export type { FinDeTour, MemoireDuRobot, Source, Strategie } from './strategie.js';

/** La cervelle d'un robot, selon le jeu joué à sa table. */
export const strategieDe = (variante: Variante): Strategie =>
  variante === 'panier' ? strategiePanier : strategieElementaire;
