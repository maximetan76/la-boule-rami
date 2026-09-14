-- Suppression de compte par anonymisation : la date de suppression.
-- NULL : compte actif, comme avant.

-- AlterTable
ALTER TABLE "joueurs" ADD COLUMN "supprimeLe" TIMESTAMP(3);
