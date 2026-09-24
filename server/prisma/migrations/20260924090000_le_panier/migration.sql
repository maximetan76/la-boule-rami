-- Le panier : la variante à deux joueurs, sans points ni croix, gagnée en
-- manches. Les parties existantes valent « boule », comme avant.

-- AlterTable
ALTER TABLE "parties" ADD COLUMN "variante" TEXT NOT NULL DEFAULT 'boule';
ALTER TABLE "parties" ADD COLUMN "manchesAGagner" INTEGER;
ALTER TABLE "parties" ADD COLUMN "montant" DOUBLE PRECISION;
