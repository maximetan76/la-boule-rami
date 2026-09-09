/**
 * Scoring d'un coup.
 *
 * Réf. `docs/REGLES.md` § « Fin d'un coup et scoring » :
 * - le gagnant marque -20 points, -40 en « double », -60 en « triple » ;
 * - chaque perdant marque la valeur de ses cartes en main, arrondie à la
 *   dizaine la plus proche, puis doublée ou triplée selon la victoire ;
 * - un joueur n'ayant posé aucune carte marque 100 points fixes ;
 * - un coup friché ajoute un facteur 2 qui se cumule (jusqu'à x6).
 */
import type { Coup, Joueur, JoueurId, ScoreCoup, TypeVictoire } from '../models/index.js';
import { pointsEnMain } from './cartes.js';
import { compterCroix } from './croix.js';

/** Points de base du gagnant, avant multiplicateurs. */
export const POINTS_GAGNANT = -20;

/**
 * Forfait d'un joueur n'ayant posé aucune carte du coup : 100 points « fixes »,
 * sans calcul de la valeur de ses cartes ni arrondi.
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
    // Les joueurs « sur le côté » ne jouent pas la main : ils ne marquent rien.
    // TODO(règles) : à confirmer, le texte ne dit pas explicitement qu'ils sont
    // neutralisés au score, seulement qu'ils ne jouent pas le coup.
    if (!coup.ordreJoueurs.includes(joueur.id)) {
      scores[joueur.id] = 0;
      croixGagnees[joueur.id] = 0;
      continue;
    }

    if (joueur.id === gagnantId) {
      scores[joueur.id] = POINTS_GAGNANT * multiplicateur;
    } else if (!aPoseAuMoinsUneCarte(coup, joueur.id)) {
      // TODO(règles) : le forfait de 100 points est-il lui aussi doublé ou
      // triplé par un coup friché / un double / un triple ? Le texte le dit
      // « fixe », il est donc laissé hors multiplicateurs en attendant
      // confirmation.
      scores[joueur.id] = FORFAIT_SANS_POSE;
    } else {
      // L'arrondi précède le multiplicateur : les règles doublent le score
      // « normalement marqué », c'est-à-dire déjà arrondi (34 → 30 → 60).
      scores[joueur.id] = scoreDeLaMain(joueur) * multiplicateur;
    }

    // § « Bonus quinte flush royale » : les croix du coup sont doublées ou
    // triplées quand c'est le joueur qui les obtient qui réalise le double ou
    // le triple — donc le gagnant du coup.
    // TODO(règles) : un coup friché multiplie-t-il aussi les croix ? Le texte
    // ne mentionne que le double et le triple ; le facteur friché n'est donc
    // pas appliqué ici.
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
