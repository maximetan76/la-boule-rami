/**
 * État complet d'un coup (une donne) en cours.
 *
 * Réf. `docs/REGLES.md` § « Phase Friche / Je joue en début de coup »,
 * § « Déroulement d'un tour de jeu » et § « Règle spéciale : piocher la carte
 * de la défausse ».
 */
import type { Variante } from './variante.js';
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
  /**
   * Le joueur a touché au jeu d'un adversaire ce coup-ci : une carte ajoutée à
   * sa combinaison, ou un joker qu'il y a repris. Le nom est resté celui du
   * premier cas ; le coup reste simple dans les deux (docs/REGLES.md § « Fin
   * d'un coup et scoring »).
   */
  aAjouteSurCombinaisonAutrui: boolean;
}

/**
 * Ce que le dernier tour joué a changé sur la table, tel que les autres
 * joueurs doivent le voir.
 *
 * Les bandeaux (« Bo a pris le 7♣ à la défausse », jokers repris, carré
 * fermé) et le souligné des cartes fraîchement posées se calculaient jusqu'ici
 * en comparant deux états reçus à la suite : un joueur qui se connecte après
 * coup, ou dont la connexion se rétablit, n'avait aucun état d'avant et ne
 * voyait rien. Le serveur le garde donc lui-même, jusqu'au premier geste du
 * joueur suivant — le délai qu'avaient déjà ces indications.
 *
 * Tout y est public : la table montre déjà chacun de ces éléments à tous.
 */
export interface DernierTour {
  /** Propre à ce tour : l'app s'en sert pour ne montrer qu'une fois ce qu'elle a déjà montré. */
  readonly id: string;
  /** Qui a joué ce tour. */
  readonly joueurId: JoueurId;
  /** La carte qu'il a prise à la défausse et gardée pour ce tour, s'il en a pris une. */
  readonly priseEnDefausse: Carte | null;
  /** Les jokers qu'il a repris sur la table, chacun avec la vraie carte donnée en échange. */
  readonly jokersRepris: readonly { readonly joker: Carte; readonly carteFournie: Carte }[];
  /** Les carrés que ce tour a fermés : quatre cartes réelles, sans joker ni coucou. */
  readonly carresFermes: readonly string[];
  /** Les cartes arrivées sur la table ce tour-ci, pour les souligner. */
  readonly cartesPosees: readonly string[];
}

export interface Coup {
  /** Numéro du coup dans la Boule, à partir de 1. */
  readonly numero: number;
  readonly donneurId: JoueurId;
  /**
   * Joueurs assis pour ce coup, dans l'ordre de jeu. Par convention
   * `ordreJoueurs[0]` est le joueur à la gauche du donneur, donc le premier à
   * parler puis à jouer (§ « Phase Friche / Je joue ») : un tour de table
   * complet ramène à cet indice et fait avancer `numeroTour`.
   */
  readonly ordreJoueurs: JoueurId[];
  /** À 5 ou 6 joueurs, les 2 joueurs « sur le côté » qui ne jouent pas ce coup. */
  readonly joueursSurLeCote: JoueurId[];
  phase: PhaseCoup;
  /** Annonces déjà faites pendant la phase d'ouverture. */
  annonces: Record<JoueurId, Annonce>;
  /**
   * Main de chaque joueur assis. Cachée : la main d'un joueur ne doit jamais
   * être transmise aux autres clients. Une main n'existe que le temps d'un
   * coup, elle appartient donc au coup et non au joueur.
   */
  mains: Record<JoueurId, Carte[]>;
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
  /**
   * Pendant les annonces, le joueur dont on attend « friche » ou « je joue ».
   * Réf. docs/REGLES.md § « Phase Friche / Je joue » : tant que personne n'a
   * posé, chacun parle à son tour avant de jouer.
   */
  aParler?: JoueurId | null;
  /**
   * Ceux qui ont friché et n'ont pas encore joué leur tour, dans l'ordre de
   * la table. Dès qu'un « je joue » est prononcé, ils jouent chacun le leur.
   */
  enAttente?: JoueurId[];
  /** La variante jouée. Absente : La Boule, comme avant. */
  variante?: Variante;
  /**
   * Le joueur « engagé » : le dernier à avoir dit « je joue », et le seul que
   * l'on interroge encore quand son tour revient. Il risque le chocolat.
   */
  engageId?: JoueurId | null;
  /**
   * Le dernier tour joué, tant que le joueur suivant n'a pas fait son premier
   * geste. Absent sinon, et quand ce tour n'a rien changé qui se montre.
   */
  dernierTour?: DernierTour;
}
