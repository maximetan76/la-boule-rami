import { describe, expect, it } from 'vitest';
import {
  filtrerTirage,
  joueursARetourner,
  retournerCarte,
  retournerPourLesPasseurs,
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

/** Deux joueurs à égalité : a et b tirent un 5, puis a un 9 et b un 10. */
const egalite = () => ({
  ordreTable: ['a', 'b'],
  donneurInitial: 'a',
  cartesTirees: new Map<JoueurId, Carte[]>([
    ['a', [c('pique', 5), c('coeur', 9)]],
    ['b', [c('coeur', 5), c('trefle', 10)]],
  ]),
});
/** Un tirage au sort qui prend toujours la première place libre : lisible dans un test. */
const premiereLibre = () => 0;

describe('tirage en direct — qui a passé', () => {
  it('retourne la carte de celui qui passe, tout de suite, sans toucher à celle des autres', () => {
    const t = egalite();
    const r = retournerPourLesPasseurs(t, rien(), new Set(['a']), premiereLibre);
    expect(r.get('a')).toEqual([0]);
    expect(r.get('b')).toBeUndefined();
    // Elle est retournée comme n'importe quelle autre : tous la voient.
    expect(filtrerTirage(t, r).retournees['a']?.map((retournee) => retournee.carte)).toMatchObject([
      { type: 'normale', couleur: 'pique', valeur: 5 },
    ]);
  });

  it('le sert aussi au retirage, dès que la manche précédente est retournée par tous', () => {
    const t = egalite();
    // a passe avant que rien ne se sache : sa première carte part, pas son retirage.
    let r = retournerPourLesPasseurs(t, rien(), new Set(['a']), premiereLibre);
    expect(joueursARetourner(t, r)).toEqual(['b']);

    // b retourne son 5 : égalité, le retirage s'ouvre — et a y est servi d'office.
    r = retournerCarte(t, r, 'b', 20);
    r = retournerPourLesPasseurs(t, r, new Set(['a']), premiereLibre);
    expect(r.get('a')).toEqual([0, 1]);
    expect(joueursARetourner(t, r)).toEqual(['b']);

    // Il ne reste que b à toucher : le tirage se termine sans attendre a.
    r = retournerCarte(t, r, 'b', 30);
    expect(tirageComplet(t, r)).toBe(true);
  });

  it('sert chacun de ceux qui passent, jusqu au bout', () => {
    const t = egalite();
    const r = retournerPourLesPasseurs(t, rien(), new Set(['a', 'b']), premiereLibre);
    expect(tirageComplet(t, r)).toBe(true);
    // Chaque carte à sa propre place : aucune n'est retournée deux fois.
    const places = [...r.values()].flat();
    expect(new Set(places).size).toBe(places.length);
  });

  it('ne change rien quand personne n a passé, ni quand le tirage est fini', () => {
    const t = egalite();
    expect(retournerPourLesPasseurs(t, rien(), new Set(), premiereLibre)).toEqual(rien());
    const fini = retournerPourLesPasseurs(t, rien(), new Set(['a', 'b']), premiereLibre);
    expect(retournerPourLesPasseurs(t, fini, new Set(['a', 'b']), premiereLibre)).toEqual(fini);
  });

  it('prend une place libre : jamais une carte déjà retournée', () => {
    const t = egalite();
    const r = retournerPourLesPasseurs(t, retournerCarte(t, rien(), 'b', 0), new Set(['a']), premiereLibre);
    // La place 0 est prise par b : a reçoit la suivante, puis la suivante pour son retirage (5-5).
    expect(r.get('a')).toEqual([1, 2]);
  });
});
