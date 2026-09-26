/**
 * La stratégie du panier.
 *
 * Réf. docs/REGLES.md § « Le panier ». On ne pose qu'une fois, pour finir : les
 * 14 cartes en combinaisons, la 15e jetée. Tout se juge donc à la « distance »
 * de la main — les cartes qu'il lui manque encore, calculées par le solveur —
 * et, à distance égale, à son potentiel : les cartes encore en jeu qui la
 * feraient avancer.
 *
 * - La parole : « friche » quand la main est trop loin du but, pour tenter une
 *   nouvelle donne ; « je joue » sinon.
 * - La pioche : la carte de la défausse seulement si elle rapproche la main du
 *   but ; le talon sinon.
 * - Finir dès que la main le permet.
 * - Jeter la carte la moins utile ; à distance égale, pas celle que
 *   l'adversaire attend, quand on le sait — une carte voisine de celles qu'on
 *   l'a vu ramasser dans la défausse.
 */
import { randomUUID } from 'node:crypto';
import { estJoker, rang } from '../game-engine/cartes.js';
import { AnalyseDeMain, type Repartition } from '../game-engine/solveur.js';
import type { Carte } from '../models/index.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';
import type { FinDeTour, MemoireDuRobot, Source, Strategie } from './strategie.js';

/**
 * À partir de cette distance, la main ne vaut pas qu'on la joue : friche.
 *
 * Mesuré au banc sur 1 500 donnes : la distance médiane d'une main de départ
 * est de 10, et 12 ou plus ne concerne qu'un quart des mains. Le robot ne
 * friche que celles-là — plus bas, il redonnait plus d'une fois par manche.
 */
export const DISTANCE_DE_FRICHE = 12;

export interface ReglagesPanier {
  readonly distanceDeFriche: number;
  /** Faux : toujours le talon. Pour mesurer ce que la prise en défausse apporte. */
  readonly prendreLaDefausse?: boolean;
  /** Faux : jette sans regarder ce que l'adversaire a ramassé. Même usage. */
  readonly eviterDeNourrir?: boolean;
}

/**
 * Ce que coûte au départage une carte qui nourrirait l'adversaire. Toujours
 * moins qu'une carte de distance : on ne s'éloigne jamais du but pour le gêner.
 */
const PENALITE_NOURRIR = 400;
const POIDS_DISTANCE = 10_000;

/** Les cartes qu'un joueur sait hors d'atteinte : la défausse, et la table. */
const cartesVues = (vue: EtatCoupFiltre, sauf: Carte | null = null): Carte[] =>
  [...vue.defausse.cartesSorties, ...vue.combinaisons.flatMap((combinaison) => combinaison.cartes.map((cp) => cp.carte))]
    .filter((carte) => carte.id !== sauf?.id);

const note = (repartition: Repartition): number => repartition.distance * POIDS_DISTANCE - repartition.potentiel;

/** Les rangs d'une carte dans une suite : l'as en a deux. */
const rangs = (carte: Carte): number[] =>
  estJoker(carte) ? [] : carte.valeur === 'A' ? [1, 14] : [rang(carte.valeur, true)];

/**
 * Cette carte ferait-elle l'affaire de l'adversaire ? Même valeur qu'une carte
 * qu'il a ramassée, ou même couleur à deux rangs au plus : de quoi compléter
 * un brelan ou une suite qu'il prépare.
 */
export const nourrirait = (carte: Carte, prises: readonly Carte[]): boolean => {
  if (estJoker(carte)) return false;
  return prises.some((prise) => {
    if (estJoker(prise)) return false;
    if (prise.valeur === carte.valeur) return prise.couleur !== carte.couleur;
    if (prise.couleur !== carte.couleur) return false;
    return rangs(prise).some((a) => rangs(carte).some((b) => Math.abs(a - b) <= 2));
  });
};

/**
 * Ce que la défausse a appris depuis le dernier tour du robot. Il a jeté une
 * carte, la pile avait une hauteur : si la carte n'y est plus et que la pile a
 * gardé la même hauteur, l'adversaire l'a prise et en a jeté une autre.
 */
export const retenirCeQueLaDefausseApprend = (vue: EtatCoupFiltre, memoire: MemoireDuRobot): void => {
  const pile = vue.defausse.cartesSorties;
  // Une pile vide : nouvelle donne, ou talon reformé. Plus rien ne vaut.
  if (pile.length === 0) {
    memoire.prisesDeLAdversaire = [];
    memoire.derniereDefausse = null;
    return;
  }
  const derniere = memoire.derniereDefausse;
  if (derniere === null) return;
  memoire.derniereDefausse = null;
  const encoreLa = pile.some((carte) => carte.id === derniere.carte.id);
  if (!encoreLa && pile.length === derniere.hauteurDeLaPile) memoire.prisesDeLAdversaire.push(derniere.carte);
};

export const creerStrategiePanier = ({
  distanceDeFriche,
  prendreLaDefausse = true,
  eviterDeNourrir = true,
}: ReglagesPanier): Strategie => ({
  annoncer(vue, memoire) {
    retenirCeQueLaDefausseApprend(vue, memoire);
    // L'adversaire a déjà dit « je joue » : fricher ne ferait rien redonner.
    const autres = Object.entries(vue.coup.annonces).filter(([id]) => id !== vue.moi.joueurId);
    if (autres.some(([, annonce]) => annonce === 'je-joue')) return 'je-joue';
    const analyse = new AnalyseDeMain(vue.moi.main, { cartesVues: cartesVues(vue) });
    return analyse.meilleure(null).distance >= distanceDeFriche ? 'friche' : 'je-joue';
  },

  choisirSource(vue, memoire): Source {
    retenirCeQueLaDefausseApprend(vue, memoire);
    const dessus = vue.defausse.derniereCarte;
    if (!prendreLaDefausse || dessus === null || estJoker(dessus)) return 'pioche';

    const main = vue.moi.main;
    const maintenant = new AnalyseDeMain(main, { cartesVues: cartesVues(vue) }).meilleure(null);
    const avecElle = new AnalyseDeMain([...main, dessus], { cartesVues: cartesVues(vue, dessus) }).meilleure('libre');
    // Prise pour être aussitôt rejetée, elle n'apporterait rien.
    if (avecElle.defausse?.id === dessus.id) return 'pioche';
    return avecElle.distance < maintenant.distance ? 'defausse' : 'pioche';
  },

  finirTour(vue, carte, source, memoire): FinDeTour {
    const main = [...vue.moi.main, carte];
    const analyse = new AnalyseDeMain(main, {
      cartesVues: cartesVues(vue, source === 'defausse' ? carte : null),
      proprietaireId: vue.moi.joueurId,
      nouvelId: randomUUID,
    });

    // Tout se pose : le coup est gagné.
    const finie = analyse.meilleure('libre');
    if (finie.distance === 0 && finie.defausse !== null) {
      return { poses: finie.combinaisons, carteDefausseeId: finie.defausse.id };
    }

    // Sinon, la carte dont l'absence coûte le moins ; à égalité de distance,
    // pas celle que l'adversaire attend.
    const candidates = main.filter(
      (candidate) => !estJoker(candidate) && !(source === 'defausse' && candidate.id === carte.id),
    );
    let meilleure: { carte: Carte; score: number } | null = null;
    for (const candidate of candidates) {
      const score =
        note(analyse.meilleure(candidate)) +
        (eviterDeNourrir && nourrirait(candidate, memoire.prisesDeLAdversaire) ? PENALITE_NOURRIR : 0);
      if (meilleure === null || score < meilleure.score) meilleure = { carte: candidate, score };
    }
    if (meilleure === null) throw new Error('Aucune carte a jeter : la main ne compte que des jokers');

    // Juste après avoir jeté, la pile compte une carte de plus qu'avant la prise.
    const hauteurAvant = vue.defausse.cartesSorties.length - (source === 'defausse' ? 1 : 0);
    memoire.derniereDefausse = { carte: meilleure.carte, hauteurDeLaPile: hauteurAvant + 1 };
    return { poses: [], carteDefausseeId: meilleure.carte.id };
  },
});

export const strategiePanier = creerStrategiePanier({ distanceDeFriche: DISTANCE_DE_FRICHE });
