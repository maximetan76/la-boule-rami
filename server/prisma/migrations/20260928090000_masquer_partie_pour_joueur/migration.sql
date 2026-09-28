-- Un joueur qui supprime une partie archivée de sa liste : masquée pour lui
-- seul, les autres joueurs la gardent avec leur historique. NULL : visible.

-- AlterTable
ALTER TABLE "joueurs_sur_partie" ADD COLUMN "masqueeLe" TIMESTAMP(3);
