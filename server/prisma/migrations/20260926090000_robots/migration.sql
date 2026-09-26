-- Les joueurs que le serveur joue lui-même, relus au redémarrage : une partie
-- « contre l'ordinateur » reprend avec son adversaire. Les parties existantes
-- n'en ont aucun.

-- AlterTable
ALTER TABLE "parties" ADD COLUMN "robots" TEXT[] DEFAULT ARRAY[]::TEXT[];
