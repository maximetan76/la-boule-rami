/**
 * Constitution du paquet, mélange et distribution.
 *
 * Réf. `docs/REGLES.md` § « Joueurs et matériel » : 2 jeux de 52 cartes,
 * 4 jokers normaux et le coucou ; les cartes sont distribuées 2 par 2 jusqu'à
 * 14 par joueur.
 *
 * Réf. § « Phase Friche / Je joue en début de coup » pour la redistribution
 * qui suit une friche généralisée.
 */
import type { Carte, Joueur, JoueurId } from '../models/index.js';
import { CARTES_PAR_JOUEUR, COULEURS, VALEURS } from '../models/index.js';
import { estJoker } from './cartes.js';

/** Cartes distribuées d'un coup au même joueur (§ « distribuées 2 par 2 »). */
export const CARTES_PAR_PAQUET = 2;

export const NOMBRE_JOKERS = 4;

/**
 * Taille du paquet, déduite de la composition énumérée par les règles :
 * 2 x 52 cartes + 4 jokers + 1 coucou = 109.
 *
 * ATTENTION : le § « Joueurs et matériel » annonce « 113 cartes au total »,
 * ce qui contredit sa propre énumération — 113 supposerait 8 jokers, ou des
 * jeux de 54 cartes. La composition détaillée fait foi ici, faute de pouvoir
 * trancher ; corriger `NOMBRE_JOKERS` si le total de 113 est le bon.
 */
export const TAILLE_PAQUET = 2 * 52 + NOMBRE_JOKERS + 1;

export interface DistributionResultat {
  /** Main de chaque joueur, dans l'ordre où les cartes ont été reçues. */
  readonly mains: Record<JoueurId, Carte[]>;
  /** Reste du paquet, qui devient le talon. */
  readonly pioche: Carte[];
}

/** Les 113 cartes du jeu, non mélangées. */
export const construirePaquet = (): Carte[] => {
  const paquet: Carte[] = [];

  for (const jeu of [1, 2]) {
    for (const couleur of COULEURS) {
      for (const valeur of VALEURS) {
        paquet.push({ type: 'normale', id: `${couleur}-${String(valeur)}-${jeu}`, couleur, valeur });
      }
    }
  }
  for (let i = 1; i <= NOMBRE_JOKERS; i += 1) {
    paquet.push({ type: 'joker', id: `joker-${i}` });
  }
  paquet.push({ type: 'coucou', id: 'coucou' });

  return paquet;
};

/**
 * Mélange de Fisher-Yates. Le paquet reçu n'est pas modifié.
 *
 * @param alea source d'aléa, injectable pour rendre le mélange reproductible.
 */
export const melangerPaquet = (
  paquet: readonly Carte[],
  alea: () => number = Math.random,
): Carte[] => {
  const melange = [...paquet];
  for (let i = melange.length - 1; i > 0; i -= 1) {
    const j = Math.floor(alea() * (i + 1));
    const carteI = melange[i] as Carte;
    melange[i] = melange[j] as Carte;
    melange[j] = carteI;
  }
  return melange;
};

/**
 * Sert les joueurs par paquets de 2 en faisant le tour de la table, jusqu'à ce
 * que chacun ait atteint son objectif de cartes.
 */
const servir = (
  objectifs: readonly { readonly id: JoueurId; readonly aServir: number }[],
  paquet: readonly Carte[],
): DistributionResultat => {
  const total = objectifs.reduce((somme, o) => somme + o.aServir, 0);
  if (paquet.length < total) {
    throw new Error(
      `Paquet trop court : ${String(paquet.length)} cartes pour ${String(total)} a distribuer`,
    );
  }

  const mains: Record<JoueurId, Carte[]> = {};
  for (const { id } of objectifs) mains[id] = [];

  let curseur = 0;
  let servisCeTour = true;
  while (servisCeTour) {
    servisCeTour = false;
    for (const { id, aServir } of objectifs) {
      const main = mains[id] as Carte[];
      const manquantes = aServir - main.length;
      if (manquantes <= 0) continue;

      const lot = Math.min(CARTES_PAR_PAQUET, manquantes);
      main.push(...paquet.slice(curseur, curseur + lot));
      curseur += lot;
      servisCeTour = true;
    }
  }

  return { mains, pioche: paquet.slice(curseur) };
};

/** Distribue 14 cartes à chaque joueur, 2 par 2. */
export const distribuerCartes = (
  joueurs: readonly Joueur[],
  paquet: readonly Carte[],
): DistributionResultat => {
  if (joueurs.length === 0) {
    throw new Error('Impossible de distribuer sans joueur');
  }
  return servir(
    joueurs.map((joueur) => ({ id: joueur.id, aServir: CARTES_PAR_JOUEUR })),
    paquet,
  );
};

/**
 * Redistribution après une friche généralisée.
 *
 * § « Les joueurs qui avaient déjà des jokers en main les conservent, et
 * reçoivent une distribution ajustée pour revenir à 14 cartes en tenant compte
 * des jokers déjà en main. »
 *
 * @param joueursAvecJokers jokers (et coucou) conservés par chaque joueur.
 */
export const redistribuerApresFricheGeneralisee = (
  joueursAvecJokers: Readonly<Record<JoueurId, readonly Carte[]>>,
  paquetRestant: readonly Carte[],
): DistributionResultat => {
  const entrees = Object.entries(joueursAvecJokers);
  if (entrees.length === 0) {
    throw new Error('Impossible de redistribuer sans joueur');
  }

  for (const [id, conservees] of entrees) {
    if (!conservees.every(estJoker)) {
      throw new Error(`Seuls les jokers et le coucou se conservent : main de ${id} invalide`);
    }
    if (conservees.length > CARTES_PAR_JOUEUR) {
      throw new Error(`${id} conserve plus de ${String(CARTES_PAR_JOUEUR)} cartes`);
    }
  }

  const { mains, pioche } = servir(
    entrees.map(([id, conservees]) => ({
      id,
      aServir: CARTES_PAR_JOUEUR - conservees.length,
    })),
    paquetRestant,
  );

  // Les jokers conservés restent en tête de main.
  const completees: Record<JoueurId, Carte[]> = {};
  for (const [id, conservees] of entrees) {
    completees[id] = [...conservees, ...(mains[id] ?? [])];
  }

  return { mains: completees, pioche };
};
