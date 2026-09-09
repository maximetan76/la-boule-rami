/**
 * Point d'entrée du serveur temps réel de « La Boule ».
 *
 * Ce fichier n'est qu'un bootstrap réseau : toute la logique de jeu vit dans
 * `src/game-engine/` et suit `docs/REGLES.md`.
 */
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const PORT = Number(process.env['PORT'] ?? 3000);

export function createGameServer(): Server {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    cors: { origin: process.env['CORS_ORIGIN'] ?? '*' },
  });

  // Les handlers WebSocket seront enregistrés ici. Règle d'or : l'état émis à
  // un client est toujours filtré au préalable, aucune information cachée
  // (main des autres joueurs, contenu de la pioche) ne quitte le serveur.

  httpServer.listen(PORT);
  return io;
}

if (process.env['NODE_ENV'] !== 'test') {
  createGameServer();
}
