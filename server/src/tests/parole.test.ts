import { describe, expect, it } from 'vitest';
import { annoncer, apresTour, engageInterroge } from '../game-engine/parole.js';
import { calculerScoreCoup } from '../game-engine/scoring.js';
import { jouerTour } from '../game-engine/tour.js';
import type { Carte, Coup, Couleur, JoueurId } from '../models/index.js';
import { c, recap, tierce } from './fixtures.js';

/**
 * Réf. docs/REGLES.md § « Phase Friche / Je joue ». Quatre joueurs, dans
 * l'ordre B, C, D, A : B est à la gauche du donneur, il parle et joue le
 * premier. Les trois exemples donnés mot pour mot, rejoués tels quels.
 */

const ORDRE: JoueurId[] = ['B', 'C', 'D', 'A'];
const COULEURS: Couleur[] = ['pique', 'coeur', 'carreau', 'trefle'];

const debut = (mains: Partial<Record<JoueurId, Carte[]>> = {}): Coup => {
  const pioche: Carte[] = [];
  for (let tour = 0; tour < 3; tour += 1) {
    for (const couleur of COULEURS) for (const valeur of [2, 3, 4, 5, 6] as const) pioche.push(c(couleur, valeur));
  }
  const main = (): Carte[] => [c('pique', 7), c('coeur', 8), c('carreau', 9), c('trefle', 10), c('pique', 'V')];
  return {
    numero: 3,
    donneurId: 'A',
    ordreJoueurs: [...ORDRE],
    joueursSurLeCote: [],
    phase: 'annonces',
    annonces: {},
    mains: Object.fromEntries(ORDRE.map((id) => [id, mains[id] ?? main()])),
    pioche,
    defausse: [],
    combinaisons: [],
    joueurActifId: 'B',
    numeroTour: 1,
    estFriche: false,
    recapitulatifs: Object.fromEntries(ORDRE.map((id) => [id, recap({ toursAvecPose: [] })])),
    gagnantId: null,
    aParler: 'B',
    enAttente: [],
    engageId: null,
  };
};

const dire = (coup: Coup, joueurId: JoueurId, annonce: 'friche' | 'je-joue'): Coup => {
  const { coup: apres, toutLeMondeAFriche } = annoncer(coup, joueurId, annonce);
  expect(toutLeMondeAFriche).toBe(false);
  return apres;
};

/** Le joueur actif pioche au talon et défausse sa première carte ordinaire. */
const piocherEtDefausser = (coup: Coup): Coup => {
  const joueur = coup.joueurActifId;
  const piochee = coup.pioche[0] as Carte;
  const aJeter = [...(coup.mains[joueur] ?? []), piochee].find((carte) => carte.type === 'normale') as Carte;
  const { coup: apres } = jouerTour(coup, joueur, { source: 'pioche', carteDefausseeId: aJeter.id });
  return apresTour(apres, joueur);
};

/** Où en est la table : qui doit parler, qui doit jouer, qui attend. */
const ouEnEst = (coup: Coup) => ({
  phase: coup.phase,
  parle: coup.phase === 'annonces' ? coup.aParler : null,
  joue: coup.phase === 'jeu' ? coup.joueurActifId : null,
  attente: coup.enAttente ?? [],
});

/** La même chose, avec l'engagé et la nature de l'interrogation. */
const ouEnEstAvecEngage = (coup: Coup) => ({
  ...ouEnEst(coup),
  engage: coup.engageId ?? null,
  interrogeEngage: engageInterroge(coup),
});

describe('friche / je joue, les deux exemples de la regle corrigee', () => {
  it('exemple 1 : B dit je joue et pioche directement ; C, D, A ne sont pas interroges ; au tour de B, il choisit', () => {
    // A distribue : B parle et joue le premier.
    let coup = dire(debut(), 'B', 'je-joue');
    expect(ouEnEstAvecEngage(coup)).toEqual({
      phase: 'jeu', parle: null, joue: 'B', attente: [], engage: 'B', interrogeEngage: false,
    });

    // Il pioche directement, sans être re-interrogé.
    coup = piocherEtDefausser(coup);
    // C, D, A jouent sans être interrogés.
    for (const joueur of ['C', 'D', 'A'] as JoueurId[]) {
      expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: joueur, attente: [] });
      expect(() => annoncer(coup, joueur, 'friche')).toThrow(/pas le moment d'annoncer/);
      coup = piocherEtDefausser(coup);
    }

    // Au tour de B, il peut fricher ou continuer.
    expect(ouEnEstAvecEngage(coup)).toEqual({
      phase: 'annonces', parle: 'B', joue: null, attente: [], engage: 'B', interrogeEngage: true,
    });
    expect(ouEnEst(dire(coup, 'B', 'je-joue'))).toEqual({ phase: 'jeu', parle: null, joue: 'B', attente: [] });
    expect(ouEnEstAvecEngage(dire(coup, 'B', 'friche'))).toEqual({
      phase: 'annonces', parle: 'C', joue: null, attente: ['B'], engage: null, interrogeEngage: false,
    });
  });

  it('exemple 2 : la parole rebondit d un engage a l autre, et seul l engage est interroge', () => {
    // B friche. C dit je joue. B joue forcé.
    let coup = dire(debut(), 'B', 'friche');
    coup = dire(coup, 'C', 'je-joue');
    expect(ouEnEstAvecEngage(coup)).toEqual({
      phase: 'jeu', parle: null, joue: 'B', attente: ['B'], engage: 'C', interrogeEngage: false,
    });
    coup = piocherEtDefausser(coup);

    // C est re-interrogé : il continue et joue.
    expect(ouEnEstAvecEngage(coup)).toEqual({
      phase: 'annonces', parle: 'C', joue: null, attente: [], engage: 'C', interrogeEngage: true,
    });
    coup = dire(coup, 'C', 'je-joue');
    coup = piocherEtDefausser(coup);

    // D joue, A joue, B joue : aucun des trois n'est interrogé.
    for (const joueur of ['D', 'A', 'B'] as JoueurId[]) {
      expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: joueur, attente: [] });
      coup = piocherEtDefausser(coup);
    }

    // Au tour de C, il friche.
    expect(ouEnEstAvecEngage(coup)).toEqual({
      phase: 'annonces', parle: 'C', joue: null, attente: [], engage: 'C', interrogeEngage: true,
    });
    coup = dire(coup, 'C', 'friche');
    // D est interrogé : friche. A est interrogé : je joue.
    expect(ouEnEstAvecEngage(coup)).toEqual({
      phase: 'annonces', parle: 'D', joue: null, attente: ['C'], engage: null, interrogeEngage: false,
    });
    coup = dire(coup, 'D', 'friche');
    expect(ouEnEst(coup)).toEqual({ phase: 'annonces', parle: 'A', joue: null, attente: ['C', 'D'] });
    coup = dire(coup, 'A', 'je-joue');

    // C joue forcé, D joue forcé.
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'C', attente: ['C', 'D'] });
    coup = piocherEtDefausser(coup);
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'D', attente: ['D'] });
    coup = piocherEtDefausser(coup);

    // A est re-interrogé : il continue et joue.
    expect(ouEnEstAvecEngage(coup)).toEqual({
      phase: 'annonces', parle: 'A', joue: null, attente: [], engage: 'A', interrogeEngage: true,
    });
    coup = dire(coup, 'A', 'je-joue');
    coup = piocherEtDefausser(coup);

    // B, C, D jouent sans être interrogés.
    for (const joueur of ['B', 'C', 'D'] as JoueurId[]) {
      expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: joueur, attente: [] });
      coup = piocherEtDefausser(coup);
    }

    // Et au tour de A, il peut de nouveau fricher.
    expect(ouEnEstAvecEngage(coup)).toEqual({
      phase: 'annonces', parle: 'A', joue: null, attente: [], engage: 'A', interrogeEngage: true,
    });
    expect(ouEnEstAvecEngage(dire(coup, 'A', 'friche'))).toEqual({
      phase: 'annonces', parle: 'B', joue: null, attente: ['A'], engage: null, interrogeEngage: false,
    });
  });
});

describe('friche / je joue, les trois exemples donnes mot pour mot', () => {
  it('exemple 1 : B friche, C friche, D joue ; B pioche et defausse, C pareil ; D peut continuer ou refricher', () => {
    let coup = dire(debut(), 'B', 'friche');
    expect(ouEnEst(coup)).toEqual({ phase: 'annonces', parle: 'C', joue: null, attente: ['B'] });
    coup = dire(coup, 'C', 'friche');
    expect(ouEnEst(coup)).toEqual({ phase: 'annonces', parle: 'D', joue: null, attente: ['B', 'C'] });
    // Personne ne parle hors de son tour.
    expect(() => annoncer(coup, 'A', 'je-joue')).toThrow(/pas a A de parler/);

    coup = dire(coup, 'D', 'je-joue');
    // B est le premier à piocher, quoi qu'il ait annoncé.
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'B', attente: ['B', 'C'] });
    coup = piocherEtDefausser(coup);
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'C', attente: ['C'] });
    coup = piocherEtDefausser(coup);
    expect(coup.defausse).toHaveLength(2);

    // À ce moment-là, D décide de nouveau.
    expect(ouEnEst(coup)).toEqual({ phase: 'annonces', parle: 'D', joue: null, attente: [] });
    expect(ouEnEst(dire(coup, 'D', 'je-joue'))).toEqual({ phase: 'jeu', parle: null, joue: 'D', attente: [] });
    expect(ouEnEst(dire(coup, 'D', 'friche'))).toEqual({ phase: 'annonces', parle: 'A', joue: null, attente: ['D'] });
  });

  it('exemple 2 : B friche, C dit je joue ; B pioche et defausse ; C peut redire friche', () => {
    let coup = dire(debut(), 'B', 'friche');
    coup = dire(coup, 'C', 'je-joue');
    // C'est au joueur sur lequel on s'était arrêté de jouer : B.
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'B', attente: ['B'] });
    coup = piocherEtDefausser(coup);
    expect(ouEnEst(coup)).toEqual({ phase: 'annonces', parle: 'C', joue: null, attente: [] });
    coup = dire(coup, 'C', 'friche');
    expect(ouEnEst(coup)).toEqual({ phase: 'annonces', parle: 'D', joue: null, attente: ['C'] });
  });

  it('exemple 3 : rebonds multiples dans un meme coup', () => {
    // La suite de l'exemple 1 : B et C ont joué, D a la parole.
    let coup = dire(debut(), 'B', 'friche');
    coup = dire(coup, 'C', 'friche');
    coup = dire(coup, 'D', 'je-joue');
    coup = piocherEtDefausser(piocherEtDefausser(coup));
    expect(ouEnEst(coup)).toEqual({ phase: 'annonces', parle: 'D', joue: null, attente: [] });

    // D friche, A friche, B dit je joue.
    coup = dire(coup, 'D', 'friche');
    coup = dire(coup, 'A', 'friche');
    coup = dire(coup, 'B', 'je-joue');
    // C'est à D de piocher : il avait dit friche avant de piocher.
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'D', attente: ['D', 'A'] });
    coup = piocherEtDefausser(coup);
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'A', attente: ['A'] });
    coup = piocherEtDefausser(coup);

    // B, là, peut refricher ; C friche ; D dit je joue.
    expect(ouEnEst(coup)).toEqual({ phase: 'annonces', parle: 'B', joue: null, attente: [] });
    coup = dire(coup, 'B', 'friche');
    coup = dire(coup, 'C', 'friche');
    coup = dire(coup, 'D', 'je-joue');
    // B doit piocher : il avait dit friche avant de piocher.
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'B', attente: ['B', 'C'] });
    coup = piocherEtDefausser(coup);
    coup = piocherEtDefausser(coup);
    expect(ouEnEst(coup)).toEqual({ phase: 'annonces', parle: 'D', joue: null, attente: [] });
    expect(coup.defausse).toHaveLength(6);
  });
});

describe('friche / je joue, les regles confirmees', () => {
  it('tous frichent d affilee, meme en cours de coup : le coup est a redistribuer', () => {
    let coup = dire(debut(), 'B', 'friche');
    coup = dire(coup, 'C', 'je-joue');
    coup = piocherEtDefausser(coup);
    coup = dire(coup, 'C', 'friche');
    coup = dire(coup, 'D', 'friche');
    coup = dire(coup, 'A', 'friche');
    expect(annoncer(coup, 'B', 'friche').toutLeMondeAFriche).toBe(true);
  });

  it('un tour joue depuis la file est un tour ordinaire : B y pose, et la friche se ferme pour tous', () => {
    const quinte = [c('coeur', 10), c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];
    const aJeter = c('pique', 2);
    let coup = dire(debut({ B: [...quinte, aJeter] }), 'B', 'friche');
    coup = dire(coup, 'C', 'friche');
    coup = dire(coup, 'D', 'je-joue');

    const { coup: apresPose } = jouerTour(coup, 'B', {
      source: 'pioche',
      poses: [tierce('coeur', quinte)],
      carteDefausseeId: aJeter.id,
    });
    coup = apresTour(apresPose, 'B');
    // C, qui attendait, joue son tour sans rien annoncer ; puis D aussi.
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'C', attente: [] });
    coup = piocherEtDefausser(coup);
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'D', attente: [] });
    coup = piocherEtDefausser(coup);
    expect(ouEnEst(coup)).toEqual({ phase: 'jeu', parle: null, joue: 'A', attente: [] });
  });

  it('chocolat : le dernier « je joue » avant la premiere pose, pas le premier', () => {
    const suite = [c('coeur', 10), c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];
    const aJeter = c('pique', 2);
    let coup = dire(debut({ C: [...suite, aJeter] }), 'B', 'friche');
    coup = dire(coup, 'C', 'je-joue');
    coup = piocherEtDefausser(coup);
    coup = dire(coup, 'C', 'friche');
    coup = dire(coup, 'D', 'je-joue');
    expect(coup.engageId).toBe('D');

    // C, dans la file, pose au tour qu'il doit jouer : la friche est close.
    const { coup: apresPose } = jouerTour(coup, 'C', {
      source: 'pioche',
      poses: [tierce('coeur', suite)],
      carteDefausseeId: aJeter.id,
    });
    const fini = { ...apresTour(apresPose, 'C'), phase: 'termine' as const, gagnantId: 'C' as JoueurId };
    fini.mains = { ...fini.mains, C: [] };
    // D a dit le dernier « je joue » avant la pose, sans jamais poser.
    expect(calculerScoreCoup(fini, 'C', 'simple', false).chocolatId).toBe('D');
  });
});

describe('le panier : la parole ne fait qu un tour, jamais de refriche', () => {
  const debutPanier = (mains: Partial<Record<JoueurId, Carte[]>> = {}): Coup => {
    const pioche: Carte[] = [];
    for (const couleur of COULEURS) for (const valeur of [2, 3, 4, 5, 6] as const) pioche.push(c(couleur, valeur));
    const main = (): Carte[] => [c('pique', 7), c('coeur', 8), c('carreau', 9), c('trefle', 10), c('pique', 'V')];
    return {
      variante: 'panier',
      numero: 1,
      donneurId: 'A',
      ordreJoueurs: ['A', 'B'],
      joueursSurLeCote: [],
      phase: 'annonces',
      annonces: {},
      mains: { A: mains.A ?? main(), B: mains.B ?? main() },
      pioche,
      defausse: [],
      combinaisons: [],
      joueurActifId: 'B',
      numeroTour: 1,
      estFriche: false,
      recapitulatifs: { A: recap({ toursAvecPose: [] }), B: recap({ toursAvecPose: [] }) },
      gagnantId: null,
      aParler: 'B',
      enAttente: [],
      engageId: null,
    };
  };
  const piocherEtDefausser = (coup: Coup): Coup => {
    const joueur = coup.joueurActifId;
    const piochee = coup.pioche[0] as Carte;
    const aJeter = [...(coup.mains[joueur] ?? []), piochee].find((carte) => carte.type === 'normale') as Carte;
    const { coup: apres } = jouerTour(coup, joueur, { source: 'pioche', carteDefausseeId: aJeter.id });
    return apresTour(apres, joueur);
  };

  it('B dit je joue : il joue directement, puis A joue a son tour sans jamais etre re-interroge', () => {
    let coup = dire(debutPanier(), 'B', 'je-joue');
    expect(coup).toMatchObject({ phase: 'jeu', joueurActifId: 'B', aParler: null });

    coup = piocherEtDefausser(coup);
    // A joue son tour sans annonce ; A ne redevient jamais l engage a interroger.
    expect(coup).toMatchObject({ phase: 'jeu', joueurActifId: 'A', aParler: null });
    expect(() => annoncer(coup, 'A', 'friche')).toThrow(/pas le moment d'annoncer/);

    coup = piocherEtDefausser(coup);
    // Le tour de B revient : au panier, il ne reparle jamais, il joue.
    expect(coup).toMatchObject({ phase: 'jeu', joueurActifId: 'B', aParler: null });
  });

  it('B friche, A dit je joue : B rattrape son tour force puis on joue sans plus jamais annoncer', () => {
    let coup = dire(debutPanier(), 'B', 'friche');
    coup = dire(coup, 'A', 'je-joue');
    expect(coup).toMatchObject({ phase: 'jeu', joueurActifId: 'B', engageId: 'A' });

    coup = piocherEtDefausser(coup);
    // B a rattrape son tour : au panier, on ne lui redemande jamais rien.
    expect(coup).toMatchObject({ phase: 'jeu', joueurActifId: 'A', aParler: null });
    coup = piocherEtDefausser(coup);
    expect(coup).toMatchObject({ phase: 'jeu', joueurActifId: 'B', aParler: null });
  });

  it('les deux frichent : le coup est a redistribuer', () => {
    let coup = dire(debutPanier(), 'B', 'friche');
    coup = { ...coup };
    const { toutLeMondeAFriche } = annoncer(coup, 'A', 'friche');
    expect(toutLeMondeAFriche).toBe(true);
  });
});
