import { describe, expect, it } from 'vitest';
import {
  construirePaquet,
  distribuerCartes,
  melangerPaquet,
  redistribuerApresFricheGeneralisee,
  TAILLE_PAQUET,
} from '../game-engine/distribution.js';
import { coucou, joker, joueur } from './fixtures.js';
import { CARTES_PAR_JOUEUR } from '../models/index.js';

/** Réf. docs/REGLES.md § « Joueurs et matériel » et § « Phase Friche / Je joue ». */

/** Générateur déterministe, pour un mélange reproductible dans les tests. */
const aleaFixe = (): (() => number) => {
  let graine = 42;
  return () => {
    graine = (graine * 1103515245 + 12345) % 2147483648;
    return graine / 2147483648;
  };
};

describe('construirePaquet', () => {
  it('construit 109 cartes : 2 jeux de 52, 4 jokers et le coucou', () => {
    const paquet = construirePaquet();
    expect(paquet).toHaveLength(TAILLE_PAQUET);
    expect(paquet.filter((carte) => carte.type === 'normale')).toHaveLength(104);
    expect(paquet.filter((carte) => carte.type === 'joker')).toHaveLength(4);
    expect(paquet.filter((carte) => carte.type === 'coucou')).toHaveLength(1);
  });

  it('donne un identifiant unique a chaque carte, doublons des 2 jeux compris', () => {
    const paquet = construirePaquet();
    expect(new Set(paquet.map((carte) => carte.id)).size).toBe(TAILLE_PAQUET);
  });
});

describe('melangerPaquet', () => {
  it('conserve exactement les memes cartes', () => {
    const paquet = construirePaquet();
    const melange = melangerPaquet(paquet, aleaFixe());

    expect(melange).toHaveLength(paquet.length);
    expect(new Set(melange.map((c) => c.id))).toEqual(new Set(paquet.map((c) => c.id)));
  });

  it('ne modifie pas le paquet d origine', () => {
    const paquet = construirePaquet();
    const avant = paquet.map((c) => c.id);
    melangerPaquet(paquet, aleaFixe());
    expect(paquet.map((c) => c.id)).toEqual(avant);
  });
});

describe('distribuerCartes', () => {
  const joueurs = () => [joueur('j1'), joueur('j2'), joueur('j3')];

  it('donne 14 cartes a chaque joueur', () => {
    const { mains } = distribuerCartes(joueurs(), construirePaquet());
    for (const id of ['j1', 'j2', 'j3']) {
      expect(mains[id]).toHaveLength(CARTES_PAR_JOUEUR);
    }
  });

  it('laisse le reste du paquet dans la pioche, sans perdre ni dupliquer de carte', () => {
    const paquet = construirePaquet();
    const { mains, pioche } = distribuerCartes(joueurs(), paquet);

    expect(pioche).toHaveLength(TAILLE_PAQUET - 3 * CARTES_PAR_JOUEUR);
    const distribuees = Object.values(mains).flat();
    expect(new Set([...distribuees, ...pioche].map((c) => c.id)).size).toBe(TAILLE_PAQUET);
  });

  it('distribue les cartes 2 par 2, en faisant le tour de la table', () => {
    const paquet = construirePaquet();
    const { mains } = distribuerCartes(joueurs(), paquet);

    // Premier tour : j1 recoit les cartes 0 et 1, j2 les 2 et 3, j3 les 4 et 5,
    // puis j1 reprend aux cartes 6 et 7.
    expect(mains['j1']?.slice(0, 2).map((c) => c.id)).toEqual(paquet.slice(0, 2).map((c) => c.id));
    expect(mains['j2']?.slice(0, 2).map((c) => c.id)).toEqual(paquet.slice(2, 4).map((c) => c.id));
    expect(mains['j3']?.slice(0, 2).map((c) => c.id)).toEqual(paquet.slice(4, 6).map((c) => c.id));
    expect(mains['j1']?.slice(2, 4).map((c) => c.id)).toEqual(paquet.slice(6, 8).map((c) => c.id));
  });

  it('refuse de distribuer avec un paquet trop court', () => {
    expect(() => distribuerCartes(joueurs(), construirePaquet().slice(0, 20))).toThrow();
  });

  it('refuse une table sans joueur', () => {
    expect(() => distribuerCartes([], construirePaquet())).toThrow();
  });
});

describe('redistribuerApresFricheGeneralisee', () => {
  it('ne donne que 12 cartes a un joueur qui conserve 2 jokers', () => {
    const jokersDeJ1 = [joker(), joker()];
    const { mains } = redistribuerApresFricheGeneralisee(
      { j1: jokersDeJ1, j2: [], j3: [] },
      construirePaquet(),
    );

    expect(mains['j1']).toHaveLength(CARTES_PAR_JOUEUR);
    expect(mains['j2']).toHaveLength(CARTES_PAR_JOUEUR);
    // Les 2 jokers conserves sont toujours la, seules 12 cartes sont nouvelles.
    const idsConserves = jokersDeJ1.map((c) => c.id);
    expect(mains['j1']?.filter((c) => idsConserves.includes(c.id))).toHaveLength(2);
    expect(mains['j1']?.filter((c) => !idsConserves.includes(c.id))).toHaveLength(12);
  });

  it('conserve aussi le coucou', () => {
    const superJoker = coucou();
    const { mains } = redistribuerApresFricheGeneralisee(
      { j1: [superJoker], j2: [] },
      construirePaquet(),
    );

    expect(mains['j1']?.map((c) => c.id)).toContain(superJoker.id);
    expect(mains['j1']).toHaveLength(CARTES_PAR_JOUEUR);
  });

  it('retire du paquet restant exactement les cartes distribuees', () => {
    const paquet = construirePaquet();
    const { mains, pioche } = redistribuerApresFricheGeneralisee(
      { j1: [joker()], j2: [], j3: [] },
      paquet,
    );

    // 13 + 14 + 14 = 41 cartes tirees du paquet.
    expect(pioche).toHaveLength(paquet.length - 41);
    const nouvelles = Object.values(mains)
      .flat()
      .filter((c) => paquet.some((p) => p.id === c.id));
    expect(new Set([...nouvelles, ...pioche].map((c) => c.id)).size).toBe(paquet.length);
  });

  it('refuse de conserver une carte qui n est pas un joker', () => {
    const paquet = construirePaquet();
    const carteNormale = paquet.find((c) => c.type === 'normale');
    expect(() =>
      redistribuerApresFricheGeneralisee({ j1: [carteNormale!], j2: [] }, paquet),
    ).toThrow();
  });

  it('refuse un paquet restant trop court', () => {
    expect(() =>
      redistribuerApresFricheGeneralisee({ j1: [], j2: [] }, construirePaquet().slice(0, 10)),
    ).toThrow();
  });
});
