import { describe, expect, it } from 'vitest';
import { AnalyseDeMain, peutFinir, repartir } from '../game-engine/solveur.js';
import { estCombinaisonValide, verifierDeclarationsJokers } from '../game-engine/combinaisons.js';
import { verifierFinDeCoupSpeciale } from '../game-engine/pose.js';
import { c, joker } from './fixtures.js';
import type { Carte } from '../models/index.js';

/**
 * Réf. docs/REGLES.md § « Conditions pour poser » et § « Le panier ». Le
 * solveur découpe une main en combinaisons, ébauches et cartes seules, et dit
 * combien de cartes il lui manque.
 */

const ids = (cartes: readonly Carte[]) => cartes.map((carte) => carte.id).sort();

describe('solveur de main', () => {
  it('une main faite de combinaisons est à distance 0', () => {
    const main = [
      c('pique', 2), c('coeur', 2), c('trefle', 2),
      c('carreau', 5), c('carreau', 6), c('carreau', 7),
    ];
    const repartition = repartir(main);
    expect(repartition.distance).toBe(0);
    expect(repartition.combinaisons).toHaveLength(2);
    expect(repartition.isolees).toEqual([]);
  });

  it('chaque combinaison proposée passe la validation du moteur', () => {
    const jk = joker();
    const main = [
      c('pique', 9), c('pique', 10), jk, c('pique', 'D'),
      c('coeur', 'A'), c('trefle', 'A'), c('carreau', 'A'),
    ];
    const repartition = repartir(main);
    expect(repartition.distance).toBe(0);
    for (const combinaison of repartition.combinaisons) {
      expect(estCombinaisonValide(combinaison)).toBe(true);
      expect(() => verifierDeclarationsJokers([combinaison])).not.toThrow();
    }
    // Le joker tient le valet de pique, et il le dit.
    const suite = repartition.combinaisons.find((combinaison) => combinaison.type === 'tierce');
    expect(suite?.cartes.find((cp) => cp.carte.id === jk.id)?.remplace).toEqual({ couleur: 'pique', valeur: 'V' });
  });

  it("l'as se lit en haut comme en bas", () => {
    expect(repartir([c('coeur', 'A'), c('coeur', 2), c('coeur', 3)]).distance).toBe(0);
    expect(repartir([c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')]).distance).toBe(0);
    // Mais il ne boucle pas : R-A-2 n'est pas une suite.
    expect(repartir([c('coeur', 'R'), c('coeur', 'A'), c('coeur', 2)]).distance).toBeGreaterThan(0);
  });

  it('une suite de six cartes se pose en deux suites de trois', () => {
    const main = [3, 4, 5, 6, 7, 8].map((v) => c('trefle', v as 3));
    const repartition = repartir(main);
    expect(repartition.distance).toBe(0);
    expect(repartition.combinaisons.every((combinaison) => combinaison.cartes.length <= 5)).toBe(true);
  });

  it('ébauches et cartes seules : la distance compte ce qui manque', () => {
    // 7♥ 7♠ : il manque un 7 ; 9♦ 10♦ : il manque un bout ; R♣ seul : deux cartes.
    const repartition = repartir([c('coeur', 7), c('pique', 7), c('carreau', 9), c('carreau', 10), c('trefle', 'R')]);
    expect(repartition.distance).toBe(1 + 1 + 2);
    expect(repartition.ebauches).toHaveLength(2);
    expect(ids(repartition.isolees)).toEqual(ids([repartition.isolees[0] as Carte]));
  });

  it('une ébauche dont les cartes manquantes sont toutes sorties est morte', () => {
    const cinq = c('pique', 5);
    const sept = c('pique', 7);
    // Il manque le 6♠ : ses deux exemplaires sont dans la défausse.
    const vivante = repartir([cinq, sept]);
    const morte = repartir([cinq, sept], null, { cartesVues: [c('pique', 6), c('pique', 6)] });
    expect(vivante.distance).toBe(1);
    expect(morte.distance).toBe(4);
  });

  it('à potentiel égal, garde ce qui a le plus de cartes encore en jeu', () => {
    const repartitionOuverte = repartir([c('coeur', 7), c('coeur', 8)]);
    const repartitionFermee = repartir([c('coeur', 7), c('coeur', 8)], null, {
      cartesVues: [c('coeur', 6), c('coeur', 6)],
    });
    expect(repartitionOuverte.distance).toBe(repartitionFermee.distance);
    expect(repartitionOuverte.potentiel).toBeGreaterThan(repartitionFermee.potentiel);
  });

  it('à 15 cartes, met de côté la carte qui ne sert à rien', () => {
    const inutile = c('trefle', 'R');
    const main = [
      c('pique', 2), c('coeur', 2), c('trefle', 2),
      c('pique', 3), c('coeur', 3), c('trefle', 3),
      c('pique', 4), c('coeur', 4), c('trefle', 4),
      c('carreau', 5), c('carreau', 6), c('carreau', 7), c('carreau', 8), c('carreau', 9),
      inutile,
    ];
    const repartition = repartir(main, 'libre');
    expect(repartition.distance).toBe(0);
    expect(repartition.defausse?.id).toBe(inutile.id);
  });

  it('un joker ne se met jamais de côté', () => {
    const jk = joker();
    const main = [c('pique', 2), c('coeur', 2), jk, c('carreau', 9)];
    const repartition = repartir(main, 'libre');
    expect(repartition.defausse?.id).not.toBe(jk.id);
  });

  it('peutFinir : les 14 cartes en combinaisons, la 15e à jeter, et le moteur l accepte', () => {
    const jk = joker();
    const aJeter = c('pique', 'R');
    const main = [
      c('pique', 2), c('coeur', 2), c('trefle', 2),
      c('pique', 3), c('coeur', 3), c('trefle', 3),
      c('pique', 7), c('coeur', 7), jk,
      c('carreau', 5), c('carreau', 6), c('carreau', 7), c('carreau', 8), c('carreau', 9),
      aJeter,
    ];
    const finie = peutFinir(main);
    expect(finie).not.toBeNull();
    expect(finie?.defausse?.id).toBe(aJeter.id);
    expect(verifierFinDeCoupSpeciale(main, finie?.combinaisons ?? [])).toBe(true);
  });

  it('peutFinir : une carte de trop ou de moins, et rien ne finit', () => {
    const main = [
      c('pique', 2), c('coeur', 2), c('trefle', 2),
      c('pique', 3), c('coeur', 3), c('trefle', 3),
      c('pique', 7), c('coeur', 7), c('carreau', 'V'),
      c('carreau', 5), c('carreau', 6), c('carreau', 7), c('carreau', 8), c('carreau', 9),
      c('pique', 'R'),
    ];
    expect(peutFinir(main)).toBeNull();
  });

  it("évaluer sans une carte donnée : c'est elle qu'on défausse, et une carte absente est refusée", () => {
    const roi = c('pique', 'R');
    const sept = c('coeur', 7);
    const analyse = new AnalyseDeMain([sept, c('coeur', 8), c('coeur', 9), roi]);
    const sansLeRoi = analyse.meilleure(roi);
    expect(sansLeRoi.defausse?.id).toBe(roi.id);
    expect(sansLeRoi.distance).toBe(0);
    // Sans le 7♥, la suite est cassée : il reste une ébauche et un roi seul.
    expect(analyse.meilleure(sept).distance).toBe(1 + 2);
    expect(() => analyse.meilleure(c('pique', 'R'))).toThrow(/absente/);
  });

  it('reste rapide sur une main de 15 cartes avec un joker', () => {
    const jk = joker();
    const main = [
      c('pique', 2), c('pique', 3), c('pique', 4), c('coeur', 4), c('trefle', 4), c('carreau', 4),
      c('coeur', 5), c('coeur', 6), c('coeur', 7), c('coeur', 8), c('trefle', 8), c('pique', 8),
      c('carreau', 'V'), c('carreau', 'D'), jk,
    ];
    const debut = performance.now();
    const analyse = new AnalyseDeMain(main);
    for (const carte of main.filter((carte) => carte.type === 'normale')) analyse.meilleure(carte);
    expect(performance.now() - debut).toBeLessThan(2_000);
  });
});
