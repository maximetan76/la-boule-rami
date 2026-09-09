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
 * Points d'une valeur au moment de la pose.
 *
 * § « Conditions pour poser » : l'as vaut 1 point dans une tierce As-2-3 et
 * 11 points dans une tierce D-R-A ou un brelan d'as ; les figures valent 10 ;
 * les autres cartes leur valeur faciale.
 *
 * Un joker (ou le coucou) posé n'a pas de valeur propre : il compte pour la
 * carte qu'il remplace, résolue par le moteur de combinaisons.
 */
export const pointsDeValeur = (valeur: Valeur, asHaut: boolean): number => {
  if (valeur === 'A') return asHaut ? 11 : 1;
  if (valeur === 'V' || valeur === 'D' || valeur === 'R') return 10;
  return valeur;
};

/** Points de pose de la carte occupant un rang donné dans une suite. */
export const pointsDuRang = (rangCarte: number): number => {
  if (rangCarte === RANG_MIN) return 1;
  if (rangCarte === RANG_MAX) return 11;
  if (rangCarte >= 11) return 10;
  return rangCarte;
};

/**
 * Points d'une carte restée en main à la fin d'un coup.
 *
 * § « Fin d'un coup et scoring » : as = 11, figures = 10, joker normal = 20,
 * coucou = 20, autres cartes = valeur faciale. Ici le joker vaut 20 points
 * fixes, sans rapport avec la valeur qu'il aurait eue une fois posé, et l'as
 * vaut toujours 11.
 */
export const pointsEnMain = (carte: Carte): number => {
  if (estJoker(carte)) return 20;
  return pointsDeValeur(carte.valeur, true);
};
