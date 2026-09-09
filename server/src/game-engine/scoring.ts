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
import type { Coup, Joueur, JoueurId, ScoreCoup, TypeVictoire } from '../models/index.js';
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
export const scoreDeLaMain = (joueur: Joueur): number =>
  arrondirALaDizaine(joueur.main.reduce((total, carte) => total + pointsEnMain(carte), 0));

const aPoseAuMoinsUneCarte = (coup: Coup, joueurId: JoueurId): boolean =>
  (coup.recapitulatifs[joueurId]?.toursAvecPose.length ?? 0) > 0;

/**
 * Score de chaque joueur pour un coup terminé.
 *
 * Le paramètre `joueurs` est nécessaire en plus du `coup` : les mains, dont
 * dépend le score des perdants, sont portées par `Joueur`, pas par `Coup`.
 *
 * @param coupFriche le coup fait partie des coups frichés d'office de la Boule.
 */
export const calculerScoreCoup = (
  coup: Coup,
  joueurs: readonly Joueur[],
  gagnantId: JoueurId,
  typeVictoire: TypeVictoire,
  coupFriche: boolean,
): ScoreCoup => {
  const facteurVictoire = FACTEUR_VICTOIRE[typeVictoire];
  const multiplicateur = facteurVictoire * (coupFriche ? 2 : 1);

  const scores: Record<JoueurId, number> = {};
  const croixGagnees: Record<JoueurId, number> = {};

  for (const joueur of joueurs) {
    // Les joueurs « sur le côté » ne jouent pas la main : ils marquent 0 sur ce
    // coup. Ils restent présents dans le décompte, leur score cumulé de Boule
    // ne variant simplement pas.
    if (!coup.ordreJoueurs.includes(joueur.id)) {
      scores[joueur.id] = 0;
      croixGagnees[joueur.id] = 0;
      continue;
    }

    if (joueur.id === gagnantId) {
      scores[joueur.id] = POINTS_GAGNANT * multiplicateur;
    } else if (!aPoseAuMoinsUneCarte(coup, joueur.id)) {
      // Le forfait remplace le calcul de la valeur des cartes et son arrondi,
      // mais suit les mêmes multiplicateurs que les autres perdants : jusqu'à
      // 600 points sur un triple pendant un coup friché.
      scores[joueur.id] = FORFAIT_SANS_POSE * multiplicateur;
    } else {
      // L'arrondi précède le multiplicateur : les règles doublent le score
      // « normalement marqué », c'est-à-dire déjà arrondi (34 → 30 → 60).
      scores[joueur.id] = scoreDeLaMain(joueur) * multiplicateur;
    }

    // § « Bonus quinte flush royale » : les croix du coup sont doublées ou
    // triplées quand c'est le joueur qui les obtient qui réalise le double ou
    // le triple — donc le gagnant du coup. Le facteur friché, lui, ne touche
    // pas les croix : seul le double ou le triple les multiplie.
    const facteurCroix = joueur.id === gagnantId ? facteurVictoire : 1;
    croixGagnees[joueur.id] = compterCroix(coup, joueur.id) * facteurCroix;
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
