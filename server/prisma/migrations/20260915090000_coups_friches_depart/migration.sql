-- Coups frichés de départ, choisis à la création de la table.
-- Les parties déjà enregistrées gardent la valeur d'avant : 2.

-- AlterTable
ALTER TABLE "parties" ADD COLUMN "coupsFrichesDepart" INTEGER NOT NULL DEFAULT 2;
