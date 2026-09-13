import { describe, expect, it } from 'vitest';
import {
  filtrerTirage,
  joueursARetourner,
  retournerCarte,
  tirageComplet,
} from '../server/tirage-en-direct.js';
import { c, joker } from './fixtures.js';
import type { Carte, JoueurId } from '../models/index.js';

/**
 * Le tirage d'ouverture retourné en direct : une carte n'est montrée qu'une
 * fois retournée par son joueur.
 */

/** j1 et j2 tirent un 5 et retirent ; j3 tire un roi. */
const tirage = () => ({
  ordreTable: ['j2', 'j1', 'j3'],
  donneurInitial: 'j2',
  cartesTirees: new Map<JoueurId, Carte[]>([
    ['j1', [c('pique', 5), c('carreau', 9)]],
    ['j2', [c('coeur', 5), joker()]],
    ['j3', [c('trefle', 'R')]],
  ]),
});
const rien = () => new Map<JoueurId, number[]>();

describe('tirage en direct — qui retourne quand', () => {
  it('laisse chacun retourner sa premiere carte, dans l ordre qu il veut', () => {
    expect(joueursARetourner(tirage(), rien())).toEqual(['j1', 'j2', 'j3']);
  });

  it('n ouvre le retirage qu une fois la premiere manche retournee par tous', () => {
    const t = tirage();
    let r = retournerCarte(t, rien(), 'j1', 10);
    r = retournerCarte(t, r, 'j2', 20);
    expect(joueursARetourner(t, r)).toEqual(['j3']);
    expect(() => retournerCarte(t, r, 'j1', 30)).toThrow(/Attendez/);

    r = retournerCarte(t, r, 'j3', 40);
    expect(joueursARetourner(t, r)).toEqual(['j1', 'j2']);
  });

  it('refuse une carte deja retournee, hors de l etalage, ou un joueur qui a fini', () => {
    const t = tirage();
    const r = retournerCarte(t, rien(), 'j3', 5);
    expect(() => retournerCarte(t, r, 'j1', 5)).toThrow(/deja ete retournee/);
    expect(() => retournerCarte(t, r, 'j1', 109)).toThrow(/etalage/);
    expect(() => retournerCarte(t, r, 'j1', 'cinq')).toThrow(/etalage/);
    expect(() => retournerCarte(t, r, 'j3', 6)).toThrow(/deja retournee/);
    expect(() => retournerCarte(t, r, 'j9', 6)).toThrow(/part/);
  });
});

describe('tirage en direct — ce qui est montre', () => {
  it('ne montre aucune carte tant que personne n a rien retourne', () => {
    const vue = filtrerTirage(tirage(), rien());
    expect(Object.values(vue.retournees).flat()).toEqual([]);
    expect(JSON.stringify(vue)).not.toContain('"type"');
    expect(vue.complet).toBe(false);
    expect(vue.ordreTable).toBeNull();
    expect(vue.donneurInitial).toBeNull();
  });

  it('montre la carte retournee a sa place, sous un identifiant propre au tirage, et celle-la seule', () => {
    const t = tirage();
    const vue = filtrerTirage(t, retournerCarte(t, rien(), 'j1', 42));
    expect(vue.retournees['j1']).toEqual([
      { place: 42, carte: { type: 'normale', couleur: 'pique', valeur: 5, id: 'tirage-j1-0' } },
    ]);
    expect(vue.retournees['j2']).toEqual([]);
    expect(vue.retournees['j3']).toEqual([]);
  });

  it('donne sieges, donneur et jokers gardes une fois tout retourne', () => {
    const t = tirage();
    let r = rien();
    for (const [joueurId, place] of [['j1', 1], ['j2', 2], ['j3', 3], ['j1', 4], ['j2', 5]] as const) {
      r = retournerCarte(t, r, joueurId, place);
    }
    const vue = filtrerTirage(t, r);

    expect(tirageComplet(t, r)).toBe(true);
    expect(vue.complet).toBe(true);
    expect(vue.aRetourner).toEqual([]);
    expect(vue.ordreTable).toEqual(['j2', 'j1', 'j3']);
    expect(vue.donneurInitial).toBe('j2');
    expect(vue.jokersConserves['j2']?.map((carte) => carte.type)).toEqual(['joker']);
    expect(vue.jokersConserves['j1']).toEqual([]);
  });
});
