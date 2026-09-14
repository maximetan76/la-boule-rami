/**
 * Dépôt PostgreSQL, via Prisma.
 *
 * Couche de traduction uniquement : aucune règle de jeu ici. L'état d'une Boule
 * y entre et en sort sous la forme validée par `serialisation.ts`.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  AbandonEnregistre,
  CoupInterrompu,
  Depot,
  GestionDeconnexion,
  JoueurEnregistre,
  MotifFin,
  NouvellePartie,
  PartieEnregistree,
  PartieRechargee,
} from './depot.js';
import { deserialiserBoule, serialiserBoule, type EtatBoulePersiste } from './serialisation.js';
import type { JoueurId } from '../models/index.js';

/** Forme d'une partie telle que Prisma la rend, places comprises. */
interface LignePartie {
  id: string;
  codeInvitation: string;
  createurId: string;
  capacite: number;
  demarree: boolean;
  gestionDeconnexionType: string;
  gestionDeconnexionDureeMs: number;
  creeeLe: Date;
  termineeLe: Date | null;
  motifFin: string | null;
  delaiAnnonceMs: number | null;
  delaiJeuMs: number | null;
  delaiProlongationMs: number | null;
  coupsFrichesDepart: number;
  valeurPoint: string | null;
  nombreCoups: number | null;
  abandonneParId: string | null;
  interruption: unknown;
  joueurs?: { joueurId: string; position: number }[];
}

const relireGestion = (type: string, dureeMs: number): GestionDeconnexion =>
  type === 'illimite' ? { type: 'illimite' } : { type: 'delai', dureeMs };

/**
 * L'abandon enregistré, s'il y en a un. Le coup interrompu est une archive :
 * aucune règle n'en dépend, il est repris tel que le serveur l'a écrit.
 */
const relireAbandon = (parJoueurId: string | null | undefined, interruption: unknown): AbandonEnregistre | null => {
  if (typeof parJoueurId !== 'string' || typeof interruption !== 'object' || interruption === null) return null;
  const brut = interruption as { le?: unknown; coupInterrompu?: unknown };
  if (typeof brut.le !== 'string' || typeof brut.coupInterrompu !== 'object' || brut.coupInterrompu === null) {
    return null;
  }
  return { parJoueurId, le: new Date(brut.le), coupInterrompu: brut.coupInterrompu as CoupInterrompu };
};

const versPartie = (ligne: LignePartie): PartieEnregistree => ({
  id: ligne.id,
  codeInvitation: ligne.codeInvitation,
  createurId: ligne.createurId,
  capacite: ligne.capacite,
  demarree: ligne.demarree,
  gestionDeconnexion: relireGestion(ligne.gestionDeconnexionType, ligne.gestionDeconnexionDureeMs),
  delais: {
    annonceMs: ligne.delaiAnnonceMs,
    jeuMs: ligne.delaiJeuMs,
    prolongationMs: ligne.delaiProlongationMs,
  },
  coupsFrichesDepart: ligne.coupsFrichesDepart,
  valeurPoint: ligne.valeurPoint,
  nombreCoups: ligne.nombreCoups,
  abandon: relireAbandon(ligne.abandonneParId, ligne.interruption),
  // Les places ne sont là que si l'appel a demandé l'inclusion ; une partie
  // tout juste créée n'en a de toute façon aucune.
  joueursIds: [...(ligne.joueurs ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((place) => place.joueurId),
  creeeLe: ligne.creeeLe,
  termineeLe: ligne.termineeLe,
  motifFin: ligne.motifFin === 'abandon' || ligne.motifFin === 'achevee' ? ligne.motifFin : null,
});

const PLACES = { joueurs: { select: { joueurId: true, position: true } } } as const;

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

  async renommerJoueur(id: JoueurId, pseudo: string): Promise<JoueurEnregistre> {
    return this.prisma.joueur.update({ where: { id }, data: { pseudo } });
  }

  async creerPartie(partie: NouvellePartie): Promise<PartieEnregistree> {
    const ligne = await this.prisma.partie.create({
      data: {
        id: partie.id,
        codeInvitation: partie.codeInvitation,
        createurId: partie.createurId,
        capacite: partie.capacite,
        gestionDeconnexionType: partie.gestionDeconnexion.type,
        gestionDeconnexionDureeMs:
          partie.gestionDeconnexion.type === 'delai' ? partie.gestionDeconnexion.dureeMs : 0,
        delaiAnnonceMs: partie.delais.annonceMs,
        delaiJeuMs: partie.delais.jeuMs,
        delaiProlongationMs: partie.delais.prolongationMs,
        coupsFrichesDepart: partie.coupsFrichesDepart,
        valeurPoint: partie.valeurPoint,
        nombreCoups: partie.nombreCoups,
      },
      include: PLACES,
    });
    return versPartie(ligne as LignePartie);
  }

  async trouverPartieParCode(codeInvitation: string): Promise<PartieEnregistree | null> {
    const ligne = await this.prisma.partie.findUnique({
      where: { codeInvitation },
      include: PLACES,
    });
    return ligne === null ? null : versPartie(ligne as LignePartie);
  }

  async partieActiveDuJoueur(joueurId: JoueurId): Promise<PartieEnregistree | null> {
    const ligne = await this.prisma.partie.findFirst({
      where: { termineeLe: null, joueurs: { some: { joueurId } } },
      include: PLACES,
    });
    return ligne === null ? null : versPartie(ligne as LignePartie);
  }

  async dernierePartieDuJoueur(joueurId: JoueurId): Promise<PartieEnregistree | null> {
    const ligne = await this.prisma.partie.findFirst({
      where: { joueurs: { some: { joueurId } } },
      orderBy: { creeeLe: 'desc' },
      include: PLACES,
    });
    return ligne === null ? null : versPartie(ligne as LignePartie);
  }

  async partiesDuJoueur(joueurId: JoueurId): Promise<PartieEnregistree[]> {
    const lignes = await this.prisma.partie.findMany({
      where: { joueurs: { some: { joueurId } } },
      orderBy: { creeeLe: 'desc' },
      include: PLACES,
    });
    return lignes.map((ligne) => versPartie(ligne as LignePartie));
  }

  async asseoirJoueur(partieId: string, joueurId: JoueurId, position: number): Promise<void> {
    await this.prisma.joueurSurPartie.create({ data: { partieId, joueurId, position } });
  }

  /**
   * Libère une place et renumérote les autres, en une seule transaction : un
   * salon ne doit jamais laisser voir deux joueurs au même rang.
   */
  async retirerJoueur(
    partieId: string,
    joueurId: JoueurId,
    placesRestantes: readonly JoueurId[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.joueurSurPartie.delete({
        where: { partieId_joueurId: { partieId, joueurId } },
      }),
      ...placesRestantes.map((restant, position) =>
        this.prisma.joueurSurPartie.update({
          where: { partieId_joueurId: { partieId, joueurId: restant } },
          data: { position },
        }),
      ),
    ]);
  }

  /**
   * Fige l'ordre issu du tirage d'ouverture : les places sont réécrites dans
   * cet ordre, qui devient celui de la table pour toute la partie.
   */
  async demarrerPartie(partieId: string, ordreTable: readonly JoueurId[]): Promise<void> {
    await this.prisma.$transaction([
      ...ordreTable.map((joueurId, position) =>
        this.prisma.joueurSurPartie.update({
          where: { partieId_joueurId: { partieId, joueurId } },
          data: { position },
        }),
      ),
      this.prisma.partie.update({ where: { id: partieId }, data: { demarree: true } }),
    ]);
  }

  async terminerPartie(id: string, motif: MotifFin, abandon?: AbandonEnregistre): Promise<void> {
    await this.prisma.partie.update({
      where: { id },
      data: {
        termineeLe: new Date(),
        motifFin: motif,
        ...(abandon === undefined
          ? {}
          : {
              abandonneParId: abandon.parJoueurId,
              interruption: {
                le: abandon.le.toISOString(),
                coupInterrompu: abandon.coupInterrompu,
              } as unknown as Prisma.InputJsonValue,
            }),
      },
    });
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
      partie: versPartie(partie as unknown as LignePartie),
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

  async chargerArchive(partieId: string): Promise<PartieRechargee | null> {
    const partie = await this.prisma.partie.findUnique({
      where: { id: partieId },
      include: {
        boule: true,
        joueurs: { include: { joueur: true }, orderBy: { position: 'asc' } },
      },
    });
    if (partie === null) return null;

    return {
      partie: versPartie(partie as unknown as LignePartie),
      joueurs: partie.joueurs.map((place) => ({ id: place.joueur.id, pseudo: place.joueur.pseudo })),
      etatBoule: partie.boule === null ? null : serialiserBoule(deserialiserBoule(partie.boule.etat)),
    };
  }
}
