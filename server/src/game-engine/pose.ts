/**
 * Validation de la première pose d'un joueur.
 *
 * Réf. `docs/REGLES.md` § « Conditions pour poser » : il faut réunir DEUX
 * conditions — au moins 51 points ET au moins une tierce pure. Le joker peut
 * figurer dans les autres combinaisons posées en même temps, mais pas dans la
 * tierce qui valide la pose ; le coucou, lui, y est admis.
 */
import type { Carte, Combinaison } from '../models/index.js';
import {
  calculerValeurCombinaison,
  estCombinaisonValide,
  estTierceValidante,
  verifierDeclarationsJokers,
} from './combinaisons.js';

/** Seuil de points requis pour une première pose. */
export const SEUIL_POSE = 51;

/**
 * Toutes les cartes proposées viennent-elles de la main, chaque exemplaire
 * n'étant utilisé qu'une fois ? Les identifiants distinguent les doublons des
 * deux jeux de 52.
 */
const cartesDisponibles = (main: readonly Carte[], combinaisons: readonly Combinaison[]): boolean => {
  const restantes = new Set(main.map((carte) => carte.id));
  for (const combinaison of combinaisons) {
    for (const { carte } of combinaison.cartes) {
      if (!restantes.delete(carte.id)) return false;
    }
  }
  return true;
};

/**
 * Le joueur peut-il poser ces combinaisons comme première pose ?
 *
 * @param main cartes actuellement en main
 * @param combinaisonsProposees combinaisons qu'il veut poser d'un coup
 */
export const peutPoser = (
  main: readonly Carte[],
  combinaisonsProposees: readonly Combinaison[],
): boolean => {
  if (combinaisonsProposees.length === 0) return false;
  // Un joker en bout de suite doit déclarer la carte qu'il représente : c'est
  // une erreur de pose, distincte d'une combinaison simplement refusée.
  verifierDeclarationsJokers(combinaisonsProposees);
  if (!combinaisonsProposees.every(estCombinaisonValide)) return false;
  if (!cartesDisponibles(main, combinaisonsProposees)) return false;
  if (!combinaisonsProposees.some(estTierceValidante)) return false;

  const total = combinaisonsProposees.reduce(
    (somme, combinaison) => somme + calculerValeurCombinaison(combinaison),
    0,
  );
  return total >= SEUIL_POSE;
};
