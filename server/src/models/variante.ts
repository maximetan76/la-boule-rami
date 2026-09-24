/**
 * Les variantes du jeu.
 *
 * Réf. docs/REGLES.md. « La Boule » est le jeu complet, à 2 à 6 joueurs.
 * « Le panier » est la variante à 2 joueurs : un paquet plus court, un joker
 * donné d'office à chacun, aucune pose avant la fin du coup, et un match qui
 * se gagne en manches plutôt qu'en points.
 */
export type Variante = 'boule' | 'panier';

export const VARIANTES: readonly Variante[] = ['boule', 'panier'];

export const estVariante = (valeur: unknown): valeur is Variante =>
  typeof valeur === 'string' && (VARIANTES as readonly string[]).includes(valeur);

/** Le nom du mode, tel qu'il s'écrit. */
export const NOM_DE_LA_VARIANTE: Readonly<Record<Variante, string>> = {
  boule: 'La Boule',
  panier: 'Le panier',
};
