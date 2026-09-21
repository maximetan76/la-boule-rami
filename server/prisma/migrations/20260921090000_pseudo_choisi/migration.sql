-- Le joueur a-t-il choisi lui-même son pseudo ? Un compte neuf, non : l'app
-- lui demande d'en choisir un avant l'accueil.

-- AlterTable
ALTER TABLE "joueurs" ADD COLUMN "pseudoChoisi" BOOLEAN NOT NULL DEFAULT false;

-- Les comptes existants qui portent déjà un vrai nom ne sont pas
-- réinterrogés : seuls ceux restés sur le pseudo par défaut du serveur
-- (« Joueur », voir server/src/server/http.ts) verront l'écran de choix. La
-- comparaison de texte ne sert qu'à ce rattrapage, une fois pour toutes.
UPDATE "joueurs" SET "pseudoChoisi" = true WHERE "pseudo" <> 'Joueur';
