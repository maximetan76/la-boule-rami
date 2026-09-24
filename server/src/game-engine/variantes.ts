/**
 * Ce qui change d'une variante à l'autre, en un seul endroit.
 *
 * Réf. docs/REGLES.md § « Le panier ». Le moteur est celui de La Boule : la
 * validité des combinaisons, le tour, la parole et la fin de coup sont les
 * mêmes. Seuls les points listés ici diffèrent, et chaque règle du moteur les
 * lit plutôt que de supposer La Boule.
 */
import type { Variante } from '../models/index.js';

export interface ReglesDeVariante {
  /** Jokers du paquet. Le panier n'en met que deux, un par joueur. */
  readonly jokersDuPaquet: number;
  /** Le coucou n'existe pas au panier. */
  readonly avecCoucou: boolean;
  /** Un joker donné d'office à chacun : le talon n'en contient alors aucun. */
  readonly jokerParJoueur: boolean;
  /**
   * La carte prise à la défausse se garde librement. À La Boule, elle doit
   * servir dans la foulée, et ni les brelans posés ni les cartes collantes ne
   * l'acceptent.
   */
  readonly priseDefausseLibre: boolean;
  /**
   * On ne pose qu'en finissant : toute la main d'un coup, puis la dernière
   * carte à la défausse. Aucune pose partielle, aucun ajout.
   */
  readonly poseSeulementPourFinir: boolean;
  /**
   * La parole ne fait qu'un tour : chacun répond une fois, puis on joue
   * jusqu'à la fin du coup. À La Boule, l'engagé est interrogé à chaque fois
   * que son tour revient tant que personne n'a posé.
   */
  readonly parolePremierTourSeulement: boolean;
  /** À La Boule, une friche générale laisse à chacun ses jokers. */
  readonly conserverLesJokersARedistribution: boolean;
  /** Le match se compte en manches gagnées, pas en points. */
  readonly matchEnManches: boolean;
}

const BOULE: ReglesDeVariante = {
  jokersDuPaquet: 4,
  avecCoucou: true,
  jokerParJoueur: false,
  priseDefausseLibre: false,
  poseSeulementPourFinir: false,
  parolePremierTourSeulement: false,
  conserverLesJokersARedistribution: true,
  matchEnManches: false,
};

const PANIER: ReglesDeVariante = {
  jokersDuPaquet: 2,
  avecCoucou: false,
  jokerParJoueur: true,
  priseDefausseLibre: true,
  poseSeulementPourFinir: true,
  parolePremierTourSeulement: true,
  conserverLesJokersARedistribution: false,
  matchEnManches: true,
};

export const REGLES_PAR_VARIANTE: Readonly<Record<Variante, ReglesDeVariante>> = {
  boule: BOULE,
  panier: PANIER,
};

/** Les règles en vigueur. Sans variante dite, celles de La Boule. */
export const reglesDe = (variante: Variante | undefined): ReglesDeVariante =>
  REGLES_PAR_VARIANTE[variante ?? 'boule'];
