/**
 * Dépôt en mémoire : utilisé par les tests, et suffisant pour un serveur de
 * développement lancé sans base.
 */
import { randomUUID } from 'node:crypto';
import type { JoueurId } from '../models/index.js';
import type {
  Depot,
  JoueurEnregistre,
  PartieEnregistree,
  PartieRechargee,
} from './depot.js';
import type { EtatBoulePersiste } from './serialisation.js';

export class DepotMemoire implements Depot {
  private readonly joueurs = new Map<JoueurId, JoueurEnregistre>();
  private readonly parApple = new Map<string, JoueurId>();
  private readonly parties = new Map<string, PartieEnregistree>();
  private readonly boules = new Map<string, EtatBoulePersiste>();
  /** Compteur d'écritures, pour vérifier en test qu'on ne sauvegarde pas trop. */
  ecritures = 0;

  trouverOuCreerJoueurApple(identifiantApple: string, pseudo: string): Promise<JoueurEnregistre> {
    const existant = this.parApple.get(identifiantApple);
    if (existant !== undefined) {
      return Promise.resolve(this.joueurs.get(existant) as JoueurEnregistre);
    }

    const joueur: JoueurEnregistre = {
      id: randomUUID(),
      identifiantApple,
      pseudo,
      creeLe: new Date(),
    };
    this.joueurs.set(joueur.id, joueur);
    this.parApple.set(identifiantApple, joueur.id);
    return Promise.resolve(joueur);
  }

  trouverJoueur(id: JoueurId): Promise<JoueurEnregistre | null> {
    return Promise.resolve(this.joueurs.get(id) ?? null);
  }

  creerPartie(id: string, joueursIds: readonly JoueurId[]): Promise<PartieEnregistree> {
    const partie: PartieEnregistree = {
      id,
      joueursIds: [...joueursIds],
      creeeLe: new Date(),
      termineeLe: null,
    };
    this.parties.set(id, partie);
    return Promise.resolve(partie);
  }

  terminerPartie(id: string): Promise<void> {
    const partie = this.parties.get(id);
    if (partie !== undefined) {
      this.parties.set(id, { ...partie, termineeLe: new Date() });
    }
    return Promise.resolve();
  }

  enregistrerBoule(partieId: string, etat: EtatBoulePersiste): Promise<void> {
    this.ecritures += 1;
    this.boules.set(partieId, etat);
    return Promise.resolve();
  }

  chargerPartiesActives(): Promise<PartieRechargee[]> {
    const actives = [...this.parties.values()]
      .filter((partie) => partie.termineeLe === null)
      .map((partie) => ({
        partie,
        joueurs: partie.joueursIds.map((id) => ({
          id,
          pseudo: this.joueurs.get(id)?.pseudo ?? id,
        })),
        etatBoule: this.boules.get(partie.id) ?? null,
      }));
    return Promise.resolve(actives);
  }

  /** Inscrit un joueur sans passer par Apple — utile aux tests et au développement. */
  inscrire(id: JoueurId, pseudo: string): JoueurEnregistre {
    const joueur: JoueurEnregistre = {
      id,
      identifiantApple: `local:${id}`,
      pseudo,
      creeLe: new Date(),
    };
    this.joueurs.set(id, joueur);
    this.parApple.set(joueur.identifiantApple, id);
    return joueur;
  }
}
