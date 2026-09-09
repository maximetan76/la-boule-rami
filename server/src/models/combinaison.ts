/**
 * Combinaisons posées sur la table.
 *
 * Réf. `docs/REGLES.md` § « Conditions pour poser » :
 * - une « tierce » est une suite d'au moins 3 cartes consécutives de la même
 *   couleur, jusqu'à 5 cartes (§ « Bonus quinte flush royale » : une suite de
 *   6+ cartes doit obligatoirement être scindée en tierces d'au moins 3) ;
 * - un brelan / carré réunit la même valeur en couleurs toutes différentes ;
 * - une tierce est « pure » si elle ne contient aucun joker.
 */
import type { Carte, Couleur, Valeur } from './carte.js';
import type { JoueurId } from './joueur.js';

export type CombinaisonId = string;

/** Longueurs autorisées pour une tierce (§ « Conditions pour poser »). */
export const TIERCE_LONGUEUR_MIN = 3;
export const TIERCE_LONGUEUR_MAX = 5;

/**
 * Une carte telle qu'elle est posée sur la table.
 *
 * Un joker (ou le coucou) posé déclare la carte qu'il remplace. Cette
 * déclaration sert deux fois : elle rend possible l'échange décrit au
 * § « Récupération d'un joker posé », et elle donne au joker sa valeur au
 * moment du calcul des 51 points, un joker valant exactement la carte qu'il
 * remplace (§ « Conditions pour poser »). Elle doit donc être renseignée à la
 * pose, sauf lorsque la combinaison ne laisse qu'une lecture possible.
 */
export interface CartePosee {
  readonly carte: Carte;
  /** Carte réellement représentée, uniquement pour un joker ou le coucou. */
  readonly remplace: { readonly couleur: Couleur; readonly valeur: Valeur } | null;
}

interface CombinaisonBase {
  readonly id: CombinaisonId;
  /** Joueur qui a posé la combinaison (§ « Fin d'un coup et scoring », double / triple). */
  readonly proprietaireId: JoueurId;
  readonly cartes: readonly CartePosee[];
}

/** Suite de 3 à 5 cartes consécutives de la même couleur. */
export interface Tierce extends CombinaisonBase {
  readonly type: 'tierce';
  readonly couleur: Couleur;
  /**
   * Cache de `estTiercePure()` figé au moment de la pose : aucun joker ni
   * coucou dans la combinaison. La fonction du moteur reste la référence.
   */
  readonly pure: boolean;
}

/** Brelan (3 cartes) ou carré (4 cartes) de même valeur, couleurs différentes. */
export interface Ensemble extends CombinaisonBase {
  readonly type: 'brelan' | 'carre';
  readonly valeur: Valeur;
  /** Aucun joker ni coucou dans la combinaison. */
  readonly pure: boolean;
}

export type Combinaison = Tierce | Ensemble;
