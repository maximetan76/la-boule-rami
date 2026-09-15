-- Date de démarrage d'une partie, pour supprimer celles où rien ne s'est joué.
ALTER TABLE "parties" ADD COLUMN "demarreeLe" TIMESTAMP(3);
