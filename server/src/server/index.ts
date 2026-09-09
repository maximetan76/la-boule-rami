/**
 * Point d'entrée du serveur temps réel de « La Boule ».
 *
 * Toute la logique de jeu vit dans `src/game-engine/` et suit `docs/REGLES.md`.
 * Cette couche transporte, authentifie et persiste : elle valide chaque action
 * auprès du moteur et ne laisse sortir que des états filtrés par joueur.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import type { ConfigApple } from '../auth/apple.js';
import { secretDepuisTexte, type ConfigSession } from '../auth/session.js';
import type { Depot } from '../persistence/depot.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { DepotPrisma } from '../persistence/depot-prisma.js';
import { GameRoomManager, type Minuteur } from './game-room-manager.js';
import { enregistrerHandlers } from './handlers.js';
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
}

const variable = (nom: string): string => {
  const valeur = process.env[nom];
  if (valeur === undefined || valeur.length === 0) {
    throw new Error(`Variable d'environnement manquante : ${nom}`);
  }
  return valeur;
};

export const creerServeur = (options: OptionsServeur = {}): Serveur => {
  const depot = options.depot ?? new DepotMemoire();
  const session = options.session ?? { secret: secretDepuisTexte(variable('JWT_SECRET')) };
  const apple = options.apple ?? { clientId: variable('APPLE_CLIENT_ID') };

  const manager = new GameRoomManager({
    ...(options.minuteur === undefined ? {} : { minuteur: options.minuteur }),
    depot,
  });

  const httpServer = createServer(gererRequeteHttp({ depot, session, apple }));
  const io = new Server(httpServer, {
    cors: { origin: process.env['CORS_ORIGIN'] ?? '*' },
  });

  enregistrerHandlers(io, manager, session);
  return { io, httpServer, manager, depot, session };
};

export {
  DELAI_DECONNEXION_PAR_DEFAUT_MS,
  GameRoomManager,
  minuteurSysteme,
} from './game-room-manager.js';
export type { GestionDeconnexion, JoueurInscrit, Minuteur } from './game-room-manager.js';
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
