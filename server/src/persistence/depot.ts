/**
 * Port de persistance.
 *
 * Le serveur ne connaît que cette interface : l'implémentation PostgreSQL et
 * celle en mémoire sont interchangeables, ce qui permet de tester la logique de
 * sauvegarde et de rechargement sans base.
 */
import type { Carte, Combinaison, JoueurId, MatchPanier, Variante } from '../models/index.js';
import type { EtatBoulePersiste, EtatPanierPersiste } from './serialisation.js';

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

/**
 * Les délais d'une table créée par l'API sans en préciser : illimités. Rien ne
 * presse personne — ni friche ni défausse d'office — tant que le créateur n'a
 * pas choisi de délai.
 */
export const DELAIS_PAR_DEFAUT: DelaisDeJeu = DELAIS_ILLIMITES;

export interface JoueurEnregistre {
  readonly id: JoueurId;
  readonly identifiantApple: string;
  readonly pseudo: string;
  /**
   * Le joueur a choisi lui-même son pseudo. Absent d'un compte d'avant ce
   * champ : il vaut alors comme choisi.
   */
  readonly pseudoChoisi?: boolean;
  readonly creeLe: Date;
  /** Renseignée pour un compte supprimé : plus aucune session ne l'ouvre. */
  readonly supprimeLe?: Date | null;
}

/** Le pseudo d'un compte supprimé, tel que le voient les autres joueurs. */
export const PSEUDO_COMPTE_SUPPRIME = 'Joueur supprimé';

/** Pourquoi une partie s'est arrêtée. */
export type MotifFin = 'abandon' | 'achevee';

/**
 * Ce qu'était la table à l'instant d'un abandon. Une archive : aucune règle
 * n'en dépend, tout y est révélé, mains comprises.
 */
export interface CoupInterrompu {
  /** Le coup en cours à l'abandon ; `null` entre deux coups. */
  readonly numero: number | null;
  readonly coupsJoues: number;
  readonly nombreCoupsTotal: number;
  readonly nombreCoupsFriches: number;
  readonly scoresCumules: Record<JoueurId, number>;
  readonly croix: Record<JoueurId, number>;
  /** Les cartes en main de chaque joueur à cet instant, carte piochée comprise. */
  readonly mains: Record<JoueurId, Carte[]>;
  /** Les combinaisons sur la table à cet instant. */
  readonly combinaisons: Combinaison[];
}

/** Qui a abandonné, quand, et le coup interrompu. */
export interface AbandonEnregistre {
  readonly parJoueurId: JoueurId;
  readonly le: Date;
  readonly coupInterrompu: CoupInterrompu;
}

export interface PartieEnregistree {
  readonly id: string;
  readonly codeInvitation: string;
  readonly createurId: JoueurId;
  readonly capacite: number;
  readonly demarree: boolean;
  readonly gestionDeconnexion: GestionDeconnexion;
  readonly delais: DelaisDeJeu;
  /** Le jeu joué à cette table ; absente d'une partie antérieure : La Boule. */
  readonly variante?: Variante;
  /** Panier seulement : manches à gagner et montant empoché par le vainqueur. */
  readonly manchesAGagner?: number | null;
  readonly montant?: number | null;
  /** Coups frichés choisis à la création. */
  readonly coupsFrichesDepart: number;
  /** Base du report en cascade, transmise de Boule rejouée en Boule rejouée ; absente : le départ. */
  readonly coupsFrichesConfigures?: number | null;
  /** Report reçu au-delà du nombre de coups, gardé pour la Boule suivante. */
  readonly excedentDeFriches?: number;
  /** Valeur d'un point, décimal normalisé ; `null` : aucune. */
  readonly valeurPoint: string | null;
  /** Nombre de coups choisi à la création ; `null` : celui des règles. */
  readonly nombreCoups: number | null;
  readonly joueursIds: JoueurId[];
  readonly creeeLe: Date;
  /** Démarrage de la partie ; absent d'une partie jamais démarrée, ou démarrée avant ce suivi. */
  readonly demarreeLe?: Date | null;
  readonly termineeLe: Date | null;
  readonly motifFin: MotifFin | null;
  /** Renseigné pour une partie abandonnée par un joueur. */
  readonly abandon: AbandonEnregistre | null;
}

export interface NouvellePartie {
  readonly id: string;
  readonly codeInvitation: string;
  readonly createurId: JoueurId;
  readonly capacite: number;
  readonly gestionDeconnexion: GestionDeconnexion;
  readonly delais: DelaisDeJeu;
  readonly coupsFrichesDepart: number;
  readonly coupsFrichesConfigures?: number;
  readonly excedentDeFriches?: number;
  readonly valeurPoint: string | null;
  readonly nombreCoups: number | null;
  readonly variante: Variante;
  readonly manchesAGagner?: number;
  readonly montant?: number;
}

/** Une partie en cours, avec l'état de sa Boule, tel qu'il revient de la base. */
export interface PartieRechargee {
  readonly partie: PartieEnregistree;
  /** Joueurs assis, dans l'ordre de la table figé au tirage d'ouverture. */
  readonly joueurs: { readonly id: JoueurId; readonly pseudo: string; readonly pseudoChoisi?: boolean }[];
  readonly etatBoule: EtatBoulePersiste | null;
  /** Panier seulement. */
  readonly etatPanier: EtatPanierPersiste | null;
}

export interface Depot {
  /** Retrouve le joueur derrière un identifiant Apple, ou l'inscrit. */
  /**
   * `pseudoChoisi` : vrai pour un compte dont le nom est déjà fixé à la
   * création — le compte de démonstration et ses robots.
   */
  trouverOuCreerJoueurApple(
    identifiantApple: string,
    pseudo: string,
    options?: { readonly pseudoChoisi?: boolean },
  ): Promise<JoueurEnregistre>;
  trouverJoueur(id: JoueurId): Promise<JoueurEnregistre | null>;
  renommerJoueur(id: JoueurId, pseudo: string): Promise<JoueurEnregistre>;
  /**
   * Anonymise un compte : l'identifiant Apple est remplacé — une prochaine
   * connexion Apple crée un nouveau compte —, le pseudo aussi, et le compte
   * est daté comme supprimé. Ses places aux parties sont conservées : les
   * archives partagées restent lisibles par les autres joueurs.
   */
  anonymiserJoueur(id: JoueurId, identifiantRemplacant: string): Promise<JoueurEnregistre>;

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
  /**
   * Le temps de jeu de chacun, partie par partie, lu dans l'état des Boules
   * en une seule fois. Une partie sans mesure n'y figure pas.
   */
  tempsDeJeuDesParties(partieIds: readonly string[]): Promise<Record<string, Record<JoueurId, number>>>;
  /**
   * Le match des parties du panier données : manches gagnées, cible, montant,
   * vainqueur. Une partie de La Boule n'y figure pas.
   */
  matchsDesPaniers(partieIds: readonly string[]): Promise<Record<string, MatchPanier>>;
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
  /** `abandon` : pour un abandon décidé par un joueur, ce qu'il faut en archiver. */
  terminerPartie(id: string, motif: MotifFin, abandon?: AbandonEnregistre): Promise<void>;
  /**
   * Supprime la partie de la base, places et Boule comprises, sans rien en
   * archiver. Réservé aux tables où rien ne s'est joué : voir
   * `GameRoomManager.nettoyerTablesInactives`. Sans effet si elle n'existe plus.
   */
  supprimerPartie(id: string): Promise<void>;

  /** Écrit l'état de la Boule d'une partie, en écrasant le précédent. */
  enregistrerBoule(partieId: string, etat: EtatBoulePersiste): Promise<void>;
  /** Panier seulement. */
  enregistrerMatchPanier(partieId: string, etat: EtatPanierPersiste): Promise<void>;

  /** Parties non terminées, avec leur Boule, pour la reprise au démarrage. */
  chargerPartiesActives(): Promise<PartieRechargee[]>;

  /** Une partie avec sa Boule, terminée ou non : l'archive d'une partie close. */
  chargerArchive(partieId: string): Promise<PartieRechargee | null>;
}
