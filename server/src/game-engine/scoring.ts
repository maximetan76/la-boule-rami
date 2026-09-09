/**
 * Primitives de scoring.
 *
 * Réf. `docs/REGLES.md` § « Fin d'un coup et scoring » : le score d'un perdant
 * est la somme des valeurs de ses cartes en main, arrondie à la dizaine la
 * plus proche, 5 arrondissant au-dessus (35 → 40, 34 → 30).
 *
 * Le calcul complet d'un coup et celui de fin de Boule (bonus de victoire,
 * croix, écarts) restent à écrire.
 */

export const arrondirALaDizaine = (points: number): number => Math.round(points / 10) * 10;
