import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { secretDepuisTexte, signerJetonSession } from '../auth/session.js';
import { creerServeur, type Serveur } from '../server/index.js';
import { ouvrirTablePleine } from './aide-table.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { DepotPrisma } from '../persistence/depot-prisma.js';
import {
  deserialiserBoule,
  EtatIllisibleError,
  serialiserBoule,
  VERSION_ETAT_BOULE,
} from '../persistence/serialisation.js';
import { GameRoomManager } from '../server/game-room-manager.js';
import { enregistrerResultatCoup, initialiserBoule } from '../game-engine/index.js';
import { joueur } from './fixtures.js';
import type { PrismaClient } from '@prisma/client';
import type { Boule, ScoreCoup } from '../models/index.js';

const JOUEURS = [
  { id: 'p-ana', pseudo: 'Ana' },
  { id: 'p-bo', pseudo: 'Bo' },
  { id: 'p-cy', pseudo: 'Cy' },
];

/** La Boule d'une table dont la partie a demarre. */
const bouleDe = (table: { boule: Boule | null }): Boule => table.boule as Boule;

const score = (partiel: Partial<ScoreCoup> = {}): ScoreCoup => ({
  gagnantId: 'p-ana',
  typeVictoire: 'simple',
  estFriche: false,
  multiplicateur: 1,
  scores: { 'p-ana': -20, 'p-bo': 30, 'p-cy': 100 },
  croixGagnees: { 'p-ana': 2 },
  chocolatId: null,
  ...partiel,
});

/** Une Boule de deux coups joués, assise sur l'ordre de table donné. */
const bouleJouee = (ordreTable: readonly string[] = JOUEURS.map((j) => j.id)) => {
  let boule = initialiserBoule(ordreTable.map((id) => joueur(id)));
  boule = enregistrerResultatCoup(boule, 1, score());
  boule = enregistrerResultatCoup(boule, 2, score({ gagnantId: 'p-bo', typeVictoire: 'double' }));
  return boule;
};

describe('serialisation de la Boule', () => {
  it('conserve tout ce qui compte d une Boule en cours', () => {
    const boule = bouleJouee();
    const relue = deserialiserBoule(serialiserBoule(boule));

    expect(relue.ordreTable).toEqual(boule.ordreTable);
    expect(relue.nombreCoupsTotal).toBe(boule.nombreCoupsTotal);
    expect(relue.nombreCoupsFriches).toBe(boule.nombreCoupsFriches);
    expect(relue.scoresCumules).toEqual(boule.scoresCumules);
    expect(relue.croix).toEqual(boule.croix);
    expect(relue.historique).toEqual(boule.historique);
  });

  it('survit a un aller-retour par JSON', () => {
    const boule = bouleJouee();
    const relue = deserialiserBoule(JSON.parse(JSON.stringify(serialiserBoule(boule))));
    expect(relue.scoresCumules).toEqual(boule.scoresCumules);
  });

  it('ne persiste pas le coup en cours : il sera redistribue', () => {
    const etat = serialiserBoule(bouleJouee());
    expect(JSON.stringify(etat)).not.toContain('coupEnCours');
    expect(deserialiserBoule(etat).coupEnCours).toBeNull();
  });

  it('refuse un etat d une autre version', () => {
    const etat = { ...serialiserBoule(bouleJouee()), version: VERSION_ETAT_BOULE + 1 };
    expect(() => deserialiserBoule(etat)).toThrow(EtatIllisibleError);
  });

  it('refuse un etat malforme plutot que de laisser passer des donnees douteuses', () => {
    expect(() => deserialiserBoule(null)).toThrow(EtatIllisibleError);
    expect(() => deserialiserBoule('texte')).toThrow(EtatIllisibleError);
    expect(() => deserialiserBoule({ version: VERSION_ETAT_BOULE })).toThrow(EtatIllisibleError);

    const valide = serialiserBoule(bouleJouee());
    expect(() => deserialiserBoule({ ...valide, ordreTable: 'p-ana' })).toThrow(/ordreTable/);
    expect(() => deserialiserBoule({ ...valide, nombreCoupsTotal: 'huit' })).toThrow(
      /nombreCoupsTotal/,
    );
    expect(() => deserialiserBoule({ ...valide, scoresCumules: { 'p-ana': 'zero' } })).toThrow(
      /scoresCumules/,
    );
  });

  it('refuse un historique dont un coup est incoherent', () => {
    const valide = serialiserBoule(bouleJouee());
    const abime = {
      ...valide,
      historique: [{ ...valide.historique[0], typeVictoire: 'quadruple' }],
    };
    expect(() => deserialiserBoule(abime)).toThrow(/typeVictoire/);
  });
});

describe('GameRoomManager et persistance', () => {
  it('inscrit la partie en base a la creation de la table', async () => {
    const depot = new DepotMemoire();
    const manager = new GameRoomManager({ depot });

    const { tableId } = await ouvrirTablePleine(manager, JOUEURS);
    const actives = await depot.chargerPartiesActives();

    expect(actives).toHaveLength(1);
    expect(actives[0]?.partie.id).toBe(tableId);
    // L'ordre des sieges issu du tirage est celui qui part en base.
    expect(actives[0]?.partie.joueursIds).toEqual(
      manager.table(tableId).joueurs.map((joueur) => joueur.id),
    );
  });

  it('n ecrit rien tant qu aucun coup n est termine', async () => {
    const depot = new DepotMemoire();
    const manager = new GameRoomManager({ depot });
    await ouvrirTablePleine(manager, JOUEURS);

    expect(depot.ecritures).toBe(0);
  });

  it('recharge une partie en cours avec ses scores, ses croix et son historique', async () => {
    const depot = new DepotMemoire();
    for (const inscrit of JOUEURS) depot.inscrire(inscrit.id, inscrit.pseudo);

    const manager = new GameRoomManager({ depot });
    const { tableId } = await ouvrirTablePleine(manager, JOUEURS);
    const table = manager.table(tableId);
    // La Boule suit l'ordre de table issu du tirage d'ouverture.
    table.boule = bouleJouee(bouleDe(table).ordreTable);
    await manager.persister(table);

    // Un serveur redemarre : nouveau manager, meme depot.
    const apresRedemarrage = new GameRoomManager({ depot });
    const reprises = await apresRedemarrage.recharger();

    expect(reprises).toEqual([tableId]);
    const rechargee = apresRedemarrage.table(tableId);
    expect(bouleDe(rechargee).scoresCumules).toEqual(bouleDe(table).scoresCumules);
    expect(bouleDe(rechargee).croix).toEqual(bouleDe(table).croix);
    expect(bouleDe(rechargee).historique).toHaveLength(2);
    // Les sieges sont retrouves dans l'ordre du tirage, avec les bons pseudos.
    expect(bouleDe(rechargee).ordreTable).toEqual(bouleDe(table).ordreTable);
    expect(rechargee.joueurs.map((j) => j.id)).toEqual(table.joueurs.map((j) => j.id));
    expect(rechargee.joueurs.map((j) => j.nom)).toEqual(table.joueurs.map((j) => j.nom));
    // La configuration de deconnexion est relue avec la partie.
    expect(rechargee.gestionDeconnexion).toEqual(table.gestionDeconnexion);
    // Le coup en cours n'est pas restaure : il sera redistribue.
    expect(rechargee.coup).toBeNull();
  });

  it('ne recharge pas une partie terminee', async () => {
    const depot = new DepotMemoire();
    const manager = new GameRoomManager({ depot });
    const { tableId } = await ouvrirTablePleine(manager, JOUEURS);
    await manager.persister(manager.table(tableId));
    await manager.cloreLaPartie(manager.table(tableId));

    const apresRedemarrage = new GameRoomManager({ depot });
    expect(await apresRedemarrage.recharger()).toEqual([]);
  });

  it('fonctionne sans depot du tout', async () => {
    const manager = new GameRoomManager({});
    const { tableId } = await ouvrirTablePleine(manager, JOUEURS);

    await expect(manager.persister(manager.table(tableId))).resolves.toBeUndefined();
    expect(await manager.recharger()).toEqual([]);
  });
});

describe('DepotPrisma', () => {
  /** Client Prisma simulé : on observe les requêtes émises, sans base. */
  const clientSimule = () => {
    const appels: { operation: string; args: unknown }[] = [];
    const stub = {
      joueur: {
        findUnique: (args: unknown) => {
          appels.push({ operation: 'joueur.findUnique', args });
          return Promise.resolve(null);
        },
        create: (args: { data: { identifiantApple: string; pseudo: string } }) => {
          appels.push({ operation: 'joueur.create', args });
          return Promise.resolve({
            id: 'p-nouveau',
            identifiantApple: args.data.identifiantApple,
            pseudo: args.data.pseudo,
            creeLe: new Date(),
          });
        },
      },
      partie: {
        findUnique: (args: unknown) => {
          appels.push({ operation: 'partie.findUnique', args });
          return Promise.resolve(null);
        },
        findFirst: (args: unknown) => {
          appels.push({ operation: 'partie.findFirst', args });
          return Promise.resolve(null);
        },
        create: (args: unknown) => {
          appels.push({ operation: 'partie.create', args });
          return Promise.resolve({
            id: 'partie-1',
            codeInvitation: 'ABCDEF',
            createurId: 'p-cy',
            capacite: 3,
            demarree: false,
            gestionDeconnexionType: 'delai',
            gestionDeconnexionDureeMs: 90000,
            creeeLe: new Date(),
            termineeLe: null,
            joueurs: [],
          });
        },
        update: (args: unknown) => {
          appels.push({ operation: 'partie.update', args });
          return Promise.resolve({});
        },
        findMany: (args: unknown) => {
          appels.push({ operation: 'partie.findMany', args });
          return Promise.resolve([
            {
              id: 'partie-1',
              codeInvitation: 'ABCDEF',
              createurId: 'p-ana',
              capacite: 3,
              demarree: true,
              gestionDeconnexionType: 'illimite',
              gestionDeconnexionDureeMs: 0,
              creeeLe: new Date(),
              termineeLe: null,
              boule: { etat: serialiserBoule(bouleJouee()) },
              joueurs: [
                { joueurId: 'p-ana', position: 0, joueur: { id: 'p-ana', pseudo: 'Ana' } },
                { joueurId: 'p-bo', position: 1, joueur: { id: 'p-bo', pseudo: 'Bo' } },
                { joueurId: 'p-cy', position: 2, joueur: { id: 'p-cy', pseudo: 'Cy' } },
              ],
            },
          ]);
        },
      },
      joueurSurPartie: {
        create: (args: unknown) => {
          appels.push({ operation: 'joueurSurPartie.create', args });
          return Promise.resolve({});
        },
        update: (args: unknown) => {
          appels.push({ operation: 'joueurSurPartie.update', args });
          return Promise.resolve({});
        },
      },
      $transaction: (operations: unknown[]) => Promise.resolve(operations),
      boule: {
        upsert: (args: unknown) => {
          appels.push({ operation: 'boule.upsert', args });
          return Promise.resolve({});
        },
      },
    };
    return { appels, prisma: stub as unknown as PrismaClient };
  };

  it('cree le joueur quand aucun compte Apple ne correspond', async () => {
    const { appels, prisma } = clientSimule();
    const joueurCree = await new DepotPrisma(prisma).trouverOuCreerJoueurApple('001.abc', 'Ana');

    expect(appels[0]?.operation).toBe('joueur.findUnique');
    expect(appels[1]).toEqual({
      operation: 'joueur.create',
      args: { data: { identifiantApple: '001.abc', pseudo: 'Ana' } },
    });
    expect(joueurCree.pseudo).toBe('Ana');
  });

  it('enregistre le salon avec son code et sa configuration', async () => {
    const { appels, prisma } = clientSimule();
    await new DepotPrisma(prisma).creerPartie({
      id: 'partie-1',
      codeInvitation: 'ABCDEF',
      createurId: 'p-cy',
      capacite: 3,
      gestionDeconnexion: { type: 'delai', dureeMs: 90000 },
      delais: { annonceMs: 60000, jeuMs: null, prolongationMs: 0 },
      coupsFrichesDepart: 3,
    });

    expect(appels[0]?.args).toMatchObject({
      data: {
        id: 'partie-1',
        codeInvitation: 'ABCDEF',
        createurId: 'p-cy',
        capacite: 3,
        gestionDeconnexionType: 'delai',
        gestionDeconnexionDureeMs: 90000,
        // Illimité s'écrit NULL, aucune prolongation 0.
        delaiAnnonceMs: 60000,
        delaiJeuMs: null,
        delaiProlongationMs: 0,
        coupsFrichesDepart: 3,
      },
    });
  });

  it('enregistre qui a abandonne et le coup interrompu', async () => {
    const { appels, prisma } = clientSimule();
    const le = new Date('2026-09-13T10:00:00.000Z');
    await new DepotPrisma(prisma).terminerPartie('partie-1', 'abandon', {
      parJoueurId: 'p-bo',
      le,
      coupInterrompu: {
        numero: 3,
        coupsJoues: 2,
        nombreCoupsTotal: 8,
        nombreCoupsFriches: 2,
        scoresCumules: { 'p-ana': 40, 'p-bo': -20 },
        croix: {},
        mains: {},
        combinaisons: [],
      },
    });

    expect(appels[0]?.args).toMatchObject({
      where: { id: 'partie-1' },
      data: {
        motifFin: 'abandon',
        abandonneParId: 'p-bo',
        interruption: { le: '2026-09-13T10:00:00.000Z', coupInterrompu: { numero: 3, coupsJoues: 2 } },
      },
    });
  });

  it('assied un joueur a une place precise', async () => {
    const { appels, prisma } = clientSimule();
    await new DepotPrisma(prisma).asseoirJoueur('partie-1', 'p-ana', 2);

    expect(appels[0]).toEqual({
      operation: 'joueurSurPartie.create',
      args: { data: { partieId: 'partie-1', joueurId: 'p-ana', position: 2 } },
    });
  });

  it('ecrase l etat precedent plutot que d empiler les Boules', async () => {
    const { appels, prisma } = clientSimule();
    const etat = serialiserBoule(bouleJouee());
    await new DepotPrisma(prisma).enregistrerBoule('partie-1', etat);

    const args = appels[0]?.args as { where: unknown; create: unknown; update: unknown };
    expect(appels[0]?.operation).toBe('boule.upsert');
    expect(args.where).toEqual({ partieId: 'partie-1' });
    expect(args.update).toEqual({ etat });
  });

  it('ne charge que les parties non terminees, et valide l etat relu', async () => {
    const { appels, prisma } = clientSimule();
    const actives = await new DepotPrisma(prisma).chargerPartiesActives();

    const args = appels[0]?.args as { where: unknown };
    expect(args.where).toEqual({ termineeLe: null });
    expect(actives).toHaveLength(1);
    expect(actives[0]?.joueurs.map((j) => j.pseudo)).toEqual(['Ana', 'Bo', 'Cy']);
    expect(actives[0]?.etatBoule?.historique).toHaveLength(2);
    // La configuration de deconnexion revient telle qu'elle a ete choisie.
    expect(actives[0]?.partie.gestionDeconnexion).toEqual({ type: 'illimite' });
    expect(actives[0]?.partie.codeInvitation).toBe('ABCDEF');
  });
});

describe('moments de sauvegarde', () => {
  const SESSION = { secret: secretDepuisTexte('secret-de-test-de-persistance') };
  let serveur: Serveur;
  let depot: DepotMemoire;
  let base: string;
  let sockets: ClientSocket[];

  beforeEach(async () => {
    depot = new DepotMemoire();
    for (const inscrit of JOUEURS) depot.inscrire(inscrit.id, inscrit.pseudo);

    serveur = creerServeur({ depot, session: SESSION, apple: { clientId: 'test' } });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    base = `http://localhost:${String((serveur.httpServer.address() as AddressInfo).port)}`;
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.disconnect();
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
  });

  const emettre = async (socket: ClientSocket, evenement: string, charge: unknown) =>
    new Promise<{ ok: boolean; erreur?: string }>((resolve) => {
      socket.emit(evenement, charge, resolve);
    });

  const asseoirTout = async () => {
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS);

    for (const inscrit of JOUEURS) {
      const socket = clientIo(base, { transports: ['websocket'] });
      await new Promise<void>((resolve) => {
        socket.on('connect', () => {
          resolve();
        });
      });
      const jeton = await signerJetonSession(inscrit.id, SESSION);
      await emettre(socket, 'rejoindre-table', { jeton, tableId });
      sockets.push(socket);
    }

    await new Promise((resolve) => setTimeout(resolve, 60));
    return { tableId };
  };

  it('n ecrit pas en base a chaque tour de jeu', async () => {
    const { tableId } = await asseoirTout();
    const table = serveur.manager.table(tableId);
    const ordre = table.coup?.ordreJoueurs ?? [];
    const socketDe = (joueurId: string) =>
      sockets[JOUEURS.findIndex((inscrit) => inscrit.id === joueurId)] as ClientSocket;

    await emettre(socketDe(ordre[0] as string), 'annoncer', { annonce: 'je-joue' });

    for (let tour = 0; tour < 4; tour += 1) {
      const actifId = serveur.manager.table(tableId).coup?.joueurActifId as string;
      const socket = socketDe(actifId);
      await emettre(socket, 'piocher', { source: 'pioche' });
      const main = serveur.manager.table(tableId).coup?.mains[actifId] ?? [];
      await emettre(socket, 'defausser', { carteId: main[0]?.id });
    }

    // Quatre tours joues, aucun coup termine : rien n'est parti en base.
    expect(depot.ecritures).toBe(0);
  });

  it('ecrit une fois quand un coup se termine', async () => {
    const { tableId } = await asseoirTout();
    const table = serveur.manager.table(tableId);
    const ordre = table.coup?.ordreJoueurs ?? [];
    const socketDe = (joueurId: string) =>
      sockets[JOUEURS.findIndex((inscrit) => inscrit.id === joueurId)] as ClientSocket;

    await emettre(socketDe(ordre[0] as string), 'annoncer', { annonce: 'je-joue' });

    // On vide la main du joueur actif : sa carte piochee sera sa derniere.
    const actifId = ordre[0] as string;
    const coup = serveur.manager.table(tableId).coup;
    if (coup === null) throw new Error('coup absent');
    coup.mains[actifId] = [];

    await emettre(socketDe(actifId), 'piocher', { source: 'pioche' });
    const piochee = serveur.manager.table(tableId).tourEnCours?.cartePiochee;
    const reponse = await emettre(socketDe(actifId), 'defausser', { carteId: piochee?.id });
    expect(reponse.ok).toBe(true);

    // Le coup est clos, cumule dans la Boule, et l'etat est parti en base.
    expect(depot.ecritures).toBe(1);
    const apres = serveur.manager.table(tableId);
    expect(bouleDe(apres).historique).toHaveLength(1);
    expect(bouleDe(apres).historique[0]?.gagnantId).toBe(actifId);

    const actives = await depot.chargerPartiesActives();
    expect(actives[0]?.etatBoule?.historique).toHaveLength(1);

    // Et un serveur redemarre reprend la partie a ce point exact.
    const apresRedemarrage = new GameRoomManager({ depot });
    await apresRedemarrage.recharger();
    expect(bouleDe(apresRedemarrage.table(tableId)).scoresCumules).toEqual(
      bouleDe(apres).scoresCumules,
    );
  });
});
