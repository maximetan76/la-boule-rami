/**
 * Scoring d'un coup.
 *
 * Réf. `docs/REGLES.md` § « Fin d'un coup et scoring » :
 * - le gagnant marque -20 points, -40 en « double », -60 en « triple » ;
 * - chaque perdant marque la valeur de ses cartes en main, arrondie à la
 *   dizaine la plus proche, puis doublée ou triplée selon la victoire ;
 * - un joueur n'ayant posé aucune carte marque 100 points au lieu de la valeur
 *   de sa main ;
 * - un coup friché ajoute un facteur 2 qui se cumule (jusqu'à x6), appliqué à
 *   tous les montants du coup, gagnant compris.
 */
import type { Carte, Coup, JoueurId, ScoreCoup, TypeVictoire } from '../models/index.js';
import { pointsEnMain } from './cartes.js';
import { compterCroix } from './croix.js';

/** Points de base du gagnant, avant multiplicateurs. */
export const POINTS_GAGNANT = -20;

/**
 * Forfait d'un joueur n'ayant posé aucune carte du coup : 100 points, sans
 * calcul de la valeur de ses cartes ni arrondi. Les multiplicateurs du coup
 * s'y appliquent ensuite comme pour les autres perdants.
 */
export const FORFAIT_SANS_POSE = 100;

const FACTEUR_VICTOIRE: Readonly<Record<TypeVictoire, number>> = {
  simple: 1,
  double: 2,
  triple: 3,
};

/**
 * Arrondit à la dizaine la plus proche, 5 arrondissant au-dessus
 * (35 → 40, 34 → 30).
 */
export const arrondirALaDizaine = (points: number): number => Math.round(points / 10) * 10;

/** Valeur des cartes restées en main, arrondie (§ « Fin d'un coup et scoring »). */
export const scoreDeLaMain = (main: readonly Carte[]): number =>
  arrondirALaDizaine(main.reduce((total, carte) => total + pointsEnMain(carte), 0));

const aPoseAuMoinsUneCarte = (coup: Coup, joueurId: JoueurId): boolean =>
  (coup.recapitulatifs[joueurId]?.toursAvecPose.length ?? 0) > 0;

/**
 * Score de chaque joueur pour un coup terminé.
 *
 * @param coupFriche le coup fait partie des coups frichés d'office de la Boule.
 */
export const calculerScoreCoup = (
  coup: Coup,
  gagnantId: JoueurId,
  typeVictoire: TypeVictoire,
  coupFriche: boolean,
): ScoreCoup => {
  const facteurVictoire = FACTEUR_VICTOIRE[typeVictoire];
  const multiplicateur = facteurVictoire * (coupFriche ? 2 : 1);

  const scores: Record<JoueurId, number> = {};
  const croixGagnees: Record<JoueurId, number> = {};

  // Les joueurs « sur le côté » ne jouent pas la main : ils marquent 0 sur ce
  // coup. Ils restent présents dans le décompte, leur score cumulé de Boule ne
  // variant simplement pas.
  for (const joueurId of coup.joueursSurLeCote) {
    scores[joueurId] = 0;
    croixGagnees[joueurId] = 0;
  }

  for (const joueurId of coup.ordreJoueurs) {
    if (joueurId === gagnantId) {
      scores[joueurId] = POINTS_GAGNANT * multiplicateur;
    } else if (!aPoseAuMoinsUneCarte(coup, joueurId)) {
      // Le forfait remplace le calcul de la valeur des cartes et son arrondi,
      // mais suit les mêmes multiplicateurs que les autres perdants : jusqu'à
      // 600 points sur un triple pendant un coup friché.
      scores[joueurId] = FORFAIT_SANS_POSE * multiplicateur;
    } else {
      // L'arrondi précède le multiplicateur : les règles doublent le score
      // « normalement marqué », c'est-à-dire déjà arrondi (34 → 30 → 60).
      scores[joueurId] = scoreDeLaMain(coup.mains[joueurId] ?? []) * multiplicateur;
    }

    // § « Bonus quinte flush royale » : les croix du coup sont doublées ou
    // triplées quand c'est le joueur qui les obtient qui réalise le double ou
    // le triple — donc le gagnant du coup. Le facteur friché, lui, ne touche
    // pas les croix : seul le double ou le triple les multiplie.
    const facteurCroix = joueurId === gagnantId ? facteurVictoire : 1;
    croixGagnees[joueurId] = compterCroix(coup, joueurId) * facteurCroix;
  }

  return {
    gagnantId,
    typeVictoire,
    estFriche: coupFriche,
    multiplicateur,
    scores,
    croixGagnees,
  };
};
