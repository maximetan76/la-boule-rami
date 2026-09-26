/**
 * Les stratégies des joueurs automatiques. Voir `strategie.ts`.
 */
import type { Variante } from '../models/index.js';
import { strategieElementaire } from './elementaire.js';
import { strategiePanier, strategiePanierForte } from './panier.js';
import type { Strategie } from './strategie.js';

export { memoireVierge } from './strategie.js';
export type { FinDeTour, MemoireDuRobot, Source, Strategie } from './strategie.js';

/** La force de l'ordinateur, choisie à la création d'une partie contre lui. */
export type NiveauOrdinateur = 'facile' | 'fort';
export const NIVEAUX_ORDINATEUR: readonly NiveauOrdinateur[] = ['facile', 'fort'];

/** La cervelle d'un robot, selon le jeu joué à sa table et le niveau choisi. */
export const strategieDe = (variante: Variante, niveau: NiveauOrdinateur = 'facile'): Strategie => {
  if (variante !== 'panier') return strategieElementaire;
  return niveau === 'fort' ? strategiePanierForte : strategiePanier;
};
