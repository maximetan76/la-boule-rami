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
import {
  estJoker,
  pointsDeValeur,
  pointsDuRang,
  rang,
  RANG_MAX,
  RANG_MIN,
} from './cartes.js';

/** Carte effectivement représentée par une carte posée, `null` si le joker ne déclare rien. */
interface CarteResolue {
  readonly couleur: Couleur;
  readonly valeur: Valeur;
}

/**
 * Un joker posé à un bout de suite doit déclarer la carte qu'il représente :
 * sans cela, la suite se lit de plusieurs façons et son chiffrage est
 * arbitraire. Aucune lecture par défaut n'est retenue.
 */
export class DeclarationJokerRequiseError extends Error {
  constructor(description: string) {
    super(
      `Joker en bout de suite non declare (${description}) : precisez la carte ` +
        `qu il represente via le champ « remplace » avant de poser cette tierce.`,
    );
    this.name = 'DeclarationJokerRequiseError';
  }
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
export const resoudreTierce = (
  combinaison: Combinaison,
  options: { readonly plafonnee?: boolean } = {},
): boolean | null => {
  if (combinaison.type !== 'tierce') return null;

  const { plafonnee = true } = options;
  const { cartes, couleur } = combinaison;
  if (cartes.length < TIERCE_LONGUEUR_MIN) return null;
  if (plafonnee && cartes.length > TIERCE_LONGUEUR_MAX) return null;

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
  const asHaut = resoudreTierce(combinaison, { plafonnee: false });
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
 * Une tierce déjà posée que l'on prolonge, sans plafond de longueur.
 *
 * Réf. docs/REGLES.md § « Conditions pour poser » : la scission obligatoire
 * d'une suite de 6 cartes ou plus vise la POSE — on ne pose jamais une telle
 * combinaison d'un coup. Une combinaison déjà sur la table, elle, s'allonge
 * par ses extrémités un ajout à la fois, et rien ne la plafonne.
 */
export const estTierceProlongeeValide = (combinaison: Combinaison): boolean =>
  resoudreTierce(combinaison, { plafonnee: false }) !== null;

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

/** La même chose, pour une combinaison que l'on vient d'allonger. */
export const estCombinaisonProlongeeValide = (combinaison: Combinaison): boolean =>
  combinaison.type === 'tierce'
    ? estTierceProlongeeValide(combinaison)
    : estEnsembleValide(combinaison);

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
export const estTierceValidante = (combinaison: Combinaison): boolean => {
  if (!estTierceValide(combinaison)) return false;
  if (!contientJokerNormal(combinaison.cartes)) return true;

  // Un joker normal quelque part n'empêche rien s'il reste, ailleurs dans la
  // suite, trois rangs consécutifs tenus sans lui : [coucou=10]-V-D-[joker=R]-A
  // de trèfle contient la tierce [coucou=10]-V-D.
  const asHaut = resoudreTierce(combinaison, { plafonnee: false });
  const fenetre = fenetreTierce(combinaison);
  if (asHaut === null || fenetre === null) return false;

  const occupes = new Set<number>();
  const francs = new Set<number>();
  let nonDeclares = 0;
  let coucousNonDeclares = 0;
  for (const posee of combinaison.cartes) {
    const resolue = resoudre(posee);
    if (resolue === null) {
      nonDeclares += 1;
      if (posee.carte.type === 'coucou') coucousNonDeclares += 1;
      continue;
    }
    const r = rang(resolue.valeur, asHaut);
    occupes.add(r);
    if (posee.carte.type !== 'joker') francs.add(r);
  }
  // Des rangs laissés à des coucous non déclarés restent francs ; avec un
  // joker normal parmi eux, on ne sait plus lequel tient quoi.
  if (nonDeclares > 0 && nonDeclares === coucousNonDeclares) {
    for (let r = fenetre.debut; r <= fenetre.fin; r += 1) if (!occupes.has(r)) francs.add(r);
  }

  let suite = 0;
  for (let r = fenetre.debut; r <= fenetre.fin; r += 1) {
    suite = francs.has(r) ? suite + 1 : 0;
    if (suite >= TIERCE_LONGUEUR_MIN) return true;
  }
  return false;
};

/**
 * Points de pose d'une combinaison.
 *
 * Un joker, coucou compris, compte pour la carte qu'il remplace : un joker à
 * la place d'une dame vaut 10 points, à la place de l'as d'une tierce As-2-3
 * il vaut 1 point, et 11 points dans une tierce D-R-A ou un brelan d'as. Sa
 * valeur de 20 points ne concerne que les cartes restées en main à la fin
 * d'un coup (§ « Fin d'un coup et scoring »), pas ce calcul.
 *
 * La carte remplacée vient du champ `remplace` déclaré à la pose ; quand un
 * joker est encadré par des cartes qui ne laissent qu'une lecture possible,
 * elle est déduite de la combinaison.
 *
 * @throws si la combinaison n'est pas valide, ou si un joker non déclaré rend
 * sa position ambiguë — un chiffrage silencieux fausserait la condition des
 * 51 points.
 */
export const calculerValeurCombinaison = (combinaison: Combinaison): number => {
  if (combinaison.type === 'tierce') {
    if (!estTierceValide(combinaison)) {
      throw new Error(`Tierce invalide : ${decrire(combinaison)}`);
    }
    const fenetre = fenetreTierce(combinaison);
    if (fenetre === null) {
      throw new DeclarationJokerRequiseError(decrire(combinaison));
    }
    // Chaque rang de la suite est occupé par exactement une carte, réelle ou
    // remplacée par un joker : le total ne dépend donc que de la fenêtre.
    let total = 0;
    for (let r = fenetre.debut; r <= fenetre.fin; r += 1) {
      total += pointsDuRang(r);
    }
    return total;
  }

  if (!estEnsembleValide(combinaison)) {
    throw new Error(`Brelan ou carre invalide : ${decrire(combinaison)}`);
  }
  // Toutes les cartes d'un brelan ou d'un carré ont la même valeur, jokers
  // compris ; l'as y vaut toujours 11.
  return combinaison.cartes.length * pointsDeValeur(combinaison.valeur, true);
};

const nommer = (carte: Carte): string => {
  if (carte.type === 'joker') return 'joker';
  if (carte.type === 'coucou') return 'coucou';
  return `${String(carte.valeur)} de ${carte.couleur}`;
};

const decrire = (combinaison: Combinaison): string =>
  combinaison.cartes.map((cp) => nommer(cp.carte)).join(', ');

/**
 * Rangs réellement occupés par une tierce, jokers résolus, avec sa couleur.
 * Renvoie `null` si la combinaison n'est pas une tierce lisible sans ambiguïté.
 */
export const rangsResolus = (
  combinaison: Combinaison,
): { couleur: Couleur; rangs: number[] } | null => {
  if (combinaison.type !== 'tierce') return null;
  const fenetre = fenetreTierce(combinaison);
  if (fenetre === null) return null;

  const rangs: number[] = [];
  for (let r = fenetre.debut; r <= fenetre.fin; r += 1) rangs.push(r);
  return { couleur: combinaison.couleur, rangs };
};

/** Rangs occupés par les cartes réelles d'une combinaison, pour une couleur donnée. */
export const rangsDesCartesReelles = (combinaison: Combinaison, couleur: Couleur): number[] => {
  const resolues = combinaison.cartes
    .map(resoudre)
    .filter((r): r is CarteResolue => r !== null && r.couleur === couleur);
  return resolues.flatMap((r) => [rang(r.valeur, true), rang(r.valeur, false)]);
};

/**
 * Vérifie que toute combinaison proposée est lisible sans ambiguïté.
 * @throws DeclarationJokerRequiseError si un joker en bout de suite n'est pas déclaré.
 */
/** La valeur de chaque rang, de 1 à 14 : l'As se lit en 1 sous le 2, en 14 sur le Roi. */
const VALEUR_DU_RANG: readonly (Valeur | null)[] = [null, 'A', 2, 3, 4, 5, 6, 7, 8, 9, 10, 'V', 'D', 'R', 'A'];

/**
 * Une tierce de trois cartes dont une seule est réelle : la carte réelle est
 * au centre, un joker juste en dessous, un juste au-dessus.
 *
 * Réf. docs/REGLES.md § « Conditions pour poser ». Aucune autre disposition
 * n'est valide, et un As — toujours en bout de suite — ne peut jamais être
 * ainsi encadré. Des jokers encore non déclarés laissent la lecture à dire :
 * `fenetreTierce` le signale ensuite.
 */
const verifierEncadrement = (combinaison: Combinaison): void => {
  if (combinaison.cartes.length !== 3) return;
  const reelles = combinaison.cartes.filter((cp) => cp.carte.type === 'normale');
  const reelle = reelles[0]?.carte;
  if (reelles.length !== 1 || reelle === undefined || reelle.type !== 'normale') return;

  if (reelle.valeur === 'A') throw new Error('Un As ne peut pas etre encadre par deux jokers');

  const declarees = combinaison.cartes
    .filter((cp) => cp.carte.type !== 'normale')
    .map((cp) => cp.remplace?.valeur ?? null);
  if (declarees.some((valeur) => valeur === null)) return;

  const centre = rang(reelle.valeur, true);
  const attendues = [VALEUR_DU_RANG[centre - 1], VALEUR_DU_RANG[centre + 1]];
  const encadree = attendues.every((attendue) => declarees.some((valeur) => valeur === attendue));
  if (!encadree) {
    throw new Error(
      "Une tierce d'une seule carte et de deux jokers doit encadrer la carte : un joker juste en dessous, un juste au-dessus",
    );
  }
};

export const verifierDeclarationsJokers = (combinaisons: readonly Combinaison[]): void => {
  for (const combinaison of combinaisons) {
    if (combinaison.type !== 'tierce') continue;
    verifierEncadrement(combinaison);
    // Une tierce simplement invalide n'est pas un problème de déclaration :
    // elle sera refusée par la validation ordinaire.
    if (!estTierceValide(combinaison)) continue;
    if (fenetreTierce(combinaison) === null) {
      throw new DeclarationJokerRequiseError(decrire(combinaison));
    }
  }
};

/** Extrait les cartes d'une combinaison, jokers compris. */
export const cartesDe = (combinaison: Tierce | Combinaison): Carte[] =>
  combinaison.cartes.map((cp) => cp.carte);
