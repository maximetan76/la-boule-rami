import { describe, expect, it } from 'vitest';
import { avecDernierTour, decrireDernierTour, estCarreFerme } from '../game-engine/dernier-tour.js';
import { echangerJoker, jouerTour } from '../game-engine/tour.js';
import { c, coup, ensemble, joker, jokerPour, recap, tierce } from './fixtures.js';
import type { Carte, Coup } from '../models/index.js';

/**
 * Réf. docs/REGLES.md § « Règle spéciale : piocher la carte de la défausse » et
 * § « Récupération d'un joker posé ». Ce qu'un tour vient de changer sur la
 * table, tel que les autres joueurs doivent le voir — même à qui se connecte
 * après coup.
 */

const tableDe = (main: Carte[], partiel: Parameters<typeof coup>[0] = {}) =>
  coup({
    mains: { j1: main, j2: [], j3: [] },
    pioche: [c('carreau', 2), c('carreau', 3)],
    recapitulatifs: { j1: recap(), j2: recap(), j3: recap() },
    ...partiel,
  });

const tour = (partiel: Partial<Parameters<typeof decrireDernierTour>[2]> = {}) => ({
  id: 'tour-1',
  joueurId: 'j1',
  source: 'pioche' as const,
  cartePiochee: c('pique', 4),
  ...partiel,
});

describe('decrireDernierTour', () => {
  it('une prise en defausse : la carte prise, meme gardee en main', () => {
    const prise = c('trefle', 7);
    const avant = tableDe([c('pique', 5)]);
    const decrit = decrireDernierTour(avant, avant, tour({ source: 'defausse', cartePiochee: prise }));
    expect(decrit).toMatchObject({ id: 'tour-1', joueurId: 'j1', priseEnDefausse: prise, jokersRepris: [], carresFermes: [] });
  });

  it('un tour ordinaire, qui ne change rien sur la table : rien a dire', () => {
    const avant = tableDe([c('pique', 5)]);
    expect(decrireDernierTour(avant, avant, tour())).toBeUndefined();
  });

  it('un joker repris par echange, et la vraie carte donnee a sa place', () => {
    const jokerEn6 = jokerPour('trefle', 6);
    const chezJ2 = tierce('trefle', [c('trefle', 5), jokerEn6, c('trefle', 7)], 'j2', 1);
    const six = c('trefle', 6);
    const paire = [c('pique', 8), c('coeur', 8)];
    const aJeter = c('carreau', 'R');
    const depart = tableDe([six, ...paire, aJeter], { combinaisons: [chezJ2] });
    const { coup: avecEchange, joker: repris } = echangerJoker(depart, 'j1', six, {
      combinaisonId: chezJ2.id,
      carteJokerId: jokerEn6.carte.id,
    });
    const { coup: apres } = jouerTour(avecEchange, 'j1', {
      source: 'pioche',
      poses: [ensemble(8, [...paire, { carte: repris, remplace: { couleur: 'carreau', valeur: 8 } }])],
      carteDefausseeId: aJeter.id,
      jokersRecuperes: [repris.id],
    });

    const decrit = decrireDernierTour(depart, apres, tour());
    expect(decrit?.jokersRepris).toEqual([{ joker: jokerEn6.carte, carteFournie: six }]);
    // La vraie carte et la combinaison neuve sont arrivees sur la table ; pas le joker, qui y etait deja.
    expect(new Set(decrit?.cartesPosees)).toEqual(new Set([six.id, ...paire.map((carte) => carte.id)]));
  });

  it('un joker repris puis garde en main ne se dit pas : il n\'est plus sur la table', () => {
    const jokerEn8 = jokerPour('carreau', 8);
    const brelan = ensemble(8, [c('pique', 8), c('coeur', 8), jokerEn8], 'j2', 1);
    const huit = c('carreau', 8);
    const aJeter = c('carreau', 'R');
    const depart = tableDe([huit, aJeter], { combinaisons: [brelan], recapitulatifs: { j1: recap(), j2: recap(), j3: recap() } });
    // Un ajout qui rend le joker : il rejoint la main, rien n'oblige à le replacer.
    const { coup: apres } = jouerTour(depart, 'j1', {
      source: 'pioche',
      ajouts: [{ combinaisonId: brelan.id, cartes: [{ carte: huit, remplace: null }] }],
      carteDefausseeId: aJeter.id,
    });
    expect(apres.mains['j1']?.some((carte) => carte.id === jokerEn8.carte.id)).toBe(true);
    expect(decrireDernierTour(depart, apres, tour())?.jokersRepris).toEqual([]);
  });

  it('deux jokers repris dans le meme tour : deux reprises, dans l\'ordre de la table', () => {
    const j6 = jokerPour('trefle', 6);
    const j9 = jokerPour('coeur', 9);
    const chezJ2 = tierce('trefle', [c('trefle', 5), j6, c('trefle', 7)], 'j2', 1);
    const chezJ3 = tierce('coeur', [c('coeur', 8), j9, c('coeur', 10)], 'j3', 1);
    const six = c('trefle', 6);
    const neuf = c('coeur', 9);
    const paireDeDeux = [c('pique', 2), c('coeur', 2)];
    const paireDeCinq = [c('pique', 5), c('coeur', 5)];
    const aJeter = c('carreau', 'R');
    const depart = tableDe([six, neuf, ...paireDeDeux, ...paireDeCinq, aJeter], { combinaisons: [chezJ2, chezJ3] });
    const premier = echangerJoker(depart, 'j1', six, { combinaisonId: chezJ2.id, carteJokerId: j6.carte.id });
    const second = echangerJoker(premier.coup, 'j1', neuf, { combinaisonId: chezJ3.id, carteJokerId: j9.carte.id });
    const { coup: apres } = jouerTour(second.coup, 'j1', {
      source: 'pioche',
      poses: [
        ensemble(2, [...paireDeDeux, { carte: premier.joker, remplace: { couleur: 'carreau', valeur: 2 } }]),
        ensemble(5, [...paireDeCinq, { carte: second.joker, remplace: { couleur: 'carreau', valeur: 5 } }]),
      ],
      carteDefausseeId: aJeter.id,
      jokersRecuperes: [premier.joker.id, second.joker.id],
    });
    expect(decrireDernierTour(depart, apres, tour())?.jokersRepris).toEqual([
      { joker: j6.carte, carteFournie: six },
      { joker: j9.carte, carteFournie: neuf },
    ]);
  });

  describe('un carre ferme', () => {
    const quatreRois = () => [c('pique', 'R'), c('coeur', 'R'), c('carreau', 'R'), c('trefle', 'R')];

    it('un brelan complete en carre franc : ferme par ce tour', () => {
      const trois = quatreRois().slice(0, 3);
      const quatrieme = c('trefle', 'R');
      const brelan = ensemble('R', trois, 'j1', 1);
      const aJeter = c('carreau', 3);
      const depart = tableDe([quatrieme, aJeter], { combinaisons: [brelan] });
      const { coup: apres } = jouerTour(depart, 'j1', {
        source: 'pioche',
        ajouts: [{ combinaisonId: brelan.id, cartes: [{ carte: quatrieme, remplace: null }] }],
        carteDefausseeId: aJeter.id,
      });
      expect(decrireDernierTour(depart, apres, tour())?.carresFermes).toEqual([brelan.id]);
    });

    it('un carre deja ferme avant ce tour : pas un nouvel evenement', () => {
      const carre = ensemble('R', quatreRois(), 'j1', 1);
      const avant = tableDe([c('pique', 5)], { combinaisons: [carre] });
      expect(decrireDernierTour(avant, avant, tour())).toBeUndefined();
    });

    it('un joker ajoute a un brelan franc fait un carre AVEC joker : jamais ferme, quoi que dise `pure`', () => {
      const brelan = ensemble('R', quatreRois().slice(0, 3), 'j1', 1);
      const j = joker();
      const aJeter = c('carreau', 3);
      const depart = tableDe([j, aJeter], { combinaisons: [brelan] });
      const { coup: apres } = jouerTour(depart, 'j1', {
        source: 'pioche',
        ajouts: [{ combinaisonId: brelan.id, cartes: [{ carte: j, remplace: null }] }],
        carteDefausseeId: aJeter.id,
      });
      const carre = apres.combinaisons[0]!;
      expect(carre.pure).toBe(true); // le cache est perime : c'est pourquoi on lit les cartes
      expect(estCarreFerme(carre)).toBe(false);
      expect(decrireDernierTour(depart, apres, tour())?.carresFermes ?? []).toEqual([]);
    });

    it('un carre dont on reprend le joker a quatre cartes reelles : ferme, quoi que dise `pure`', () => {
      const jk = jokerPour('trefle', 'R');
      const carreAvecJoker = ensemble('R', [...quatreRois().slice(0, 3), jk], 'j2', 1);
      const vraie = c('trefle', 'R');
      const reste = [c('pique', 2), c('coeur', 2), c('carreau', 2)];
      const aJeter = c('carreau', 3);
      const depart = tableDe([vraie, ...reste, aJeter], { combinaisons: [carreAvecJoker] });
      const { coup: avecEchange, joker: repris } = echangerJoker(depart, 'j1', vraie, {
        combinaisonId: carreAvecJoker.id,
        carteJokerId: jk.carte.id,
      });
      const { coup: apres } = jouerTour(avecEchange, 'j1', {
        source: 'pioche',
        poses: [ensemble(2, [...reste, { carte: repris, remplace: { couleur: 'trefle', valeur: 2 } }])],
        carteDefausseeId: aJeter.id,
        jokersRecuperes: [repris.id],
      });
      const carre = apres.combinaisons.find((combinaison) => combinaison.id === carreAvecJoker.id)!;
      expect(carre.pure).toBe(false); // périmé lui aussi
      expect(estCarreFerme(carre)).toBe(true);
      expect(decrireDernierTour(depart, apres, tour())?.carresFermes).toEqual([carreAvecJoker.id]);
    });
  });
});

describe('avecDernierTour', () => {
  const dernier = { id: 't', joueurId: 'j1', priseEnDefausse: null, jokersRepris: [], carresFermes: [], cartesPosees: ['x'] };

  it('pose le dernier tour sur le coup, sans toucher au reste', () => {
    const base: Coup = coup();
    const avec = avecDernierTour(base, dernier);
    expect(avec.dernierTour).toEqual(dernier);
    expect({ ...avec, dernierTour: undefined }).toEqual({ ...base, dernierTour: undefined });
  });

  it('le retire quand rien ne s\'en montre : la cle disparait, elle n\'est pas mise a undefined', () => {
    const sans = avecDernierTour(avecDernierTour(coup(), dernier), undefined);
    expect('dernierTour' in sans).toBe(false);
  });
});
