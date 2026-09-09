/**
 * Validation et chiffrage des combinaisons.
 *
 * Réf. `docs/REGLES.md` § « Conditions pour poser » :
 * - une tierce est une suite de 3 à 5 cartes consécutives de la même couleur ;
 * - un brelan / carré réunit la même valeur en couleurs toutes différentes ;
 * - une tierce pure ne contient aucun joker ; le coucou est la seule exception
 *   admise dans la tierce qui valide une pose.
 */
import type { Carte, Combinaison, CartePosee, Couleur, Tierce, Valeur } from '../models/index.js';
import { TIERCE_LONGUEUR_MAX, TIERCE_LONGUEUR_MIN } from '../models/index.js';
import { estJoker, pointsDePose, rang, RANG_MAX, RANG_MIN } from './cartes.js';

/** Carte effectivement représentée par une carte posée, `null` si le joker ne déclare rien. */
interface CarteResolue {
  readonly couleur: Couleur;
  readonly valeur: Valeur;
}

const resoudre = (posee: CartePosee): CarteResolue | null => {
  if (!estJoker(posee.carte)) {
    const { couleur, valeur } = posee.carte;
    return { couleur, valeur };
  }
  return posee.remplace;
};

const contientJokerNormal = (cartes: readonly CartePosee[]): boolean =>
  cartes.some((cp) => cp.carte.type === 'joker');

const contientUnJoker = (cartes: readonly CartePosee[]): boolean =>
  cartes.some((cp) => estJoker(cp.carte));

/**
 * Résout la lecture d'une tierce : renvoie `true` si l'as doit se lire haut,
 * `false` s'il se lit bas, et `null` si la combinaison n'est pas une tierce
 * valide. La lecture as haut est essayée en premier ; seules les tierces
 * ambiguës (as entouré uniquement de jokers non déclarés) en dépendent.
 */
export const resoudreTierce = (combinaison: Combinaison): boolean | null => {
  if (combinaison.type !== 'tierce') return null;

  const { cartes, couleur } = combinaison;
  if (cartes.length < TIERCE_LONGUEUR_MIN || cartes.length > TIERCE_LONGUEUR_MAX) return null;

  const resolues = cartes.map(resoudre).filter((r): r is CarteResolue => r !== null);
  // Une tierce entièrement composée de jokers non déclarés n'est pas lisible.
  if (resolues.length === 0) return null;
  if (resolues.some((r) => r.couleur !== couleur)) return null;

  for (const asHaut of [true, false]) {
    const rangs = resolues.map((r) => rang(r.valeur, asHaut));
    if (new Set(rangs).size !== rangs.length) continue;

    const min = Math.min(...rangs);
    const max = Math.max(...rangs);
    if (max - min + 1 > cartes.length) continue;

    // La fenêtre de `cartes.length` rangs consécutifs doit contenir toutes les
    // cartes connues et tenir dans l'intervalle de rangs autorisé.
    const debutMin = Math.max(max - cartes.length + 1, RANG_MIN);
    const debutMax = Math.min(min, RANG_MAX - cartes.length + 1);
    if (debutMin <= debutMax) return asHaut;
  }

  return null;
};

/**
 * Fenêtre de rangs occupée par une tierce, du plus bas au plus haut.
 *
 * Renvoie `null` si la combinaison n'est pas une tierce valide, ou si sa
 * position reste ambiguë — cas d'un joker non déclaré placé à un bout, où la
 * suite pourrait se lire décalée d'un rang.
 */
export const fenetreTierce = (combinaison: Combinaison): { debut: number; fin: number } | null => {
  const asHaut = resoudreTierce(combinaison);
  if (asHaut === null || combinaison.type !== 'tierce') return null;

  const rangs = combinaison.cartes
    .map(resoudre)
    .filter((r): r is CarteResolue => r !== null)
    .map((r) => rang(r.valeur, asHaut));

  const longueur = combinaison.cartes.length;
  const debutMin = Math.max(Math.max(...rangs) - longueur + 1, RANG_MIN);
  const debutMax = Math.min(Math.min(...rangs), RANG_MAX - longueur + 1);
  if (debutMin !== debutMax) return null;

  return { debut: debutMin, fin: debutMin + longueur - 1 };
};

/** Une tierce valide : 3 à 5 cartes consécutives de la même couleur, jokers admis. */
export const estTierceValide = (combinaison: Combinaison): boolean =>
  resoudreTierce(combinaison) !== null;

/**
 * Un brelan (3 cartes) ou un carré (4 cartes) : même valeur, couleurs toutes
 * différentes. Les jokers remplacent n'importe quelle carte manquante.
 */
export const estEnsembleValide = (combinaison: Combinaison): boolean => {
  if (combinaison.type === 'tierce') return false;

  const { cartes, valeur } = combinaison;
  const taille = combinaison.type === 'brelan' ? 3 : 4;
  if (cartes.length !== taille) return false;

  const resolues = cartes.map(resoudre).filter((r): r is CarteResolue => r !== null);
  if (resolues.some((r) => r.valeur !== valeur)) return false;

  const couleurs = resolues.map((r) => r.couleur);
  return new Set(couleurs).size === couleurs.length;
};

export const estCombinaisonValide = (combinaison: Combinaison): boolean =>
  combinaison.type === 'tierce' ? estTierceValide(combinaison) : estEnsembleValide(combinaison);

/**
 * Tierce « pure » au sens littéral des règles : une tierce valide sans aucun
 * joker dedans — le coucou compris.
 */
export const estTiercePure = (combinaison: Combinaison): boolean =>
  estTierceValide(combinaison) && !contientUnJoker(combinaison.cartes);

/**
 * Tierce acceptable pour valider une première pose.
 *
 * C'est la tierce pure, plus la seule exception des règles : le coucou peut
 * remplacer une carte même dans la tierce servant à valider la condition de
 * pose, contrairement au joker normal.
 */
export const estTierceValidante = (combinaison: Combinaison): boolean =>
  estTierceValide(combinaison) && !contientJokerNormal(combinaison.cartes);

/**
 * Points de pose d'une combinaison.
 *
 * L'as est chiffré selon sa lecture réelle dans la combinaison : 1 point dans
 * une tierce As-2-3, 11 points dans une tierce D-R-A ou un brelan d'as.
 *
 * @throws si la combinaison n'est pas valide — un chiffrage silencieux
 * fausserait la condition des 51 points.
 */
export const calculerValeurCombinaison = (combinaison: Combinaison): number => {
  if (combinaison.type === 'tierce') {
    const asHaut = resoudreTierce(combinaison);
    if (asHaut === null) {
      throw new Error(`Tierce invalide : ${decrire(combinaison)}`);
    }
    return combinaison.cartes.reduce((total, cp) => total + pointsDePose(cp.carte, asHaut), 0);
  }

  if (!estEnsembleValide(combinaison)) {
    throw new Error(`Brelan ou carre invalide : ${decrire(combinaison)}`);
  }
  // Dans un brelan ou un carré, l'as vaut toujours 11.
  return combinaison.cartes.reduce((total, cp) => total + pointsDePose(cp.carte, true), 0);
};

const nommer = (carte: Carte): string => {
  if (carte.type === 'joker') return 'joker';
  if (carte.type === 'coucou') return 'coucou';
  return `${String(carte.valeur)} de ${carte.couleur}`;
};

const decrire = (combinaison: Combinaison): string =>
  combinaison.cartes.map((cp) => nommer(cp.carte)).join(', ');

/** Extrait les cartes d'une combinaison, jokers compris. */
export const cartesDe = (combinaison: Tierce | Combinaison): Carte[] =>
  combinaison.cartes.map((cp) => cp.carte);
