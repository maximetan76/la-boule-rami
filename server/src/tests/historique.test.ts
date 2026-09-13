import { describe, expect, it } from 'vitest';
import { enregistrerResultatCoup } from '../game-engine/boule.js';
import { deserialiserBoule, serialiserBoule } from '../persistence/serialisation.js';
import { boule, c, tierce } from './fixtures.js';
import type { ScoreCoup } from '../models/index.js';

/**
 * L'historique d'une Boule : chaque coup joué garde qui a posé quoi et ce qui
 * est resté en main, pour qu'on puisse y revenir à tout moment de la partie.
 */

const score: ScoreCoup = {
  gagnantId: 'j1',
  typeVictoire: 'simple',
  estFriche: false,
  multiplicateur: 1,
  scores: { j1: -20, j2: 34, j3: 12 },
  croixGagnees: {},
};

const archive = () => ({
  combinaisons: [
    tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)], 'j1'),
    tierce('pique', [c('pique', 2), c('pique', 3), c('pique', 4)], 'j2'),
  ],
  mainsRevelees: { j1: [], j2: [c('trefle', 'R'), c('carreau', 5)], j3: [c('coeur', 'A')] },
});

describe('historique de la Boule', () => {
  it('garde les combinaisons de chacun et les mains restantes d un coup termine', () => {
    const depart = boule();
    const apres = enregistrerResultatCoup(depart, depart.historique.length + 1, score, archive());

    const archive1 = apres.historique.at(-1);
    expect(archive1?.combinaisons).toHaveLength(2);
    expect(archive1?.combinaisons?.map((comb) => comb.proprietaireId)).toEqual(['j1', 'j2']);
    expect(archive1?.mainsRevelees?.['j2']).toHaveLength(2);
    expect(archive1?.mainsRevelees?.['j1']).toEqual([]);
    // Le score reste enregistré comme avant.
    expect(archive1?.scores['j2']).toBe(34);
  });

  it('n invente rien quand aucune archive n est fournie', () => {
    const depart = boule();
    const apres = enregistrerResultatCoup(depart, depart.historique.length + 1, score);

    expect(apres.historique.at(-1)).not.toHaveProperty('combinaisons');
    expect(apres.historique.at(-1)).not.toHaveProperty('mainsRevelees');
  });

  it('survit a un redemarrage du serveur', () => {
    const depart = boule();
    const avecArchive = enregistrerResultatCoup(depart, depart.historique.length + 1, score, archive());

    const relue = deserialiserBoule(JSON.parse(JSON.stringify(serialiserBoule(avecArchive))));

    const coup = relue.historique.at(-1);
    expect(coup?.combinaisons).toHaveLength(2);
    expect(coup?.combinaisons?.[1]?.proprietaireId).toBe('j2');
    expect(coup?.mainsRevelees?.['j2']).toHaveLength(2);
    expect(coup?.mainsRevelees?.['j3']?.[0]).toMatchObject({ couleur: 'coeur', valeur: 'A' });
  });

  it('relit sans broncher un coup archive avant que l historique ne le retienne', () => {
    const depart = boule();
    const sansArchive = enregistrerResultatCoup(depart, depart.historique.length + 1, score);
    const persiste = JSON.parse(JSON.stringify(serialiserBoule(sansArchive))) as {
      historique: Record<string, unknown>[];
    };

    const relue = deserialiserBoule(persiste);

    expect(relue.historique).toHaveLength(1);
    expect(relue.historique[0]?.combinaisons).toBeUndefined();
  });
});
