/**
 * Primitives sur les cartes : rangs et points.
 *
 * Réf. `docs/REGLES.md` § « Conditions pour poser » (points de pose) et
 * § « Fin d'un coup et scoring » (points des cartes restées en main).
 */
import type { Carte, CarteNormale, Joker, Valeur } from '../models/index.js';

export const estJoker = (carte: Carte): carte is Joker => carte.type !== 'normale';

export const estCarteNormale = (carte: Carte): carte is CarteNormale => carte.type === 'normale';

/** Rang le plus bas possible : l'as bas d'une tierce As-2-3. */
export const RANG_MIN = 1;
/** Rang le plus haut possible : l'as haut d'une tierce D-R-A. */
export const RANG_MAX = 14;

/**
 * Rang d'une valeur dans une suite. L'as se lit en bas (1) dans une tierce
 * As-2-3 et en haut (14) dans une tierce D-R-A ; il ne « boucle » jamais.
 */
export const rang = (valeur: Valeur, asHaut: boolean): number => {
  if (valeur === 'A') return asHaut ? RANG_MAX : RANG_MIN;
  if (valeur === 'V') return 11;
  if (valeur === 'D') return 12;
  if (valeur === 'R') return 13;
  return valeur;
};

/**
 * Points d'une carte au moment de la pose.
 *
 * § « Conditions pour poser » : l'as vaut 1 point dans une tierce As-2-3 et
 * 11 points dans une tierce D-R-A ou un brelan d'as ; les figures valent 10 ;
 * les autres cartes leur valeur faciale. Un joker ou le coucou ne rapportent
 * aucun point de pose puisqu'ils ne font que remplacer une autre carte.
 */
export const pointsDePose = (carte: Carte, asHaut: boolean): number => {
  if (estJoker(carte)) return 0;
  const { valeur } = carte;
  if (valeur === 'A') return asHaut ? 11 : 1;
  if (valeur === 'V' || valeur === 'D' || valeur === 'R') return 10;
  return valeur;
};

/**
 * Points d'une carte restée en main à la fin d'un coup.
 *
 * § « Fin d'un coup et scoring » : as = 11, figures = 10, joker normal = 20,
 * coucou = 20, autres cartes = valeur faciale. Contrairement aux points de
 * pose, l'as vaut toujours 11 ici.
 */
export const pointsEnMain = (carte: Carte): number => {
  if (estJoker(carte)) return 20;
  return pointsDePose(carte, true);
};
