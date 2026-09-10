/**
 * Point d'entrée du serveur temps réel de « La Boule ».
 *
 * Toute la logique de jeu vit dans `src/game-engine/` et suit `docs/REGLES.md`.
 * Cette couche transporte, authentifie et persiste : elle valide chaque action
 * auprès du moteur et ne laisse sortir que des états filtrés par joueur.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import type { ConfigApple } from '../auth/apple.js';
import { secretDepuisTexte, type ConfigSession } from '../auth/session.js';
import type { Depot } from '../persistence/depot.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { DepotPrisma } from '../persistence/depot-prisma.js';
import { GameRoomManager, type Minuteur } from './game-room-manager.js';
import { enregistrerHandlers, publierTable } from './handlers.js';
import { gererRequeteHttp } from './http.js';

export interface OptionsServeur {
  readonly minuteur?: Minuteur;
  readonly depot?: Depot;
  readonly session?: ConfigSession;
  readonly apple?: ConfigApple;
}

export interface Serveur {
  readonly io: Server;
  readonly httpServer: HttpServer;
  readonly manager: GameRoomManager;
  readonly depot: Depot;
  readonly session: ConfigSession;
  /** `null` quand Sign in with Apple n'est pas configuré. */
  readonly apple: ConfigApple | null;
}

const variable = (nom: string): string | null => {
  const valeur = process.env[nom];
  return valeur === undefined || valeur.length === 0 ? null : valeur;
};

/**
 * Configuration Apple, si elle est renseignée.
 *
 * Son absence n'empêche pas le serveur de tourner : seul l'endpoint
 * d'authentification Apple est mis hors service. Tout le reste — les autres
 * routes HTTP et le WebSocket — fonctionne normalement, ce qui permet de
 * développer avant d'avoir un identifiant de service Apple.
 */
const configAppleDepuisEnv = (): ConfigApple | null => {
  const clientId = variable('APPLE_CLIENT_ID');
  if (clientId === null) {
    console.warn(
      'Authentification Apple non configuree — endpoint desactive (definir APPLE_CLIENT_ID)',
    );
    return null;
  }
  return { clientId };
};

/**
 * Secret de signature des jetons de session.
 *
 * Exigé en production : sans lui, les sessions ne seraient pas vérifiables
 * d'un déploiement à l'autre. En développement, un secret éphémère est tiré au
 * démarrage pour ne pas bloquer, au prix de sessions qui ne survivent pas à un
 * redémarrage.
 */
const configSessionDepuisEnv = (): ConfigSession => {
  const secret = variable('JWT_SECRET');
  if (secret !== null) return { secret: secretDepuisTexte(secret) };

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error("Variable d'environnement manquante : JWT_SECRET");
  }
  console.warn(
    'JWT_SECRET absent — secret de session ephemere genere : les sessions ne survivront pas a un redemarrage',
  );
  return { secret: randomBytes(48) };
};

export const creerServeur = (options: OptionsServeur = {}): Serveur => {
  const depot = options.depot ?? new DepotMemoire();
  const session = options.session ?? configSessionDepuisEnv();
  const apple = options.apple ?? configAppleDepuisEnv();

  const manager = new GameRoomManager({
    ...(options.minuteur === undefined ? {} : { minuteur: options.minuteur }),
    depot,
  });

  // Le serveur HTTP est créé avant io : le notificateur passe donc par une
  // référence différée, résolue au moment où un endpoint publie une table.
  let io: Server | null = null;
  const httpServer = createServer(
    gererRequeteHttp({
      depot,
      manager,
      session,
      apple,
      notifier: (table) => {
        if (io !== null) publierTable(io, manager, table);
      },
      annoncerAbandon: (socketIds, charge) => {
        for (const socketId of socketIds) io?.to(socketId).emit('partie-abandonnee', charge);
      },
    }),
  );

  io = new Server(httpServer, {
    cors: { origin: process.env['CORS_ORIGIN'] ?? '*' },
  });

  enregistrerHandlers(io, manager, session);
  return { io, httpServer, manager, depot, session, apple };
};

export {
  DELAI_DECONNEXION_PAR_DEFAUT_MS,
  GameRoomManager,
  minuteurSysteme,
} from './game-room-manager.js';
export type { GestionDeconnexion, Minuteur, Table } from './game-room-manager.js';
export { filtrerEtatPourJoueur } from './etat-filtre.js';
export type { EtatCoupFiltre } from './etat-filtre.js';

/** Démarrage réel : base PostgreSQL, reprise des parties en cours. */
const demarrer = async (): Promise<void> => {
  const prisma = new PrismaClient();
  const serveur = creerServeur({ depot: new DepotPrisma(prisma) });

  const reprises = await serveur.manager.recharger();
  if (reprises.length > 0) {
    console.info(`Parties reprises : ${String(reprises.length)}`);
  }

  serveur.httpServer.listen(Number(process.env['PORT'] ?? 3000));
};

if (process.env['NODE_ENV'] !== 'test') {
  void demarrer();
}
