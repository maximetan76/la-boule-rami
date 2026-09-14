-- Nombre de coups de la Boule choisi à la création (1 à 12).
-- NULL : celui des règles pour ce nombre de joueurs, comme avant.

-- AlterTable
ALTER TABLE "parties" ADD COLUMN "nombreCoups" INTEGER;
