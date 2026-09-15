/**
 * Validation et chiffrage des combinaisons.
 *
 * Réf. `docs/REGLES.md` § « Conditions pour poser » :
 * - une tierce est une suite de 3 à 5 cartes consécutives de la même couleur ;
 * - un brelan / carré réunit la même valeur en couleurs toutes différentes ;
 * - une tierce franche ne contient aucun joker ; le coucou est la seule exception
 *   admise dans la tierce qui valide une pose.
 */
import type { Carte, Combinaison, CartePosee, Couleur, Tierce, Valeur } from '../models/index.js';
import { TIERCE_LONGUEUR_MAX, TIERCE_LONGUEUR_MIN } from '../models/index.js';
import { COULEURS } from '../models/carte.js';
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
      `Joker non declare (${description}) : precisez la carte ` +
        `qu il represente via le champ « remplace » avant de le poser dans une suite.`,
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

/**
 * La carte qu'un joker posé représente : celle qu'il déclare, ou, dans un
 * brelan ou un carré, celle que les autres cartes ne laissent qu'à lui.
 *
 * Réf. docs/REGLES.md § « Récupération d'un joker posé ». Un ensemble n'a
 * qu'une carte par couleur : 3♥, 3♣, 3♠ et un joker non déclaré, ce joker ne
 * peut être que le 3♦. Avec deux couleurs encore libres, ou deux jokers non
 * déclarés, rien ne se déduit. `null` pour une carte réelle, ou une identité
 * encore ambiguë.
 */
export const carteRepresentee = (
  combinaison: Combinaison,
  posee: CartePosee,
): { readonly couleur: Couleur; readonly valeur: Valeur } | null => {
  if (!estJoker(posee.carte)) return null;
  if (posee.remplace !== null) return posee.remplace;
  if (combinaison.type === 'tierce') return null;

  const nonDeclares = combinaison.cartes.filter((cp) => estJoker(cp.carte) && cp.remplace === null);
  if (nonDeclares.length !== 1) return null;
  const prises = new Set(
    combinaison.cartes.map(resoudre).filter((r): r is CarteResolue => r !== null).map((r) => r.couleur),
  );
  const libres = COULEURS.filter((couleur) => !prises.has(couleur));
  const couleur = libres[0];
  return libres.length === 1 && couleur !== undefined ? { couleur, valeur: combinaison.valeur } : null;
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

  // Réf. § « Conditions pour poser » : une seule carte réelle parmi des jokers
  // forme une suite, jamais un brelan ni un carré.
  if (cartes.filter((cp) => cp.carte.type === 'normale').length < 2) return false;

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
 * Tierce « franche » au sens littéral des règles : une tierce valide sans aucun
 * joker dedans — le coucou compris.
 */
export const estTierceFranche = (combinaison: Combinaison): boolean =>
  estTierceValide(combinaison) && !contientUnJoker(combinaison.cartes);

/**
 * Tierce acceptable pour valider une première pose.
 *
 * C'est la tierce franche, plus la seule exception des règles : le coucou peut
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
/**
 * Une suite dont une seule carte est réelle : la carte n'y est jamais en bout.
 *
 * Réf. docs/REGLES.md § « Conditions pour poser ». À trois cartes, elle est au
 * centre, un joker juste en dessous, un juste au-dessus ; à quatre, en
 * deuxième ou troisième place — Valet et trois jokers se lisent 9-10-V-D ou
 * 10-V-D-R. Un As, toujours en bout de suite, ne peut jamais être la seule
 * carte réelle. Des jokers encore non déclarés laissent la lecture à dire :
 * `fenetreTierce` le signale ensuite.
 */
const verifierEncadrement = (combinaison: Combinaison): void => {
  const reelles = combinaison.cartes.filter((cp) => cp.carte.type === 'normale');
  const reelle = reelles[0]?.carte;
  if (reelles.length !== 1 || reelle === undefined || reelle.type !== 'normale') return;
  const aTroisCartes = combinaison.cartes.length === 3;

  if (reelle.valeur === 'A') {
    throw new Error(
      aTroisCartes
        ? 'Un As ne peut pas etre encadre par deux jokers'
        : 'Un As ne peut pas etre la seule carte reelle d une suite : il y serait toujours en bout',
    );
  }
  if (combinaison.cartes.some((cp) => cp.carte.type !== 'normale' && cp.remplace === null)) return;

  const fenetre = fenetreTierce(combinaison);
  if (fenetre === null) return;
  const rangReel = rang(reelle.valeur, true);
  if (rangReel > fenetre.debut && rangReel < fenetre.fin) return;
  throw new Error(
    aTroisCartes
      ? "Une tierce d'une seule carte et de deux jokers doit encadrer la carte : un joker juste en dessous, un juste au-dessus"
      : "Une suite d'une seule carte reelle ne la place jamais en bout : il faut au moins un joker de chaque cote",
  );
};

/** Une seule carte réelle parmi des jokers : c'est une suite, jamais un ensemble. */
const cartesReelles = (combinaison: Combinaison): number =>
  combinaison.cartes.filter((cp) => cp.carte.type === 'normale').length;

export const verifierDeclarationsJokers = (combinaisons: readonly Combinaison[]): void => {
  for (const combinaison of combinaisons) {
    if (combinaison.type !== 'tierce') {
      if (cartesReelles(combinaison) < 2) {
        throw new Error(
          'Un brelan ou un carre compte au moins deux cartes reelles : une seule carte et des jokers forment une suite',
        );
      }
      continue;
    }
    // Réf. § « Conditions pour poser » : tout joker d'une suite dit la carte
    // qu'il remplace, même quand sa place ne fait aucun doute — sans quoi il
    // ne pourrait jamais être récupéré.
    if (combinaison.cartes.some((cp) => estJoker(cp.carte) && cp.remplace === null)) {
      throw new DeclarationJokerRequiseError(decrire(combinaison));
    }
    verifierEncadrement(combinaison);
    // Une tierce simplement invalide n'est pas un problème de déclaration :
    // elle sera refusée par la validation ordinaire.
    if (!estTierceValide(combinaison)) continue;
    if (fenetreTierce(combinaison) === null) {
      throw new DeclarationJokerRequiseError(decrire(combinaison));
    }
  }
};

/**
 * Un ajout à une suite déjà posée : chaque joker ajouté déclare la carte qu'il
 * remplace, comme à la pose. Un brelan ou un carré n'exige rien : la valeur
 * est commune, et la couleur se déduit quand il n'en reste qu'une.
 * @throws DeclarationJokerRequiseError
 */
export const verifierDeclarationsAjout = (
  combinaison: Combinaison,
  ajoutees: readonly CartePosee[],
): void => {
  if (combinaison.type !== 'tierce') return;
  if (ajoutees.some((cp) => estJoker(cp.carte) && cp.remplace === null)) {
    throw new DeclarationJokerRequiseError(decrire({ ...combinaison, cartes: [...combinaison.cartes, ...ajoutees] }));
  }
};

/** Extrait les cartes d'une combinaison, jokers compris. */
export const cartesDe = (combinaison: Tierce | Combinaison): Carte[] =>
  combinaison.cartes.map((cp) => cp.carte);
