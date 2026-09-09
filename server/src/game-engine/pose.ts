/**
 * Validation de la première pose d'un joueur.
 *
 * Réf. `docs/REGLES.md` § « Conditions pour poser » : il faut réunir DEUX
 * conditions — au moins 51 points ET au moins une tierce pure. Le joker peut
 * figurer dans les autres combinaisons posées en même temps, mais pas dans la
 * tierce qui valide la pose ; le coucou, lui, y est admis.
 */
import type { Carte, Combinaison } from '../models/index.js';
import { CARTES_PAR_JOUEUR } from '../models/index.js';
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

/**
 * Fin de coup automatique sans les conditions normales.
 *
 * § « Fin de coup automatique sans les conditions normales » : un joueur qui
 * n'a ni tierce pure ni 51 points gagne quand même le coup s'il pose la
 * TOTALITÉ de ses 14 cartes d'un seul coup — seul, ou en s'aidant des
 * combinaisons déjà visibles — puis défausse la 15e carte qu'il vient de
 * piocher.
 *
 * Les cartes d'une combinaison proposée qui ne sont pas dans la main sont
 * celles déjà visibles sur la table, que le joueur prolonge ; c'est à
 * l'appelant de vérifier qu'elles y sont bien.
 *
 * @param main15Cartes main du joueur après avoir pioché : 15 cartes.
 * @param combinaisonsProposees tout ce qu'il pose et prolonge en une fois.
 */
export const verifierFinDeCoupSpeciale = (
  main15Cartes: readonly Carte[],
  combinaisonsProposees: readonly Combinaison[],
): boolean => {
  if (main15Cartes.length !== CARTES_PAR_JOUEUR + 1) return false;
  if (combinaisonsProposees.length === 0) return false;
  if (!combinaisonsProposees.every(estCombinaisonValide)) return false;

  const enMain = new Set(main15Cartes.map((carte) => carte.id));
  const utilisees = new Set<string>();

  for (const combinaison of combinaisonsProposees) {
    for (const { carte } of combinaison.cartes) {
      // Les cartes hors de la main viennent des combinaisons déjà visibles.
      if (!enMain.has(carte.id)) continue;
      if (utilisees.has(carte.id)) return false;
      utilisees.add(carte.id);
    }
  }

  // Les 14 cartes de départ sont posées, il ne reste que la 15e à défausser.
  return utilisees.size === CARTES_PAR_JOUEUR;
};
