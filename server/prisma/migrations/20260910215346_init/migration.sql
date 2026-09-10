-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "joueurs" (
    "id" TEXT NOT NULL,
    "identifiantApple" TEXT NOT NULL,
    "pseudo" TEXT NOT NULL,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "joueurs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parties" (
    "id" TEXT NOT NULL,
    "codeInvitation" TEXT NOT NULL,
    "createurId" TEXT NOT NULL,
    "capacite" INTEGER NOT NULL,
    "demarree" BOOLEAN NOT NULL DEFAULT false,
    "gestionDeconnexionType" TEXT NOT NULL DEFAULT 'delai',
    "gestionDeconnexionDureeMs" INTEGER NOT NULL DEFAULT 90000,
    "creeeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "termineeLe" TIMESTAMP(3),
    "motifFin" TEXT,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "joueurs_sur_partie" (
    "partieId" TEXT NOT NULL,
    "joueurId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "joueurs_sur_partie_pkey" PRIMARY KEY ("partieId","joueurId")
);

-- CreateTable
CREATE TABLE "boules" (
    "id" TEXT NOT NULL,
    "partieId" TEXT NOT NULL,
    "etat" JSONB NOT NULL,
    "misAJourLe" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "boules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "joueurs_identifiantApple_key" ON "joueurs"("identifiantApple");

-- CreateIndex
CREATE UNIQUE INDEX "parties_codeInvitation_key" ON "parties"("codeInvitation");

-- CreateIndex
CREATE INDEX "parties_termineeLe_idx" ON "parties"("termineeLe");

-- CreateIndex
CREATE UNIQUE INDEX "boules_partieId_key" ON "boules"("partieId");

-- AddForeignKey
ALTER TABLE "joueurs_sur_partie" ADD CONSTRAINT "joueurs_sur_partie_partieId_fkey" FOREIGN KEY ("partieId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "joueurs_sur_partie" ADD CONSTRAINT "joueurs_sur_partie_joueurId_fkey" FOREIGN KEY ("joueurId") REFERENCES "joueurs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boules" ADD CONSTRAINT "boules_partieId_fkey" FOREIGN KEY ("partieId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

