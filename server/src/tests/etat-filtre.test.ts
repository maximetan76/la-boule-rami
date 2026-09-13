import { describe, expect, it } from 'vitest';
import { filtrerEtatPourJoueur } from '../server/etat-filtre.js';
import { boule, c, coucou, coup, joker, tierce } from './fixtures.js';
import type { Carte } from '../models/index.js';

/**
 * Fonction la plus critique du projet côté anti-triche : rien de ce qui est
 * caché ne doit franchir cette frontière.
 */

const mainDeJ1 = (): Carte[] => [c('coeur', 7), c('coeur', 8), c('coeur', 9)];
const mainDeJ2 = (): Carte[] => [c('pique', 'R'), c('pique', 'D'), joker()];
const mainDeJ3 = (): Carte[] => [c('trefle', 2), coucou()];
const talon = (): Carte[] => [c('carreau', 4), c('carreau', 5), c('carreau', 6)];

const etatComplet = (partiel: Parameters<typeof coup>[0] = {}) =>
  coup({
    mains: { j1: mainDeJ1(), j2: mainDeJ2(), j3: mainDeJ3() },
    pioche: talon(),
    defausse: [c('pique', 3), c('coeur', 4), c('trefle', 5)],
    combinaisons: [tierce('carreau', [c('carreau', 8), c('carreau', 9), c('carreau', 10)], 'j2')],
    ...partiel,
  });

/** Tous les identifiants de cartes présents, à n'importe quelle profondeur. */
const identifiantsPresents = (valeur: unknown): string[] =>
  JSON.stringify(valeur).match(/"id":"([^"]+)"/g) ?? [];

describe('filtrerEtatPourJoueur — sa propre main', () => {
  it('rend la main du joueur en clair et en entier', () => {
    const etat = etatComplet();
    const filtre = filtrerEtatPourJoueur(etat, boule(), 'j1');

    expect(filtre.moi.joueurId).toBe('j1');
    expect(filtre.moi.main.map((carte) => carte.id)).toEqual(
      (etat.mains['j1'] ?? []).map((carte) => carte.id),
    );
  });
});

describe('filtrerEtatPourJoueur — mains des autres', () => {
  it('ne donne que le nombre de cartes des adversaires', () => {
    const filtre = filtrerEtatPourJoueur(etatComplet(), boule(), 'j1');

    expect(filtre.adversaires).toEqual([
      { joueurId: 'j2', nombreCartes: 3, aPose: false, connecte: false },
      { joueurId: 'j3', nombreCartes: 2, aPose: false, connecte: false },
    ]);
  });

  it('ne laisse fuir aucune carte de la main d un autre joueur, meme en profondeur', () => {
    const etat = etatComplet();
    const filtre = filtrerEtatPourJoueur(etat, boule(), 'j1');
    const rendu = identifiantsPresents(filtre);

    for (const carte of [...(etat.mains['j2'] ?? []), ...(etat.mains['j3'] ?? [])]) {
      expect(rendu).not.toContain(`"id":"${carte.id}"`);
    }
  });

  it('n oublie pas les joueurs sur le cote dans le decompte', () => {
    const etat = etatComplet({ ordreJoueurs: ['j1', 'j2'], joueursSurLeCote: ['j3'] });
    const filtre = filtrerEtatPourJoueur(etat, boule(), 'j1');

    expect(filtre.adversaires.map((a) => a.joueurId)).toEqual(['j2', 'j3']);
  });
});

describe('filtrerEtatPourJoueur — talon de pioche', () => {
  it('ne laisse fuir aucune carte du talon', () => {
    const etat = etatComplet();
    const filtre = filtrerEtatPourJoueur(etat, boule(), 'j1');
    const rendu = identifiantsPresents(filtre);

    for (const carte of etat.pioche) {
      expect(rendu).not.toContain(`"id":"${carte.id}"`);
    }
  });

  it('ne revele pas non plus le nombre de cartes restantes au talon', () => {
    const etat = etatComplet();
    const serialise = JSON.stringify(filtrerEtatPourJoueur(etat, boule(), 'j1'));

    expect(serialise).not.toContain('pioche');
    expect(serialise).not.toContain('talon');
    // Le nombre 3 apparait legitimement ailleurs : on verifie qu aucune cle ne
    // porte la taille du talon.
    const filtre = filtrerEtatPourJoueur(etat, boule(), 'j1') as unknown as Record<string, unknown>;
    expect(Object.keys(filtre)).not.toContain('pioche');
    expect(Object.keys(filtre)).not.toContain('nombreCartesPioche');
  });
});

describe('filtrerEtatPourJoueur — défausse', () => {
  it('identifie clairement la derniere carte defaussee, la seule piochable', () => {
    const etat = etatComplet();
    const filtre = filtrerEtatPourJoueur(etat, boule(), 'j1');

    expect(filtre.defausse.derniereCarte?.id).toBe(etat.defausse.at(-1)?.id);
  });

  it('donne une defausse vide quand rien n a encore ete jete', () => {
    const filtre = filtrerEtatPourJoueur(etatComplet({ defausse: [] }), boule(), 'j1');

    expect(filtre.defausse.derniereCarte).toBeNull();
    expect(filtre.defausse.cartesSorties).toEqual([]);
  });

  it('liste toutes les cartes sorties depuis le debut du coup', () => {
    const etat = etatComplet();
    const filtre = filtrerEtatPourJoueur(etat, boule(), 'j1');

    expect(filtre.defausse.cartesSorties).toHaveLength(etat.defausse.length);
    expect(new Set(filtre.defausse.cartesSorties.map((carte) => carte.id))).toEqual(
      new Set(etat.defausse.map((carte) => carte.id)),
    );
  });

  it('ne permet pas de reconstituer l ordre des defausses', () => {
    // Deux coups identiques a l ordre de defausse pres donnent la meme liste.
    const cartes = [c('pique', 3), c('coeur', 4), c('trefle', 5)];
    const ordreA = filtrerEtatPourJoueur(etatComplet({ defausse: [...cartes] }), boule(), 'j1');
    const ordreB = filtrerEtatPourJoueur(
      etatComplet({ defausse: [cartes[2]!, cartes[0]!, cartes[1]!] }),
      boule(),
      'j1',
    );

    expect(ordreA.defausse.cartesSorties.map((carte) => carte.id)).toEqual(
      ordreB.defausse.cartesSorties.map((carte) => carte.id),
    );
  });

  it('n attache ni joueur, ni tour, ni horodatage aux cartes sorties', () => {
    const filtre = filtrerEtatPourJoueur(etatComplet(), boule(), 'j1');

    for (const carte of filtre.defausse.cartesSorties) {
      const cles = Object.keys(carte).sort();
      // Une carte ordinaire ne porte que ces quatre champs, et rien d autre.
      expect(cles.every((cle) => ['type', 'id', 'couleur', 'valeur'].includes(cle))).toBe(true);
      expect(cles).not.toContain('joueurId');
      expect(cles).not.toContain('tour');
      expect(cles).not.toContain('horodatage');
    }
  });
});

describe('filtrerEtatPourJoueur — table et Boule', () => {
  it('montre integralement les combinaisons posees par tout le monde', () => {
    const etat = etatComplet();
    const filtre = filtrerEtatPourJoueur(etat, boule(), 'j1');

    expect(filtre.combinaisons).toHaveLength(1);
    expect(filtre.combinaisons[0]?.cartes).toHaveLength(3);
    expect(filtre.combinaisons[0]?.proprietaireId).toBe('j2');
  });

  it('reporte les scores cumules et les croix de la Boule', () => {
    const enCours = boule({ scoresCumules: { j1: 40, j2: -20 }, croix: { j1: 1 } });
    const filtre = filtrerEtatPourJoueur(etatComplet(), enCours, 'j1');

    expect(filtre.boule.scoresCumules).toEqual({ j1: 40, j2: -20 });
    expect(filtre.boule.croix).toEqual({ j1: 1 });
  });
});

describe('filtrerEtatPourJoueur — carte piochée en attente', () => {
  const enAttente = (joueurId: string, carte: Carte) => ({
    joueurId,
    source: 'pioche' as const,
    cartePiochee: carte,
    poses: [],
    ajouts: [],
  });

  it('montre au joueur actif la carte qu il vient de piocher', () => {
    const piochee = c('carreau', 4);
    const filtre = filtrerEtatPourJoueur(etatComplet(), boule(), 'j1', {
      tourEnAttente: enAttente('j1', piochee),
    });

    expect(filtre.moi.carteEnAttente?.id).toBe(piochee.id);
  });

  it('dit au joueur d ou vient sa carte en attente, et a personne d autre', () => {
    const prise = c('trefle', 9);
    const tour = { ...enAttente('j1', prise), source: 'defausse' as const };

    const vuParJ1 = filtrerEtatPourJoueur(etatComplet(), boule(), 'j1', { tourEnAttente: tour });
    // Sans cette information, une partie reprise en cours de tour perdrait de
    // vue qu'une carte prise en defausse peut etre rendue, et le tour
    // resterait bloque faute de pouvoir la servir.
    expect(vuParJ1.moi.sourceCarteEnAttente).toBe('defausse');

    const vuParJ2 = filtrerEtatPourJoueur(etatComplet(), boule(), 'j2', { tourEnAttente: tour });
    expect(vuParJ2.moi.sourceCarteEnAttente).toBeNull();
  });

  it('ne dit rien de la source quand aucun tour n est entame', () => {
    expect(filtrerEtatPourJoueur(etatComplet(), boule(), 'j1').moi.sourceCarteEnAttente).toBeNull();
  });

  it('ne montre a personne d autre la carte piochee par le joueur actif', () => {
    const piochee = c('carreau', 4);
    const filtre = filtrerEtatPourJoueur(etatComplet(), boule(), 'j2', {
      tourEnAttente: enAttente('j1', piochee),
    });

    expect(filtre.moi.carteEnAttente).toBeNull();
    expect(identifiantsPresents(filtre)).not.toContain(`"id":"${piochee.id}"`);
  });
});

describe('filtrerEtatPourJoueur — tirage d ouverture', () => {
  it('le montre a chacun tel quel : les cartes ont ete retournees devant tous', () => {
    const jokerTire = joker();
    const tirage = {
      ordreTable: ['j2', 'j1', 'j3'],
      donneurInitial: 'j2',
      cartesTirees: { j1: [c('pique', 5)], j2: [jokerTire], j3: [c('trefle', 'R')] },
      jokersConserves: { j1: [], j2: [jokerTire], j3: [] },
    };
    for (const joueurId of ['j1', 'j2', 'j3']) {
      const filtre = filtrerEtatPourJoueur(etatComplet(), boule(), joueurId, { tirageOuverture: tirage });
      expect(filtre.tirageOuverture).toEqual(tirage);
    }
  });

  it('vaut null quand aucun tirage n est fourni', () => {
    expect(filtrerEtatPourJoueur(etatComplet(), boule(), 'j1').tirageOuverture).toBeNull();
  });
});

describe('filtrerEtatPourJoueur — jokers gardes d une friche generalisee', () => {
  it('ne signale que les jokers encore dans la main du joueur', () => {
    const etat = etatComplet();
    const jokerDeJ2 = etat.mains['j2']![2]!;
    const vuParJ2 = filtrerEtatPourJoueur(etat, boule(), 'j2', { jokersGardes: [jokerDeJ2.id, 'joker-parti'] });
    expect(vuParJ2.moi.jokersGardes).toEqual([jokerDeJ2.id]);
  });

  it('vaut une liste vide par defaut', () => {
    expect(filtrerEtatPourJoueur(etatComplet(), boule(), 'j1').moi.jokersGardes).toEqual([]);
  });
});
