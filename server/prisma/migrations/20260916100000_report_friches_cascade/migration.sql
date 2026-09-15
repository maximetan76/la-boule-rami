-- Report de coups frichés en cascade sur les Boules rejouées : la base configurée
-- par le créateur, et l'excédent reçu au-delà du nombre de coups.
-- NULL / 0 : comportement d'avant, départ seul et aucun excédent.

-- AlterTable
ALTER TABLE "parties" ADD COLUMN "coupsFrichesConfigures" INTEGER;
ALTER TABLE "parties" ADD COLUMN "excedentDeFriches" INTEGER NOT NULL DEFAULT 0;
