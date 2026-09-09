/**
 * Point d'entrée du serveur temps réel de « La Boule ».
 *
 * Toute la logique de jeu vit dans `src/game-engine/` et suit `docs/REGLES.md`.
 * Cette couche ne fait que transporter : elle valide chaque action auprès du
 * moteur et ne laisse sortir que des états filtrés par joueur.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { GameRoomManager } from './game-room-manager.js';
import { enregistrerHandlers } from './handlers.js';

export interface Serveur {
  readonly io: Server;
  readonly httpServer: HttpServer;
  readonly manager: GameRoomManager;
}

export const creerServeur = (): Serveur => {
  const manager = new GameRoomManager();
  const httpServer = createServer();
  const io = new Server(httpServer, {
    cors: { origin: process.env['CORS_ORIGIN'] ?? '*' },
  });

  enregistrerHandlers(io, manager);
  return { io, httpServer, manager };
};

export { GameRoomManager } from './game-room-manager.js';
export { filtrerEtatPourJoueur } from './etat-filtre.js';
export type { EtatCoupFiltre } from './etat-filtre.js';

if (process.env['NODE_ENV'] !== 'test') {
  const { httpServer } = creerServeur();
  httpServer.listen(Number(process.env['PORT'] ?? 3000));
}
