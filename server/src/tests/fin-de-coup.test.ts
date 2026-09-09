import { describe, expect, it } from 'vitest';
import { detecterDoubleOuTriple } from '../game-engine/fin-de-coup.js';
import { c, coucouPour, coup, ensemble, jokerPour, recap, tierce } from './fixtures.js';

/** Réf. docs/REGLES.md § « Fin d'un coup et scoring ». */

const suitePure = (proprietaire: string) =>
  tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)], proprietaire);

const suiteAvecJoker = (proprietaire: string) =>
  tierce('trefle', [c('trefle', 5), jokerPour('trefle', 6), c('trefle', 7)], proprietaire);

const suiteAvecCoucou = (proprietaire: string) =>
  tierce('pique', [c('pique', 5), coucouPour('pique', 6), c('pique', 7)], proprietaire);

describe('detecterDoubleOuTriple', () => {
  it('est simple quand le gagnant a pose en plusieurs fois', () => {
    const partie = coup({
      combinaisons: [suitePure('j2')],
      recapitulatifs: { j2: recap({ toursAvecPose: [2, 5] }) },
    });
    expect(detecterDoubleOuTriple(partie, 'j2')).toBe('simple');
  });

  it('est simple quand le gagnant s est aide des combinaisons des autres', () => {
    const partie = coup({
      combinaisons: [suitePure('j2')],
      recapitulatifs: { j2: recap({ toursAvecPose: [3], aAjouteSurCombinaisonAutrui: true }) },
    });
    expect(detecterDoubleOuTriple(partie, 'j2')).toBe('simple');
  });

  it('est double quand il finit en une fois, sans aide, mais avec un joker normal', () => {
    const partie = coup({
      combinaisons: [suitePure('j2'), suiteAvecJoker('j2')],
      recapitulatifs: { j2: recap({ toursAvecPose: [4] }) },
    });
    expect(detecterDoubleOuTriple(partie, 'j2')).toBe('double');
  });

  it('est triple quand il finit en une fois, sans aide et sans aucun joker normal', () => {
    const partie = coup({
      combinaisons: [suitePure('j2'), ensemble('V', [c('pique', 'V'), c('coeur', 'V'), c('trefle', 'V')], 'j2')],
      recapitulatifs: { j2: recap({ toursAvecPose: [4] }) },
    });
    expect(detecterDoubleOuTriple(partie, 'j2')).toBe('triple');
  });

  it('reste triple si seul le coucou est utilise', () => {
    const partie = coup({
      combinaisons: [suitePure('j2'), suiteAvecCoucou('j2')],
      recapitulatifs: { j2: recap({ toursAvecPose: [4] }) },
    });
    expect(detecterDoubleOuTriple(partie, 'j2')).toBe('triple');
  });

  it('ignore les jokers poses par les autres joueurs', () => {
    const partie = coup({
      combinaisons: [suitePure('j2'), suiteAvecJoker('j3')],
      recapitulatifs: { j2: recap({ toursAvecPose: [4] }) },
    });
    expect(detecterDoubleOuTriple(partie, 'j2')).toBe('triple');
  });

  it('refuse un gagnant sans recapitulatif dans le coup', () => {
    expect(() => detecterDoubleOuTriple(coup(), 'j9')).toThrow();
  });
});
