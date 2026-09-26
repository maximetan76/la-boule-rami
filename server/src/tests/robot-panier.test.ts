import { describe, expect, it } from 'vitest';
import {
  creerStrategiePanier,
  nourrirait,
  retenirCeQueLaDefausseApprend,
  strategiePanier,
} from '../bots/panier.js';
import { memoireVierge } from '../bots/strategie.js';
import { strategieElementaire } from '../bots/elementaire.js';
import { initialiserMatchPanier } from '../game-engine/panier.js';
import { jouerTour } from '../game-engine/tour.js';
import { filtrerEtatPourJoueur } from '../server/etat-filtre.js';
import { c, coup, joker } from './fixtures.js';
import type { Annonce, Carte, Coup } from '../models/index.js';

/**
 * Réf. docs/REGLES.md § « Le panier ». La stratégie du robot, sur de vrais
 * états filtrés : elle ne voit que ce qu'un joueur verrait à sa place.
 */

const MATCH = initialiserMatchPanier(
  [
    { id: 'robot', nom: 'Robot', croix: 0 },
    { id: 'ana', nom: 'Ana', croix: 0 },
  ],
  3,
  10,
);

const panier = (partiel: Partial<Coup>): Coup =>
  coup({
    variante: 'panier',
    ordreJoueurs: ['robot', 'ana'],
    donneurId: 'ana',
    joueurActifId: 'robot',
    recapitulatifs: {
      robot: { toursAvecPose: [], aAjouteSurCombinaisonAutrui: false },
      ana: { toursAvecPose: [], aAjouteSurCombinaisonAutrui: false },
    },
    ...partiel,
  });

const vue = (etat: Coup) => filtrerEtatPourJoueur(etat, { panier: MATCH }, 'robot');

/** Quatorze cartes : trois brelans et une suite de quatre, plus une carte seule. */
const presqueFinie = () => {
  const jk = joker();
  const cartes = {
    deux: [c('pique', 2), c('coeur', 2), c('trefle', 2)],
    trois: [c('pique', 3), c('coeur', 3), c('trefle', 3)],
    sept: [c('pique', 7), c('coeur', 7), jk],
    suite: [c('carreau', 5), c('carreau', 6), c('carreau', 7), c('carreau', 8)],
    seule: c('trefle', 'R'),
  };
  const main = [...cartes.deux, ...cartes.trois, ...cartes.sept, ...cartes.suite, cartes.seule];
  return { main, cartes };
};

describe('le robot du panier', () => {
  it('finit dès que sa main le permet, et le moteur accepte sa pose', () => {
    const { main, cartes } = presqueFinie();
    const neufCarreau = c('carreau', 9);
    const etat = panier({ mains: { robot: main, ana: [] }, pioche: [neufCarreau] });

    const decision = strategiePanier.finirTour(vue(etat), neufCarreau, 'pioche', memoireVierge());
    expect(decision.carteDefausseeId).toBe(cartes.seule.id);
    expect(decision.poses.flatMap((pose) => pose.cartes)).toHaveLength(14);

    const { coup: apres, coupTermine } = jouerTour(etat, 'robot', {
      source: 'pioche',
      poses: [...decision.poses],
      carteDefausseeId: decision.carteDefausseeId,
    });
    expect(coupTermine).toBe(true);
    expect(apres.gagnantId).toBe('robot');
  });

  it("prend la défausse quand elle rapproche sa main du but, le talon sinon", () => {
    const { main } = presqueFinie();
    const utile = c('carreau', 9);
    const inutile = c('pique', 'V');
    const prenable = panier({ mains: { robot: main, ana: [] }, defausse: [utile] });
    const sansInteret = panier({ mains: { robot: main, ana: [] }, defausse: [inutile] });

    expect(strategiePanier.choisirSource(vue(prenable), memoireVierge())).toBe('defausse');
    expect(strategiePanier.choisirSource(vue(sansInteret), memoireVierge())).toBe('pioche');
  });

  it('prise dans la défausse, la carte sert : il ne la rejette pas', () => {
    const { main } = presqueFinie();
    const utile = c('carreau', 9);
    const etat = panier({ mains: { robot: main, ana: [] }, defausse: [utile] });
    const decision = strategiePanier.finirTour(vue(etat), utile, 'defausse', memoireVierge());
    expect(decision.carteDefausseeId).not.toBe(utile.id);
  });

  it("jette la carte la moins utile : jamais un joker, jamais une carte d'une combinaison", () => {
    const { main, cartes } = presqueFinie();
    const piochee = c('coeur', 'D');
    const etat = panier({ mains: { robot: main, ana: [] }, pioche: [piochee] });
    const decision = strategiePanier.finirTour(vue(etat), piochee, 'pioche', memoireVierge());
    expect(decision.poses).toEqual([]);
    expect([cartes.seule.id, piochee.id]).toContain(decision.carteDefausseeId);
  });

  it("à distance égale, ne jette pas la carte que l'adversaire attend", () => {
    const { main, cartes } = presqueFinie();
    // Deux cartes aussi inutiles l'une que l'autre au robot : le R♣ et la D♥.
    const piochee = c('coeur', 'D');
    const etat = panier({ mains: { robot: main, ana: [] }, pioche: [piochee] });
    const memoire = memoireVierge();
    // Ana a ramassé la D♠ : la D♥ lui ferait une ébauche de brelan.
    memoire.prisesDeLAdversaire.push(c('pique', 'D'));
    const decision = strategiePanier.finirTour(vue(etat), piochee, 'pioche', memoire);
    expect(decision.carteDefausseeId).toBe(cartes.seule.id);

    // Même main, rien de connu d'Ana : le choix peut se porter sur l'une ou l'autre.
    const sansSavoir = creerStrategiePanier({ distanceDeFriche: 12, eviterDeNourrir: false });
    const indifferent = sansSavoir.finirTour(vue(etat), piochee, 'pioche', memoire).carteDefausseeId;
    expect([cartes.seule.id, piochee.id]).toContain(indifferent);
  });

  it("nourrir l'adversaire : même valeur, ou même couleur à deux rangs au plus", () => {
    const prises = [c('pique', 'D'), c('coeur', 5)];
    expect(nourrirait(c('carreau', 'D'), prises)).toBe(true);
    expect(nourrirait(c('coeur', 7), prises)).toBe(true);
    expect(nourrirait(c('coeur', 8), prises)).toBe(false);
    expect(nourrirait(c('pique', 'D'), prises)).toBe(false);
    expect(nourrirait(joker(), prises)).toBe(false);
    // L'as a deux rangs : il touche le roi comme le deux.
    expect(nourrirait(c('trefle', 'A'), [c('trefle', 'R')])).toBe(true);
    expect(nourrirait(c('trefle', 'A'), [c('trefle', 2)])).toBe(true);
  });

  it("la défausse apprend ce que l'adversaire ramasse, et oublie tout quand la pile se vide", () => {
    const jetee = c('coeur', 'D');
    const autre = c('pique', 4);
    const memoire = memoireVierge();

    // Il a jeté la D♥, la pile comptait 3 cartes ; au tour suivant, elle en
    // compte toujours 3 et la D♥ n'y est plus : Ana l'a prise.
    memoire.derniereDefausse = { carte: jetee, hauteurDeLaPile: 3 };
    retenirCeQueLaDefausseApprend(
      vue(panier({ mains: { robot: [], ana: [] }, defausse: [c('trefle', 2), c('trefle', 3), autre] })),
      memoire,
    );
    expect(memoire.prisesDeLAdversaire.map((carte) => carte.id)).toEqual([jetee.id]);

    // La carte est restée, et une de plus est venue : rien de pris.
    memoire.derniereDefausse = { carte: autre, hauteurDeLaPile: 3 };
    retenirCeQueLaDefausseApprend(
      vue(panier({ mains: { robot: [], ana: [] }, defausse: [c('trefle', 2), c('trefle', 3), autre, c('pique', 9)] })),
      memoire,
    );
    expect(memoire.prisesDeLAdversaire).toHaveLength(1);

    // Pile vide : nouvelle donne. Plus rien ne vaut.
    retenirCeQueLaDefausseApprend(vue(panier({ mains: { robot: [], ana: [] }, defausse: [] })), memoire);
    expect(memoire.prisesDeLAdversaire).toEqual([]);
  });

  describe('la parole', () => {
    const annonce = (main: Carte[], annonces: Record<string, Annonce> = {}) =>
      strategiePanier.annoncer(
        vue(panier({ phase: 'annonces', mains: { robot: main, ana: [] }, annonces, aParler: 'robot' })),
        memoireVierge(),
      );

    it('une main proche du but : je joue', () => {
      expect(annonce(presqueFinie().main)).toBe('je-joue');
    });

    it('une main trop loin du but : friche, pour tenter une nouvelle donne', () => {
      // Quatorze cartes sans rien qui se tienne.
      const eparse = [
        c('pique', 2), c('coeur', 5), c('trefle', 8), c('carreau', 'V'),
        c('pique', 'A'), c('coeur', 9), c('trefle', 'D'), c('carreau', 3),
        c('pique', 6), c('coeur', 'R'), c('trefle', 4), c('carreau', 7),
        c('pique', 10), c('coeur', 2),
      ];
      expect(annonce(eparse)).toBe('friche');
      // Si Ana a déjà dit « je joue », fricher ne fait rien redonner.
      expect(annonce(eparse, { ana: 'je-joue' })).toBe('je-joue');
    });
  });

  it('la stratégie élémentaire reste celle de La Boule : je joue, talon, la première carte non joker', () => {
    const jk = joker();
    const premiere = c('pique', 4);
    const etat = panier({ mains: { robot: [jk, premiere, c('coeur', 6)], ana: [] } });
    expect(strategieElementaire.annoncer(vue(etat), memoireVierge())).toBe('je-joue');
    expect(strategieElementaire.choisirSource(vue(etat), memoireVierge())).toBe('pioche');
    const piochee = joker();
    expect(strategieElementaire.finirTour(vue(etat), piochee, 'pioche', memoireVierge()).carteDefausseeId).toBe(
      premiere.id,
    );
  });
});
