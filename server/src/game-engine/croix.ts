/**
 * Bonus « quinte flush royale », les croix.
 *
 * Réf. `docs/REGLES.md` § « Bonus quinte flush royale (les croix) » :
 * - quinte flush royale PURE (A-R-D-V-10 de la même couleur, sans joker) : 2 croix ;
 * - la même posée avec le coucou à la place d'une des 5 cartes : 1 croix ;
 * - le bonus tombe si le joueur pose en même temps une carte qui prolongerait
 *   la quinte (le 9 de la même couleur) : il doit la garder pour un tour ultérieur.
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
 * Le joueur a-t-il posé, au même tour, une carte qui prolongerait la quinte ?
 *
 * Le texte des règles ne cite que le 9 de la même couleur, seule carte capable
 * de prolonger une suite qui monte déjà jusqu'à l'as.
 */
const quinteProlongeeAuMemeTour = (coup: Coup, quinte: Combinaison): boolean => {
  if (quinte.type !== 'tierce') return false;
  const rangProlongement = RANG_DIX - 1;

  return coup.combinaisons.some(
    (autre) =>
      autre.id !== quinte.id &&
      autre.proprietaireId === quinte.proprietaireId &&
      autre.tourDePose === quinte.tourDePose &&
      rangsDesCartesReelles(autre, quinte.couleur).includes(rangProlongement),
  );
};

/** Croix gagnées par un joueur pendant un coup, avant multiplicateur. */
export const compterCroix = (coup: Coup, joueurId: JoueurId): number =>
  coup.combinaisons
    .filter((combinaison) => combinaison.proprietaireId === joueurId)
    .reduce((total, combinaison) => {
      if (quinteProlongeeAuMemeTour(coup, combinaison)) return total;
      if (detecterQuinteFlushRoyale(combinaison, false)) return total + CROIX_QUINTE_PURE;
      if (detecterQuinteFlushRoyale(combinaison, true)) return total + CROIX_QUINTE_AVEC_COUCOU;
      return total;
    }, 0);
