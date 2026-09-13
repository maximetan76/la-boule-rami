import { describe, expect, it } from 'vitest';
import { rangDeTirage, tirerSiegesEtDonneurInitial } from '../game-engine/boule.js';
import {
  construirePaquet,
  distribuerAvecCartesConservees,
} from '../game-engine/distribution.js';
import { c, coucou, joker, joueur } from './fixtures.js';
import type { Carte, JoueurId } from '../models/index.js';
import { CARTES_PAR_JOUEUR } from '../models/index.js';

/**
 * Tirage d'ouverture d'une Boule : chaque joueur tire une carte, la plus basse
 * donne, et les sièges suivent l'ordre croissant des cartes tirées.
 */

const table = (...ids: JoueurId[]) => ids.map((id) => joueur(id));

/** Paquet dont les premières cartes sont tirées dans l'ordre des joueurs. */
const paquetOrdonne = (...cartes: Carte[]): Carte[] => [...cartes, ...construirePaquet()];

describe('rangDeTirage', () => {
  it('classe du plus bas au plus haut : jokers, puis 2 a 10, figures, as', () => {
    expect(rangDeTirage(joker())).toBe(rangDeTirage(coucou()));
    expect(rangDeTirage(joker())).toBeLessThan(rangDeTirage(c('pique', 2)));
    expect(rangDeTirage(c('pique', 2))).toBeLessThan(rangDeTirage(c('pique', 10)));
    expect(rangDeTirage(c('pique', 10))).toBeLessThan(rangDeTirage(c('pique', 'V')));
    expect(rangDeTirage(c('pique', 'V'))).toBeLessThan(rangDeTirage(c('pique', 'D')));
    expect(rangDeTirage(c('pique', 'D'))).toBeLessThan(rangDeTirage(c('pique', 'R')));
    expect(rangDeTirage(c('pique', 'R'))).toBeLessThan(rangDeTirage(c('pique', 'A')));
  });
});

describe('tirerSiegesEtDonneurInitial — sans egalite', () => {
  it('asseoit les joueurs dans l ordre croissant des cartes tirees', () => {
    const paquet = paquetOrdonne(c('pique', 5), c('coeur', 9), c('trefle', 'R'), c('carreau', 2));
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3', 'j4'), paquet);

    expect(tirage.ordreTable).toEqual(['j4', 'j1', 'j2', 'j3']);
  });

  it('fait donner celui qui a tire la carte la plus basse, en tete de table', () => {
    const paquet = paquetOrdonne(c('pique', 5), c('coeur', 9), c('trefle', 'R'), c('carreau', 2));
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3', 'j4'), paquet);

    expect(tirage.donneurInitial).toBe('j4');
    expect(tirage.ordreTable[0]).toBe('j4');
  });

  it('place l as au plus haut, pas au plus bas', () => {
    const paquet = paquetOrdonne(c('pique', 'A'), c('coeur', 2), c('trefle', 3));
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3'), paquet);

    expect(tirage.ordreTable).toEqual(['j2', 'j3', 'j1']);
  });

  it('ne conserve aucune carte quand personne ne tire de joker', () => {
    const paquet = paquetOrdonne(c('pique', 5), c('coeur', 9), c('trefle', 'R'));
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3'), paquet);

    expect([...tirage.cartesConserveesParJoueur.values()].flat()).toEqual([]);
  });
});

describe('tirerSiegesEtDonneurInitial — egalites', () => {
  it('ne fait retirer que les joueurs a egalite, et departage entre eux', () => {
    // j1 et j2 tirent 7, j3 tire 10. Les deux cartes suivantes departagent
    // j1 et j2 : j1 prend le 4, j2 le 3, donc j2 passe devant j1.
    const paquet = paquetOrdonne(
      c('pique', 7),
      c('coeur', 7),
      c('trefle', 10),
      c('carreau', 4),
      c('pique', 3),
    );
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3'), paquet);

    expect(tirage.ordreTable).toEqual(['j2', 'j1', 'j3']);
    expect(tirage.donneurInitial).toBe('j2');
  });

  it('laisse la seconde carte sans effet sur le rang face aux joueurs hors egalite', () => {
    // j1 et j2 sont a egalite sur 7, j3 a tire 10. Le second tirage donne un as
    // a j1 : s il comptait globalement, j1 passerait derriere j3. Il ne sert
    // qu a departager j1 et j2, qui restent tous deux devant j3.
    const paquet = paquetOrdonne(
      c('pique', 7),
      c('coeur', 7),
      c('trefle', 10),
      c('carreau', 'A'),
      c('pique', 3),
    );
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3'), paquet);

    expect(tirage.ordreTable).toEqual(['j2', 'j1', 'j3']);
  });

  it('retire jusqu a resolution quand l egalite persiste', () => {
    // j1 et j2 tirent 7, puis 5 et 5, puis enfin 9 et 2.
    const paquet = paquetOrdonne(
      c('pique', 7),
      c('coeur', 7),
      c('trefle', 10),
      c('carreau', 5),
      c('pique', 5),
      c('coeur', 9),
      c('trefle', 2),
    );
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3'), paquet);

    expect(tirage.ordreTable).toEqual(['j2', 'j1', 'j3']);
  });

  it('departage un joker et le coucou, ex aequo au rang le plus bas', () => {
    const superJoker = coucou();
    const jokerNormal = joker();
    const paquet = paquetOrdonne(
      jokerNormal,
      superJoker,
      c('trefle', 10),
      c('carreau', 8),
      c('pique', 3),
    );
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3'), paquet);

    // Les deux jokers sont a egalite : le second tirage met j2 devant j1.
    expect(tirage.ordreTable).toEqual(['j2', 'j1', 'j3']);
    expect(tirage.donneurInitial).toBe('j2');
  });

  it('departage trois joueurs a egalite sans toucher au quatrieme', () => {
    const paquet = paquetOrdonne(
      c('pique', 6),
      c('coeur', 6),
      c('trefle', 6),
      c('carreau', 'R'),
      c('pique', 9),
      c('coeur', 4),
      c('trefle', 'D'),
    );
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3', 'j4'), paquet);

    // j1 -> 9, j2 -> 4, j3 -> D : ordre j2, j1, j3, puis j4 qui avait le roi.
    expect(tirage.ordreTable).toEqual(['j2', 'j1', 'j3', 'j4']);
  });

  it('refuse un paquet trop court pour departager', () => {
    const paquet = [c('pique', 7), c('coeur', 7)];
    expect(() => tirerSiegesEtDonneurInitial(table('j1', 'j2'), paquet)).toThrow();
  });
});

describe('tirerSiegesEtDonneurInitial — jokers conservés', () => {
  it('garde le joker tire dans les cartes conservees de son joueur', () => {
    const jokerTire = joker();
    const paquet = paquetOrdonne(jokerTire, c('coeur', 9), c('trefle', 'R'));
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3'), paquet);

    expect(tirage.cartesConserveesParJoueur.get('j1')?.map((carte) => carte.id)).toEqual([
      jokerTire.id,
    ]);
    expect(tirage.cartesConserveesParJoueur.get('j2')).toEqual([]);
  });

  it('retrouve le joker dans la main de depart du premier coup', () => {
    // § « il conserve cette carte en main pour la distribution du tout premier
    // coup » : la donne ne lui sert que le complement a 14.
    const jokerTire = joker();
    const paquetComplet = construirePaquet();
    const paquet = [jokerTire, c('coeur', 9), c('trefle', 'R'), ...paquetComplet];
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3'), paquet);

    const conservees: Record<JoueurId, Carte[]> = {};
    for (const [joueurId, cartes] of tirage.cartesConserveesParJoueur) {
      conservees[joueurId] = cartes;
    }
    const { mains } = distribuerAvecCartesConservees(conservees, paquetComplet);

    expect(mains['j1']).toHaveLength(CARTES_PAR_JOUEUR);
    expect(mains['j1']?.map((carte) => carte.id)).toContain(jokerTire.id);
    // 13 cartes seulement lui ont ete servies.
    expect(mains['j1']?.filter((carte) => carte.id !== jokerTire.id)).toHaveLength(13);
    expect(mains['j2']).toHaveLength(CARTES_PAR_JOUEUR);
  });
});

describe('tirerSiegesEtDonneurInitial — cartes tirees', () => {
  it('rend la carte tiree par chacun, puis celles des retirages', () => {
    // j1 et j2 tirent un 5 : eux seuls retirent, 9 pour j1, 2 pour j2.
    const paquet = paquetOrdonne(
      c('pique', 5), c('coeur', 5), c('trefle', 'R'), c('carreau', 9), c('pique', 2),
    );
    const tirage = tirerSiegesEtDonneurInitial(table('j1', 'j2', 'j3'), paquet);
    const ids = (joueurId: JoueurId) => tirage.cartesTirees.get(joueurId)?.map((carte) => carte.id);

    expect(ids('j1')).toEqual([paquet[0]!.id, paquet[3]!.id]);
    expect(ids('j2')).toEqual([paquet[1]!.id, paquet[4]!.id]);
    expect(ids('j3')).toEqual([paquet[2]!.id]);
    expect(tirage.ordreTable).toEqual(['j2', 'j1', 'j3']);
  });
});
