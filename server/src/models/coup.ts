/**
 * État complet d'un coup (une donne) en cours.
 *
 * Réf. `docs/REGLES.md` § « Phase Friche / Je joue en début de coup »,
 * § « Déroulement d'un tour de jeu » et § « Règle spéciale : piocher la carte
 * de la défausse ».
 */
import type { Carte } from './carte.js';
import type { Combinaison } from './combinaison.js';
import type { JoueurId } from './joueur.js';

/** Annonce d'ouverture : « Friche » (je passe) ou « Je joue ». */
export type Annonce = 'friche' | 'je-joue';

export type PhaseCoup =
  /** Tour de parole friche / je joue, à partir de la gauche du donneur. */
  | 'annonces'
  /** Un joueur a annoncé « je joue » : le coup se déroule. */
  | 'jeu'
  /** Un joueur n'a plus de cartes en main. */
  | 'termine';

/**
 * Ce qu'un joueur a fait pendant le coup — nécessaire au scoring.
 *
 * Réf. § « Fin d'un coup et scoring » : le « double » exige d'avoir fini en
 * une seule fois et sans l'aide des combinaisons visibles des autres joueurs ;
 * un joueur n'ayant posé aucune carte marque 100 points fixes.
 */
export interface RecapJoueurCoup {
  /** Numéros de tour où le joueur a posé au moins une carte. */
  toursAvecPose: number[];
  /** Le joueur a ajouté au moins une carte sur une combinaison d'un adversaire. */
  aAjouteSurCombinaisonAutrui: boolean;
}

export interface Coup {
  /** Numéro du coup dans la Boule, à partir de 1. */
  readonly numero: number;
  readonly donneurId: JoueurId;
  /**
   * Joueurs assis pour ce coup, dans le sens du jeu. Le premier à parler puis
   * à jouer est celui à la gauche du donneur (§ « Phase Friche / Je joue »).
   */
  readonly ordreJoueurs: JoueurId[];
  /** À 5 ou 6 joueurs, les 2 joueurs « sur le côté » qui ne jouent pas ce coup. */
  readonly joueursSurLeCote: JoueurId[];
  phase: PhaseCoup;
  /** Annonces déjà faites pendant la phase d'ouverture. */
  annonces: Record<JoueurId, Annonce>;
  /** Talon face cachée : ne doit jamais être transmis à un client. */
  pioche: Carte[];
  /**
   * Défausse complète, la dernière carte étant le sommet. Seul ce sommet est
   * piochable ; l'historique sert à retracer un coup (§ « Règle spéciale »).
   */
  defausse: Carte[];
  /** Combinaisons face visible, tous joueurs confondus. */
  combinaisons: Combinaison[];
  joueurActifId: JoueurId;
  /** Numéro du tour de table en cours, à partir de 1. */
  numeroTour: number;
  /** Coup « friché d'office » : points doublés (§ « Structure d'une Boule »). */
  readonly estFriche: boolean;
  recapitulatifs: Record<JoueurId, RecapJoueurCoup>;
  gagnantId: JoueurId | null;
}
