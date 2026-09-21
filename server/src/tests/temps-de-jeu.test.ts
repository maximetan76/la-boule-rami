import { describe, expect, it } from 'vitest';
import { avancerLeChronometre, type Chronometre } from '../server/temps-de-jeu.js';
import { deserialiserBoule, serialiserBoule } from '../persistence/serialisation.js';
import type { Boule } from '../models/index.js';

/**
 * Le temps de jeu : le temps passé à être attendu par la table, annonces
 * comprises. L'heure est passée en paramètre, pour des mesures exactes.
 */
const boule = (tempsDeJeu?: Record<string, number>): Boule => ({
  ordreTable: ['ana', 'bo'],
  nombreCoupsTotal: 8,
  nombreCoupsFriches: 2,
  scoresCumules: { ana: 0, bo: 0 },
  croix: { ana: 0, bo: 0 },
  historique: [],
  coupEnCours: null,
  ...(tempsDeJeu === undefined ? {} : { tempsDeJeu }),
});

describe('temps de jeu', () => {
  it('credite le temps ecoule au joueur attendu quand la table passe a un autre', () => {
    const chrono: Chronometre = { joueurId: 'ana', depuis: 1_000 };
    const { boule: apres, chronometre } = avancerLeChronometre(boule(), chrono, 'bo', 43_000);

    expect(apres?.tempsDeJeu).toEqual({ ana: 42_000 });
    expect(chronometre).toEqual({ joueurId: 'bo', depuis: 43_000 });
  });

  it('le meme joueur toujours attendu : rien n est credite, le chronometre continue', () => {
    // L'engagé interrogé qui continue : il parle, puis joue, sans interruption.
    const chrono: Chronometre = { joueurId: 'ana', depuis: 1_000 };
    const depart = boule({ ana: 5_000 });
    const { boule: apres, chronometre } = avancerLeChronometre(depart, chrono, 'ana', 60_000);

    expect(apres).toBe(depart);
    expect(chronometre).toBe(chrono);
  });

  it('les temps s ajoutent a ceux deja credites', () => {
    const { boule: apres } = avancerLeChronometre(
      boule({ ana: 5_000, bo: 7_000 }),
      { joueurId: 'bo', depuis: 10_000 },
      'ana',
      13_000,
    );
    expect(apres?.tempsDeJeu).toEqual({ ana: 5_000, bo: 10_000 });
  });

  it('pendant l entracte, personne n est attendu : le chronometre s arrete', () => {
    const { boule: apres, chronometre } = avancerLeChronometre(boule(), { joueurId: 'bo', depuis: 0 }, null, 9_000);
    expect(apres?.tempsDeJeu).toEqual({ bo: 9_000 });
    expect(chronometre).toBeNull();
  });

  it('le temps de jeu se relit apres un passage en base ; une Boule d avant n en a pas', () => {
    const relue = deserialiserBoule(JSON.parse(JSON.stringify(serialiserBoule(boule({ ana: 42_000, bo: 1_500 })))));
    expect(relue.tempsDeJeu).toEqual({ ana: 42_000, bo: 1_500 });
    expect(deserialiserBoule(JSON.parse(JSON.stringify(serialiserBoule(boule())))).tempsDeJeu).toBeUndefined();
  });
});
