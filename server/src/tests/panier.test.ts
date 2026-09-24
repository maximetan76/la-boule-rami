import { describe, expect, it } from 'vitest';
import {
  construirePaquet,
  distribuerLePanier,
  enregistrerResultatManche,
  estMatchTermine,
  initialiserMatchPanier,
  numeroMancheCourant,
  composerManche,
} from '../game-engine/index.js';
import { melangerPaquet } from '../game-engine/distribution.js';
import { estJoker } from '../game-engine/cartes.js';
import { reglesDe } from '../game-engine/variantes.js';
import type { Joueur } from '../models/index.js';

const JOUEURS: Joueur[] = [
  { id: 'ana', nom: 'Ana', croix: 0 },
  { id: 'bo', nom: 'Bo', croix: 0 },
];

describe('le panier : paquet et donne', () => {
  it('106 cartes : 2 x 52 et 2 jokers, jamais de coucou', () => {
    const paquet = construirePaquet('panier');
    expect(paquet).toHaveLength(106);
    expect(paquet.filter(estJoker)).toHaveLength(2);
    expect(paquet.some((carte) => carte.type === 'coucou')).toBe(false);
  });

  it('la Boule garde ses 109 cartes : 4 jokers et le coucou', () => {
    const paquet = construirePaquet('boule');
    expect(paquet).toHaveLength(109);
    expect(paquet.filter((carte) => carte.type === 'joker')).toHaveLength(4);
    expect(paquet.some((carte) => carte.type === 'coucou')).toBe(true);
  });

  it('chaque joueur recoit 13 cartes ordinaires et un joker d office : jamais de joker au talon', () => {
    const paquet = melangerPaquet(construirePaquet('panier'), () => 0.42);
    const { mains, pioche } = distribuerLePanier(JOUEURS, paquet);

    for (const joueur of JOUEURS) {
      const main = mains[joueur.id] ?? [];
      expect(main).toHaveLength(14);
      expect(main.filter(estJoker)).toHaveLength(1);
    }
    expect(pioche.some(estJoker)).toBe(false);
    expect(pioche).toHaveLength(106 - 2 * 13 - 2);
  });

  it('refuse un paquet sans un joker par joueur', () => {
    const sansJoker = construirePaquet('panier').filter((carte) => !estJoker(carte));
    expect(() => distribuerLePanier(JOUEURS, sansJoker)).toThrow(/joker/);
  });
});

describe('le panier : regles de variante', () => {
  it('la prise en defausse est libre, la pose ne sert qu a finir, la parole ne fait qu un tour', () => {
    const regles = reglesDe('panier');
    expect(regles.priseDefausseLibre).toBe(true);
    expect(regles.poseSeulementPourFinir).toBe(true);
    expect(regles.parolePremierTourSeulement).toBe(true);
    expect(regles.conserverLesJokersARedistribution).toBe(false);
    expect(regles.jokerParJoueur).toBe(true);
    expect(regles.avecCoucou).toBe(false);
    expect(regles.matchEnManches).toBe(true);
  });

  it('sans variante precisee ou pour la Boule, le comportement habituel', () => {
    expect(reglesDe(undefined)).toEqual(reglesDe('boule'));
    expect(reglesDe('boule').poseSeulementPourFinir).toBe(false);
    expect(reglesDe('boule').priseDefausseLibre).toBe(false);
  });
});

describe('le panier : le match', () => {
  it('personne n a gagne au depart, et le donneur alterne a chaque manche', () => {
    const match = initialiserMatchPanier(JOUEURS, 3, 10);
    expect(match.manchesGagnees).toEqual({ ana: 0, bo: 0 });
    expect(estMatchTermine(match)).toBe(false);
    expect(numeroMancheCourant(match)).toBe(1);

    // La composition suit determinerJoueursAssis : le donneur avance d un
    // siege par manche, comme a La Boule.
    expect(composerManche(match, 1).donneurId).toBe('ana');
    expect(composerManche(match, 1).joueursActifs).toEqual(['bo', 'ana']);
    expect(composerManche(match, 2).donneurId).toBe('bo');
    expect(composerManche(match, 2).joueursActifs).toEqual(['ana', 'bo']);
  });

  it('exige exactement deux joueurs', () => {
    expect(() => initialiserMatchPanier([JOUEURS[0] as Joueur], 3, 10)).toThrow(/deux/);
  });

  it('une manche gagnee compte, meme sans y avoir gagne « de suite »', () => {
    let match = initialiserMatchPanier(JOUEURS, 3, 10);
    const manche = (gagnantId: string) => ({ gagnantId, combinaisons: [], mainsRevelees: {} });

    match = enregistrerResultatManche(match, 1, manche('ana'));
    match = enregistrerResultatManche(match, 2, manche('bo'));
    match = enregistrerResultatManche(match, 3, manche('ana'));
    expect(match.manchesGagnees).toEqual({ ana: 2, bo: 1 });
    expect(estMatchTermine(match)).toBe(false);

    match = enregistrerResultatManche(match, 4, manche('ana'));
    expect(match.manchesGagnees.ana).toBe(3);
    expect(match.vainqueurId).toBe('ana');
    expect(estMatchTermine(match)).toBe(true);
    expect(match.historique).toHaveLength(4);
  });

  it('une friche generale ne fait pas avancer le numero de manche : elle rejoue a la meme place', () => {
    let match = initialiserMatchPanier(JOUEURS, 3, 10);
    match = enregistrerResultatManche(match, 1, { toutLeMondeAFriche: true });
    expect(match.historique).toHaveLength(0);
    expect(numeroMancheCourant(match)).toBe(1);
    expect(match.manchesGagnees).toEqual({ ana: 0, bo: 0 });
  });

  it('refuse d enregistrer une manche hors de son rang', () => {
    const match = initialiserMatchPanier(JOUEURS, 3, 10);
    expect(() =>
      enregistrerResultatManche(match, 2, { gagnantId: 'ana', combinaisons: [], mainsRevelees: {} }),
    ).toThrow(/rang/);
  });
});
