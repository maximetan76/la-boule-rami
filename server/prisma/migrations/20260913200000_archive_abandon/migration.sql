-- Archive d'un abandon : qui l'a décidé, et le coup interrompu à cet
-- instant (scores, coups joués, mains de tous les joueurs). NULL pour une
-- partie achevée, ou abandonnée avant cette migration.

-- AlterTable
ALTER TABLE "parties" ADD COLUMN "abandonneParId" TEXT;
ALTER TABLE "parties" ADD COLUMN "interruption" JSONB;
