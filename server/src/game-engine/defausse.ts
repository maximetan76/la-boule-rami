/**
 * Contraintes de la pioche en défausse.
 *
 * Réf. `docs/REGLES.md` § « Règle spéciale : piocher la carte de la défausse ».
 *
 * Le texte oppose deux situations, illustrées chacune par un exemple :
 * - carte « collante » : suite 6-7-8-9 visible, le joueur voudrait prendre le 5
 *   de la même couleur. Le 5 touche directement le bout de la suite, il ferait
 *   doublon avec la simple extension de celle-ci → interdit ;
 * - carte « sous-collante » : suite 7-8-9 visible, le joueur prend le 5 pour
 *   former un début de suite 5-6 avec le 6 de sa main, sans toucher à la suite
 *   posée. Le 5 est à deux rangs du bout → autorisé.
 *
 * D'où la lecture retenue : distance 1 par rapport à un bout = collante,
 * distance 2 = sous-collante.
 */
import type { Carte, Combinaison } from '../models/index.js';
import { estCarteNormale, rang } from './cartes.js';
import { fenetreTierce } from './combinaisons.js';

/** Distances possibles de la carte à un bout de la suite posée, `null` si non comparable. */
const distancesAuxBouts = (carte: Carte, combinaisonExistante: Combinaison): number[] | null => {
  if (!estCarteNormale(carte)) return null;
  if (combinaisonExistante.type !== 'tierce') return null;
  if (carte.couleur !== combinaisonExistante.couleur) return null;

  const fenetre = fenetreTierce(combinaisonExistante);
  if (fenetre === null) return null;

  // L'as se compare aux deux bouts : bas d'une suite A-2-3, haut d'une D-R-A.
  return [true, false].flatMap((asHaut) => {
    const r = rang(carte.valeur, asHaut);
    return [fenetre.debut - r, r - fenetre.fin];
  });
};

/**
 * La carte touche directement un bout de la suite posée : elle ne ferait que
 * la prolonger et NE PEUT PAS être piochée dans la défausse.
 */
export const estCarteCollante = (carte: Carte, combinaisonExistante: Combinaison): boolean =>
  distancesAuxBouts(carte, combinaisonExistante)?.includes(1) ?? false;

/**
 * La carte se situe à deux rangs d'un bout de la suite posée : elle amorce une
 * combinaison distincte sans toucher à la suite existante, la pioche en
 * défausse est autorisée.
 */
export const estCarteSousCollante = (carte: Carte, combinaisonExistante: Combinaison): boolean =>
  distancesAuxBouts(carte, combinaisonExistante)?.includes(2) ?? false;
