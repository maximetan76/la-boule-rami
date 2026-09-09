import { describe, expect, it } from 'vitest';
import { estCarteCollante, estCarteSousCollante } from '../game-engine/defausse.js';
import { c, coucou, ensemble, joker, tierce } from './fixtures.js';

/**
 * Réf. docs/REGLES.md § « Règle spéciale : piocher la carte de la défausse ».
 *
 * Lecture retenue des deux exemples du texte : une carte est « collante »
 * quand elle touche directement un bout d'une suite déjà posée (elle ne
 * ferait que la prolonger, d'où le doublon), et « sous-collante » quand elle
 * se situe à deux rangs de ce bout, ce qui laisse la suite posée intacte.
 */

const suite6789 = () =>
  tierce('coeur', [c('coeur', 6), c('coeur', 7), c('coeur', 8), c('coeur', 9)]);

const suite789 = () => tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)]);

describe('estCarteCollante', () => {
  it('exemple des regles : le 5 de coeur face a la suite 6-7-8-9 de coeur', () => {
    expect(estCarteCollante(c('coeur', 5), suite6789())).toBe(true);
    expect(estCarteSousCollante(c('coeur', 5), suite6789())).toBe(false);
  });

  it('colle aussi par le haut : le 10 de coeur face a la suite 6-7-8-9', () => {
    expect(estCarteCollante(c('coeur', 10), suite6789())).toBe(true);
  });

  it('ne colle pas si la couleur differe', () => {
    expect(estCarteCollante(c('pique', 5), suite6789())).toBe(false);
    expect(estCarteSousCollante(c('pique', 5), suite6789())).toBe(false);
  });

  it('ne colle pas a distance de deux rangs ou plus', () => {
    expect(estCarteCollante(c('coeur', 4), suite6789())).toBe(false);
    expect(estCarteCollante(c('coeur', 3), suite6789())).toBe(false);
  });

  it('colle sous une tierce D-R-A par le valet, et au dessus d une tierce A-2-3 par le 4', () => {
    const haute = tierce('pique', [c('pique', 'D'), c('pique', 'R'), c('pique', 'A')]);
    expect(estCarteCollante(c('pique', 'V'), haute)).toBe(true);
    const basse = tierce('pique', [c('pique', 'A'), c('pique', 2), c('pique', 3)]);
    expect(estCarteCollante(c('pique', 4), basse)).toBe(true);
  });

  it('ignore les jokers et les brelans', () => {
    expect(estCarteCollante(joker(), suite6789())).toBe(false);
    expect(estCarteCollante(coucou(), suite6789())).toBe(false);
    const brelan = ensemble(8, [c('pique', 8), c('coeur', 8), c('trefle', 8)]);
    expect(estCarteCollante(c('coeur', 7), brelan)).toBe(false);
  });

  it('ignore une combinaison qui n est pas une tierce valide', () => {
    const bancale = tierce('coeur', [c('coeur', 2), c('coeur', 5), c('coeur', 9)]);
    expect(estCarteCollante(c('coeur', 6), bancale)).toBe(false);
  });
});

describe('estCarteSousCollante', () => {
  it('exemple des regles : le 5 de coeur face a la suite 7-8-9 de coeur', () => {
    expect(estCarteSousCollante(c('coeur', 5), suite789())).toBe(true);
    expect(estCarteCollante(c('coeur', 5), suite789())).toBe(false);
  });

  it('vaut aussi par le haut : le valet de coeur face a la suite 6-7-8-9', () => {
    expect(estCarteSousCollante(c('coeur', 'V'), suite6789())).toBe(true);
  });

  it('est fausse a distance de trois rangs', () => {
    expect(estCarteSousCollante(c('coeur', 3), suite6789())).toBe(false);
    expect(estCarteSousCollante(c('coeur', 'D'), suite6789())).toBe(false);
  });

  it('tient compte de l as haut : le valet est sous-collant d une tierce R-A', () => {
    const haute = tierce('pique', [c('pique', 'D'), c('pique', 'R'), c('pique', 'A')]);
    expect(estCarteSousCollante(c('pique', 10), haute)).toBe(true);
  });

  it('tient compte de l as bas : le 5 est sous-collant d une tierce A-2-3', () => {
    const basse = tierce('pique', [c('pique', 'A'), c('pique', 2), c('pique', 3)]);
    expect(estCarteSousCollante(c('pique', 5), basse)).toBe(true);
  });

  it('ignore les jokers et les brelans', () => {
    expect(estCarteSousCollante(joker(), suite789())).toBe(false);
    const brelan = ensemble(8, [c('pique', 8), c('coeur', 8), c('trefle', 8)]);
    expect(estCarteSousCollante(c('coeur', 6), brelan)).toBe(false);
  });
});
