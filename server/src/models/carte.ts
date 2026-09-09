/**
 * Cartes du jeu.
 *
 * Réf. `docs/REGLES.md` § « Joueurs et matériel » : 2 jeux de 52 cartes
 * + 4 jokers normaux + 1 « super joker » appelé le coucou, soit 109 cartes.
 * Comme il y a deux jeux, une même couleur/valeur apparaît en double : chaque
 * carte porte donc un identifiant unique, seul moyen fiable de la désigner.
 *
 * Réf. § « Fin d'un coup et scoring » pour la distinction joker normal / coucou,
 * qui valent tous deux 20 points en main mais ne se comportent pas pareil dans
 * les combinaisons (§ « Conditions pour poser »).
 */

export const COULEURS = ['pique', 'coeur', 'carreau', 'trefle'] as const;
export type Couleur = (typeof COULEURS)[number];

/** Valeurs faciales, de la plus basse à la plus haute (V = valet, D = dame, R = roi, A = as). */
export const VALEURS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 'V', 'D', 'R', 'A'] as const;
export type Valeur = (typeof VALEURS)[number];

/** Identifiant unique d'un exemplaire de carte (les doublons entre les 2 jeux sont distincts). */
export type CarteId = string;

/** Une des 104 cartes ordinaires (2 jeux de 52). */
export interface CarteNormale {
  readonly type: 'normale';
  readonly id: CarteId;
  readonly couleur: Couleur;
  readonly valeur: Valeur;
}

/**
 * Un des 4 jokers ordinaires. Il remplace n'importe quelle carte, SAUF dans la
 * tierce qui sert à valider la condition de pose (§ « Conditions pour poser »),
 * et il interdit le « triple » (§ « Fin d'un coup et scoring »).
 */
export interface JokerNormal {
  readonly type: 'joker';
  readonly id: CarteId;
}

/**
 * Le « coucou », super joker unique. Seule exception des règles : il peut
 * remplacer une carte même dans la tierce servant à valider la pose, et il ne
 * remet pas en cause un « triple ».
 */
export interface Coucou {
  readonly type: 'coucou';
  readonly id: CarteId;
}

export type Joker = JokerNormal | Coucou;
export type Carte = CarteNormale | Joker;

/** Nombre de cartes distribuées à chaque joueur (§ « Joueurs et matériel »). */
export const CARTES_PAR_JOUEUR = 14;
