import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { DepotPrisma } from '../persistence/depot-prisma.js';
import { serialiserBoule } from '../persistence/serialisation.js';
import { enregistrerResultatCoup, initialiserBoule } from '../game-engine/index.js';
import { joueur } from './fixtures.js';
import type { ScoreCoup } from '../models/index.js';

/**
 * Dialogue réel avec PostgreSQL.
 *
 * Ignoré tant que `DATABASE_URL_TEST` n'est pas défini : les autres tests
 * couvrent la logique, celui-ci vérifie que les requêtes passent vraiment.
 *
 * ATTENTION : le schéma est poussé avec `--force-reset`, qui VIDE la base
 * désignée. Ne jamais y pointer autre chose qu'une base jetable. Voir
 * docs/DEPLOIEMENT.md.
 */
const URL_TEST = process.env['DATABASE_URL_TEST'];

const score = (partiel: Partial<ScoreCoup> = {}): ScoreCoup => ({
  gagnantId: 'p-ana',
  typeVictoire: 'simple',
  estFriche: false,
  multiplicateur: 1,
  scores: { 'p-ana': -20, 'p-bo': 30, 'p-cy': 100 },
  croixGagnees: { 'p-ana': 2 },
  ...partiel,
});

describe.skipIf(URL_TEST === undefined || URL_TEST.length === 0)('PostgreSQL', () => {
  let prisma: PrismaClient;
  let depot: DepotPrisma;

  beforeAll(() => {
    execFileSync(
      'npx',
      ['prisma', 'db', 'push', '--force-reset', '--skip-generate', '--accept-data-loss'],
      { env: { ...process.env, DATABASE_URL: URL_TEST }, stdio: 'pipe' },
    );
    prisma = new PrismaClient({ datasourceUrl: URL_TEST as string });
    depot = new DepotPrisma(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('inscrit un joueur Apple une seule fois', async () => {
    const premier = await depot.trouverOuCreerJoueurApple('001.ana', 'Ana');
    const second = await depot.trouverOuCreerJoueurApple('001.ana', 'Ignoree');

    expect(second.id).toBe(premier.id);
    expect(second.pseudo).toBe('Ana');
    expect((await depot.trouverJoueur(premier.id))?.pseudo).toBe('Ana');
  });

  it('renomme un joueur', async () => {
    const cree = await depot.trouverOuCreerJoueurApple('001.rename', 'Avant');
    const renomme = await depot.renommerJoueur(cree.id, 'Apres');

    expect(renomme.pseudo).toBe('Apres');
    expect((await depot.trouverJoueur(cree.id))?.pseudo).toBe('Apres');
  });

  it('ouvre un salon, l assied, le demarre, puis le clot', async () => {
    const joueurs = await Promise.all(
      ['Ana', 'Bo', 'Cy'].map((pseudo, index) =>
        depot.trouverOuCreerJoueurApple(`001.salon.${String(index)}`, pseudo),
      ),
    );
    const ids = joueurs.map((inscrit) => inscrit.id);

    await depot.creerPartie({
      id: 'partie-pg',
      codeInvitation: 'PGTEST',
      createurId: ids[0] as string,
      capacite: 3,
      gestionDeconnexion: { type: 'delai', dureeMs: 45_000 },
    });
    for (const [position, id] of ids.entries()) {
      await depot.asseoirJoueur('partie-pg', id, position);
    }

    // Le code retrouve bien la partie, avec sa configuration.
    const parCode = await depot.trouverPartieParCode('PGTEST');
    expect(parCode?.id).toBe('partie-pg');
    expect(parCode?.gestionDeconnexion).toEqual({ type: 'delai', dureeMs: 45_000 });
    expect(parCode?.demarree).toBe(false);
    expect(parCode?.joueursIds).toEqual(ids);

    // Un joueur assis est vu comme engage.
    expect((await depot.partieActiveDuJoueur(ids[1] as string))?.id).toBe('partie-pg');

    // Le tirage rebat les places : l'ordre enregistre doit suivre.
    const ordreTirage = [ids[2], ids[0], ids[1]] as string[];
    await depot.demarrerPartie('partie-pg', ordreTirage);
    const demarree = await depot.trouverPartieParCode('PGTEST');
    expect(demarree?.demarree).toBe(true);
    expect(demarree?.joueursIds).toEqual(ordreTirage);
  });

  it('ecrase l etat de la Boule au lieu d en empiler', async () => {
    let boule = initialiserBoule(['p-ana', 'p-bo', 'p-cy'].map((id) => joueur(id)));
    boule = enregistrerResultatCoup(boule, 1, score());
    await depot.enregistrerBoule('partie-pg', serialiserBoule(boule));

    boule = enregistrerResultatCoup(boule, 2, score({ gagnantId: 'p-bo' }));
    await depot.enregistrerBoule('partie-pg', serialiserBoule(boule));

    // Une seule Boule pour la partie, portant le dernier etat.
    expect(await prisma.boule.count({ where: { partieId: 'partie-pg' } })).toBe(1);

    const actives = await depot.chargerPartiesActives();
    const rechargee = actives.find((active) => active.partie.id === 'partie-pg');
    expect(rechargee?.etatBoule?.historique).toHaveLength(2);
    expect(rechargee?.etatBoule?.scoresCumules).toEqual(boule.scoresCumules);
    expect(rechargee?.joueurs.map((inscrit) => inscrit.pseudo)).toEqual(['Cy', 'Ana', 'Bo']);
  });

  it('ne recharge plus une partie terminee', async () => {
    await depot.terminerPartie('partie-pg');

    const actives = await depot.chargerPartiesActives();
    expect(actives.some((active) => active.partie.id === 'partie-pg')).toBe(false);
    // Et ses joueurs redeviennent libres.
    const ana = await depot.trouverOuCreerJoueurApple('001.salon.0', 'Ana');
    expect(await depot.partieActiveDuJoueur(ana.id)).toBeNull();
  });
});
