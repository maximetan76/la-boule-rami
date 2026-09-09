/**
 * Dépôt en mémoire : utilisé par les tests, et suffisant pour un serveur de
 * développement lancé sans base.
 */
import { randomUUID } from 'node:crypto';
import type { JoueurId } from '../models/index.js';
import type {
  Depot,
  JoueurEnregistre,
  NouvellePartie,
  PartieEnregistree,
  PartieRechargee,
} from './depot.js';
import type { EtatBoulePersiste } from './serialisation.js';

export class DepotMemoire implements Depot {
  private readonly joueurs = new Map<JoueurId, JoueurEnregistre>();
  private readonly parApple = new Map<string, JoueurId>();
  private readonly parties = new Map<string, PartieEnregistree>();
  private readonly boules = new Map<string, EtatBoulePersiste>();
  /** Compteur d'écritures de Boule, pour vérifier en test qu'on ne sauvegarde pas trop. */
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

  renommerJoueur(id: JoueurId, pseudo: string): Promise<JoueurEnregistre> {
    const joueur = this.joueurs.get(id);
    if (joueur === undefined) throw new Error(`Joueur ${id} introuvable`);

    const renomme: JoueurEnregistre = { ...joueur, pseudo };
    this.joueurs.set(id, renomme);
    return Promise.resolve(renomme);
  }

  creerPartie(partie: NouvellePartie): Promise<PartieEnregistree> {
    const enregistree: PartieEnregistree = {
      ...partie,
      demarree: false,
      joueursIds: [],
      creeeLe: new Date(),
      termineeLe: null,
    };
    this.parties.set(partie.id, enregistree);
    return Promise.resolve(enregistree);
  }

  trouverPartieParCode(codeInvitation: string): Promise<PartieEnregistree | null> {
    const trouvee = [...this.parties.values()].find(
      (partie) => partie.codeInvitation === codeInvitation,
    );
    return Promise.resolve(trouvee ?? null);
  }

  partieActiveDuJoueur(joueurId: JoueurId): Promise<PartieEnregistree | null> {
    const trouvee = [...this.parties.values()].find(
      (partie) => partie.termineeLe === null && partie.joueursIds.includes(joueurId),
    );
    return Promise.resolve(trouvee ?? null);
  }

  asseoirJoueur(partieId: string, joueurId: JoueurId, position: number): Promise<void> {
    const partie = this.parties.get(partieId);
    if (partie === undefined) throw new Error(`Partie ${partieId} introuvable`);

    const joueursIds = [...partie.joueursIds];
    joueursIds[position] = joueurId;
    this.parties.set(partieId, { ...partie, joueursIds });
    return Promise.resolve();
  }

  demarrerPartie(partieId: string, ordreTable: readonly JoueurId[]): Promise<void> {
    const partie = this.parties.get(partieId);
    if (partie === undefined) throw new Error(`Partie ${partieId} introuvable`);

    this.parties.set(partieId, { ...partie, demarree: true, joueursIds: [...ordreTable] });
    return Promise.resolve();
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
