/**
 * Port de persistance.
 *
 * Le serveur ne connaît que cette interface : l'implémentation PostgreSQL et
 * celle en mémoire sont interchangeables, ce qui permet de tester la logique de
 * sauvegarde et de rechargement sans base.
 */
import type { JoueurId } from '../models/index.js';
import type { EtatBoulePersiste } from './serialisation.js';

export interface JoueurEnregistre {
  readonly id: JoueurId;
  readonly identifiantApple: string;
  readonly pseudo: string;
  readonly creeLe: Date;
}

export interface PartieEnregistree {
  readonly id: string;
  readonly joueursIds: JoueurId[];
  readonly creeeLe: Date;
  readonly termineeLe: Date | null;
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

  creerPartie(id: string, joueursIds: readonly JoueurId[]): Promise<PartieEnregistree>;
  terminerPartie(id: string): Promise<void>;

  /** Écrit l'état de la Boule d'une partie, en écrasant le précédent. */
  enregistrerBoule(partieId: string, etat: EtatBoulePersiste): Promise<void>;

  /** Parties non terminées, avec leur Boule, pour la reprise au démarrage. */
  chargerPartiesActives(): Promise<PartieRechargee[]>;
}
