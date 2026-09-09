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
  asseoirJoueur(partieId: string, joueurId: JoueurId, position: number): Promise<void>;
  /** Fige l'ordre de la table issu du tirage et marque la partie démarrée. */
  demarrerPartie(partieId: string, ordreTable: readonly JoueurId[]): Promise<void>;
  terminerPartie(id: string, motif: MotifFin): Promise<void>;

  /** Écrit l'état de la Boule d'une partie, en écrasant le précédent. */
  enregistrerBoule(partieId: string, etat: EtatBoulePersiste): Promise<void>;

  /** Parties non terminées, avec leur Boule, pour la reprise au démarrage. */
  chargerPartiesActives(): Promise<PartieRechargee[]>;
}
