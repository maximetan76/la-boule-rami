import { describe, expect, it } from 'vitest';
import { orchestrerPhaseFricheOuJoue } from '../game-engine/annonces.js';
import type { Annonce, JoueurId } from '../models/index.js';

/** Réf. docs/REGLES.md § « Phase Friche / Je joue en début de coup ». */

const TABLE: JoueurId[] = ['j1', 'j2', 'j3', 'j4'];

/** Enregistre l'ordre de parole pour vérifier qui a été interrogé. */
const annonceur = (reponses: Record<JoueurId, Annonce>) => {
  const interroges: JoueurId[] = [];
  const demander = (id: JoueurId): Annonce => {
    interroges.push(id);
    return reponses[id] ?? 'friche';
  };
  return { demander, interroges };
};

describe('orchestrerPhaseFricheOuJoue', () => {
  it('fait parler en premier le joueur a la gauche du donneur', () => {
    const { demander, interroges } = annonceur({ j2: 'je-joue' });
    // Donneur = j1 (index 0), le joueur a sa gauche est j2.
    orchestrerPhaseFricheOuJoue(TABLE, 0, demander);
    expect(interroges).toEqual(['j2']);
  });

  it('fait commencer le joueur a gauche du donneur quand il joue lui-meme', () => {
    const { demander } = annonceur({ j2: 'je-joue' });
    expect(orchestrerPhaseFricheOuJoue(TABLE, 0, demander)).toEqual({ joueurCommence: 'j2' });
  });

  it('passe au suivant a chaque friche et s arrete au premier « je joue »', () => {
    const { demander, interroges } = annonceur({ j2: 'friche', j3: 'friche', j4: 'je-joue' });
    orchestrerPhaseFricheOuJoue(TABLE, 0, demander);
    // j1, le donneur, parle en dernier : il n est pas interroge ici.
    expect(interroges).toEqual(['j2', 'j3', 'j4']);
  });

  it('fait toujours commencer le joueur a gauche du donneur, meme si un autre a annonce', () => {
    // § « c est systematiquement le joueur situe a la gauche du DONNEUR qui
    // commence a jouer en premier, independamment de qui a annonce je joue ».
    const { demander } = annonceur({ j2: 'friche', j3: 'friche', j4: 'je-joue' });
    expect(orchestrerPhaseFricheOuJoue(TABLE, 0, demander)).toEqual({ joueurCommence: 'j2' });
  });

  it('n interroge personne apres le premier « je joue »', () => {
    const { demander, interroges } = annonceur({ j2: 'je-joue', j3: 'je-joue', j4: 'je-joue' });
    orchestrerPhaseFricheOuJoue(TABLE, 0, demander);
    expect(interroges).toEqual(['j2']);
  });

  it('interroge tout le monde, donneur compris, si tout le monde friche', () => {
    const { demander, interroges } = annonceur({});
    expect(orchestrerPhaseFricheOuJoue(TABLE, 0, demander)).toEqual({ toutLeMondeAFriche: true });
    expect(interroges).toEqual(['j2', 'j3', 'j4', 'j1']);
  });

  it('tourne correctement quand le donneur n est pas le premier de la table', () => {
    const { demander, interroges } = annonceur({ j1: 'je-joue' });
    // Donneur = j4 (index 3), le joueur a sa gauche est j1.
    expect(orchestrerPhaseFricheOuJoue(TABLE, 3, demander)).toEqual({ joueurCommence: 'j1' });
    expect(interroges).toEqual(['j1']);
  });

  it('refuse un index de donneur hors de la table', () => {
    const { demander } = annonceur({});
    expect(() => orchestrerPhaseFricheOuJoue(TABLE, 9, demander)).toThrow();
    expect(() => orchestrerPhaseFricheOuJoue([], 0, demander)).toThrow();
  });
});
