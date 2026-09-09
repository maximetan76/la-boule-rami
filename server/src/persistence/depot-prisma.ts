/**
 * Dépôt PostgreSQL, via Prisma.
 *
 * Couche de traduction uniquement : aucune règle de jeu ici. L'état d'une Boule
 * y entre et en sort sous la forme validée par `serialisation.ts`.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  Depot,
  JoueurEnregistre,
  PartieEnregistree,
  PartieRechargee,
} from './depot.js';
import { deserialiserBoule, serialiserBoule, type EtatBoulePersiste } from './serialisation.js';
import type { JoueurId } from '../models/index.js';

export class DepotPrisma implements Depot {
  constructor(private readonly prisma: PrismaClient) {}

  async trouverOuCreerJoueurApple(
    identifiantApple: string,
    pseudo: string,
  ): Promise<JoueurEnregistre> {
    const existant = await this.prisma.joueur.findUnique({ where: { identifiantApple } });
    if (existant !== null) return existant;

    return this.prisma.joueur.create({ data: { identifiantApple, pseudo } });
  }

  async trouverJoueur(id: JoueurId): Promise<JoueurEnregistre | null> {
    return this.prisma.joueur.findUnique({ where: { id } });
  }

  async creerPartie(id: string, joueursIds: readonly JoueurId[]): Promise<PartieEnregistree> {
    const partie = await this.prisma.partie.create({
      data: {
        id,
        joueurs: {
          create: joueursIds.map((joueurId, position) => ({ joueurId, position })),
        },
      },
    });

    return { id: partie.id, joueursIds: [...joueursIds], creeeLe: partie.creeeLe, termineeLe: null };
  }

  async terminerPartie(id: string): Promise<void> {
    await this.prisma.partie.update({ where: { id }, data: { termineeLe: new Date() } });
  }

  /**
   * Écrit l'état de la Boule. Un upsert plutôt qu'un insert : une partie n'a
   * qu'une Boule à la fois, et chaque fin de coup en écrase l'état précédent.
   */
  async enregistrerBoule(partieId: string, etat: EtatBoulePersiste): Promise<void> {
    // Prisma type la colonne Json par sa propre union ; l'état est un objet
    // JSON pur par construction, sa forme étant garantie par `serialiserBoule`.
    const document = etat as unknown as Prisma.InputJsonValue;
    await this.prisma.boule.upsert({
      where: { partieId },
      create: { partieId, etat: document },
      update: { etat: document },
    });
  }

  async chargerPartiesActives(): Promise<PartieRechargee[]> {
    const parties = await this.prisma.partie.findMany({
      where: { termineeLe: null },
      include: {
        boule: true,
        joueurs: { include: { joueur: true }, orderBy: { position: 'asc' } },
      },
    });

    return parties.map((partie) => ({
      partie: {
        id: partie.id,
        joueursIds: partie.joueurs.map((place) => place.joueurId),
        creeeLe: partie.creeeLe,
        termineeLe: partie.termineeLe,
      },
      joueurs: partie.joueurs.map((place) => ({
        id: place.joueur.id,
        pseudo: place.joueur.pseudo,
      })),
      // L'état relu de la base repasse par la validation avant d'être utilisé.
      etatBoule:
        partie.boule === null
          ? null
          : serialiserBoule(deserialiserBoule(partie.boule.etat)),
    }));
  }
}
