import { describe, expect, it } from 'vitest';
import { enregistrerResultatCoup, initialiserBoule } from '../game-engine/boule.js';
import { deserialiserBoule, serialiserBoule } from '../persistence/serialisation.js';
import { c, joueur, tierce } from './fixtures.js';
import type { ScoreCoup } from '../models/index.js';

/** La pose finale du gagnant, gardée dans l'historique de la Boule. */

const score: ScoreCoup = {
  gagnantId: 'j1',
  typeVictoire: 'simple',
  estFriche: false,
  multiplicateur: 1,
  scores: { j1: -20, j2: 30 },
  croixGagnees: {},
  chocolatId: null,
};

const bouleDeDeux = () => initialiserBoule([joueur('j1'), joueur('j2')]);

describe('pose finale archivee', () => {
  it('garde les cartes de la pose finale, et les relit apres un passage en base', () => {
    const dix = c('coeur', 10);
    const suite = tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9), dix], 'j2');
    const apres = enregistrerResultatCoup(bouleDeDeux(), 1, score, {
      combinaisons: [suite],
      mainsRevelees: { j1: [], j2: [] },
      poseFinale: [dix.id],
    });

    expect(apres.historique[0]?.poseFinale).toEqual([dix.id]);
    expect(deserialiserBoule(serialiserBoule(apres)).historique[0]?.poseFinale).toEqual([dix.id]);
  });

  it('relit un coup archive avant qu on la retienne, sans en inventer', () => {
    const apres = enregistrerResultatCoup(bouleDeDeux(), 1, score, { combinaisons: [], mainsRevelees: {} });
    expect(deserialiserBoule(serialiserBoule(apres)).historique[0]?.poseFinale).toBeUndefined();
  });
});
