/**
 * Port de persistance.
 *
 * Le serveur ne connaît que cette interface : l'implémentation PostgreSQL et
 * celle en mémoire sont interchangeables, ce qui permet de tester la logique de
 * sauvegarde et de rechargement sans base.
 */
import type { JoueurId } from '../models/index.js';
import type { EtatBoulePersiste } from './serialisation.js';

/** Sort d'un tour entamé par un joueur qui se déconnecte. */
export type GestionDeconnexion =
  | { readonly type: 'delai'; readonly dureeMs: number }
  | { readonly type: 'illimite' };

export const DELAI_DECONNEXION_PAR_DEFAUT_MS = 90_000;

/**
 * Délais de jeu d'une table, en millisecondes ; `null` : illimité.
 *
 * Contrairement à la gestion de déconnexion, ils valent pour tous les joueurs,
 * présents ou non.
 */
export interface DelaisDeJeu {
  /** Pour dire « Friche » ou « Je joue » : au-delà, friche d'office. */
  readonly annonceMs: number | null;
  /** Pour jouer son tour, pioche comprise : au-delà, le serveur pioche et défausse. */
  readonly jeuMs: number | null;
  /** Accordé une fois de plus à qui a commencé à composer une pose ; 0 : aucun. */
  readonly prolongationMs: number | null;
}

/** Aucun délai : une table créée sans en préciser, hors API. */
export const DELAIS_ILLIMITES: DelaisDeJeu = { annonceMs: null, jeuMs: null, prolongationMs: null };

/** Les délais d'une table créée par l'API sans en préciser. */
export const DELAIS_PAR_DEFAUT: DelaisDeJeu = { annonceMs: 60_000, jeuMs: 120_000, prolongationMs: 60_000 };

export interface JoueurEnregistre {
  readonly id: JoueurId;
  readonly identifiantApple: string;
  readonly pseudo: string;
  readonly creeLe: Date;
}

/** Pourquoi une partie s'est arrêtée. */
export type MotifFin = 'abandon' | 'achevee';

export interface PartieEnregistree {
  readonly id: string;
  readonly codeInvitation: string;
  readonly createurId: JoueurId;
  readonly capacite: number;
  readonly demarree: boolean;
  readonly gestionDeconnexion: GestionDeconnexion;
  readonly delais: DelaisDeJeu;
  readonly joueursIds: JoueurId[];
  readonly creeeLe: Date;
  readonly termineeLe: Date | null;
  readonly motifFin: MotifFin | null;
}

export interface NouvellePartie {
  readonly id: string;
  readonly codeInvitation: string;
  readonly createurId: JoueurId;
  readonly capacite: number;
  readonly gestionDeconnexion: GestionDeconnexion;
  readonly delais: DelaisDeJeu;
}

/** Une partie en cours, avec l'état de sa Boule, tel qu'il revient de la base. */
export interface PartieRechargee {
  readonly partie: PartieEnregistree;
  /** Joueurs assis, dans l'ordre de la table figé au tirage d'ouverture. */
  readonly joueurs: { readonly id: JoueurId; readonly pseudo: string }[];
  readonly etatBoule: EtatBoulePersiste | null;
}

export interface Depot {
  /** Retrouve le joueur derrière un identifiant Apple, ou l'inscrit. */
  trouverOuCreerJoueurApple(identifiantApple: string, pseudo: string): Promise<JoueurEnregistre>;
  trouverJoueur(id: JoueurId): Promise<JoueurEnregistre | null>;
  renommerJoueur(id: JoueurId, pseudo: string): Promise<JoueurEnregistre>;

  creerPartie(partie: NouvellePartie): Promise<PartieEnregistree>;
  trouverPartieParCode(codeInvitation: string): Promise<PartieEnregistree | null>;
  /** Partie non terminée à laquelle le joueur est inscrit, s'il y en a une. */
  partieActiveDuJoueur(joueurId: JoueurId): Promise<PartieEnregistree | null>;
  /**
   * Dernière partie du joueur, terminée ou non. C'est elle qui permet de lui
   * dire, à son retour, que sa partie a été abandonnée en son absence.
   */
  dernierePartieDuJoueur(joueurId: JoueurId): Promise<PartieEnregistree | null>;
  /** Toutes les parties du joueur, en cours ou terminées, la plus récente d'abord. */
  partiesDuJoueur(joueurId: JoueurId): Promise<PartieEnregistree[]>;
  asseoirJoueur(partieId: string, joueurId: JoueurId, position: number): Promise<void>;
  /**
   * Libère la place d'un joueur et renumérote celles qui restent, pour que la
   * position reste le rang du joueur dans le salon.
   */
  retirerJoueur(
    partieId: string,
    joueurId: JoueurId,
    placesRestantes: readonly JoueurId[],
  ): Promise<void>;
  /** Fige l'ordre de la table issu du tirage et marque la partie démarrée. */
  demarrerPartie(partieId: string, ordreTable: readonly JoueurId[]): Promise<void>;
  terminerPartie(id: string, motif: MotifFin): Promise<void>;

  /** Écrit l'état de la Boule d'une partie, en écrasant le précédent. */
  enregistrerBoule(partieId: string, etat: EtatBoulePersiste): Promise<void>;

  /** Parties non terminées, avec leur Boule, pour la reprise au démarrage. */
  chargerPartiesActives(): Promise<PartieRechargee[]>;
}
