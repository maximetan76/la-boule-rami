-- Délais de jeu configurables par table, en millisecondes.
-- NULL : illimité. Les parties déjà enregistrées gardent ainsi leur
-- comportement d'avant, sans délai.

-- AlterTable
ALTER TABLE "parties" ADD COLUMN "delaiAnnonceMs" INTEGER;
ALTER TABLE "parties" ADD COLUMN "delaiJeuMs" INTEGER;
ALTER TABLE "parties" ADD COLUMN "delaiProlongationMs" INTEGER;
