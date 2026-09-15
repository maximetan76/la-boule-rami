/**
 * Bonus « quinte flush royale », les croix.
 *
 * Réf. `docs/REGLES.md` § « Bonus quinte flush royale (les croix) » :
 * - quinte flush royale PURE (A-R-D-V-10 de la même couleur, sans joker) : 2 croix ;
 * - la même posée avec le coucou à la place d'une des 5 cartes : 1 croix ;
 * - le bonus tombe si le joueur pose en même temps une carte qui prolongerait
 *   la quinte (le 9 de la même couleur) : il doit la garder pour un tour ultérieur ;
 * - la quinte se pose d'un seul coup : ni complétée plus tard, ni avec un joker repris.
 */
import type { Combinaison, Coup, JoueurId } from '../models/index.js';
import { RANG_MAX } from './cartes.js';
import { fenetreTierce, rangsDesCartesReelles } from './combinaisons.js';

/** Rang le plus bas d'une quinte flush royale : le 10. */
const RANG_DIX = 10;

export const CROIX_QUINTE_PURE = 2;
export const CROIX_QUINTE_AVEC_COUCOU = 1;

/**
 * La combinaison est-elle une quinte flush royale ?
 *
 * @param viaCoucou `false` exige une quinte entièrement naturelle (2 croix),
 * `true` exige exactement une carte remplacée par le coucou (1 croix). Dans
 * les deux cas un joker normal disqualifie la combinaison.
 */
export const detecterQuinteFlushRoyale = (
  combinaison: Combinaison,
  viaCoucou = false,
): boolean => {
  if (combinaison.type !== 'tierce' || combinaison.cartes.length !== 5) return false;

  const fenetre = fenetreTierce(combinaison);
  if (fenetre === null || fenetre.debut !== RANG_DIX || fenetre.fin !== RANG_MAX) return false;

  const jokersNormaux = combinaison.cartes.filter((cp) => cp.carte.type === 'joker').length;
  if (jokersNormaux > 0) return false;

  const coucous = combinaison.cartes.filter((cp) => cp.carte.type === 'coucou').length;
  return viaCoucou ? coucous === 1 : coucous === 0;
};

/**
 * Croix que rapporte une combinaison, à l'instant même de sa pose.
 *
 * Réf. docs/REGLES.md § « Bonus quinte flush royale (les croix) ». La quinte
 * doit être posée d'un seul coup : ses 5 cartes dans la même pose, le coucou
 * venant de la main ou de la carte piochée, jamais d'une autre combinaison.
 * Compléter plus tard une suite de 4, même d'une carte réelle, ne rapporte
 * rien — c'est pourquoi le compte se fait ici et non sur la table en fin de
 * coup. Un joker tout juste repris dans la quinte l'annule, comme le 9 de la
 * même couleur posé dans la même action.
 *
 * @param posesDuTour toutes les combinaisons posées dans la même action, elle comprise.
 * @param jokersRecuperes jokers repris sur la table ce tour-ci.
 */
export const croixALaPose = (
  combinaison: Combinaison,
  posesDuTour: readonly Combinaison[],
  jokersRecuperes: readonly string[] = [],
): number => {
  if (combinaison.type !== 'tierce') return 0;
  const repris = new Set(jokersRecuperes);
  if (combinaison.cartes.some((cp) => repris.has(cp.carte.id))) return 0;

  // « Il doit poser seulement A-R-D-V-10 et garder le 9 pour un tour ultérieur. »
  const prolongee = posesDuTour.some(
    (autre) =>
      autre.id !== combinaison.id &&
      rangsDesCartesReelles(autre, combinaison.couleur).includes(RANG_DIX - 1),
  );
  if (prolongee) return 0;

  if (detecterQuinteFlushRoyale(combinaison, false)) return CROIX_QUINTE_PURE;
  if (detecterQuinteFlushRoyale(combinaison, true)) return CROIX_QUINTE_AVEC_COUCOU;
  return 0;
};

/**
 * Croix gagnées par un joueur pendant un coup, avant multiplicateur : celles
 * que ses combinaisons ont rapportées à leur pose.
 */
export const compterCroix = (coup: Coup, joueurId: JoueurId): number =>
  coup.combinaisons
    .filter((combinaison) => combinaison.proprietaireId === joueurId)
    .reduce((total, combinaison) => total + (combinaison.croix ?? 0), 0);
