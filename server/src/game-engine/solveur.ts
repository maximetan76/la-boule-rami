/**
 * Le solveur de main : la meilleure répartition d'une main en combinaisons.
 *
 * Réf. docs/REGLES.md § « Conditions pour poser » et § « Le panier ». Une main
 * se découpe en combinaisons complètes — suites de 3 à 5 cartes de la même
 * couleur, brelans et carrés —, en ébauches à qui il ne manque qu'une carte, et
 * en cartes isolées. La « distance » d'une main est le nombre de cartes qu'il
 * lui manque encore : 0 pour une combinaison complète, 1 pour une ébauche, 2
 * pour une carte seule. Une main à distance 0 est finie.
 *
 * À 15 cartes — la main après la pioche —, une carte non joker peut être mise
 * de côté : c'est celle qu'on défausserait. Le solveur la choisit lui-même, ou
 * évalue la main sans une carte donnée.
 *
 * Le solveur ne connaît que la main et, s'il les reçoit, les cartes déjà
 * sorties du jeu : il sert au joueur automatique, et pourrait dire à un joueur
 * humain qu'il peut finir. Chaque combinaison qu'il propose est passée par la
 * validation du moteur — il ne propose jamais une pose que `jouerTour`
 * refuserait.
 */
import {
  COULEURS,
  type Carte,
  type CarteNormale,
  type CartePosee,
  type Combinaison,
  type Couleur,
  type Valeur,
} from '../models/index.js';
import { estJoker, RANG_MAX, RANG_MIN, rang } from './cartes.js';
import { estCombinaisonValide, verifierDeclarationsJokers } from './combinaisons.js';

/** Chaque carte existe en deux exemplaires : deux jeux de 52. */
const EXEMPLAIRES = 2;

/** Ce que coûte ce qui n'est pas une combinaison complète, en cartes manquantes. */
const COUT_EBAUCHE = 1;
const COUT_ISOLEE = 2;

/** Au-delà, la distance l'emporte toujours sur le potentiel qui départage. */
const POIDS_DISTANCE = 10_000;

/** Ce qu'une carte manquante encore en jeu vaut au départage. */
const POTENTIEL_PAR_SORTIE = 10;
/** Un joker et une carte : presque tout les complète. */
const POTENTIEL_EBAUCHE_JOKER = 30;

export interface Repartition {
  /** Combinaisons complètes, posables telles quelles. */
  readonly combinaisons: Combinaison[];
  /** Groupes de deux cartes à qui il ne manque qu'une carte. */
  readonly ebauches: Carte[][];
  /** Cartes que rien ne relie encore. */
  readonly isolees: Carte[];
  /** La carte mise de côté, pour une main de 15 cartes. */
  readonly defausse: Carte | null;
  /** Cartes qu'il manque encore : 0, la main est finie. */
  readonly distance: number;
  /** Départage à distance égale : plus grand, meilleur. */
  readonly potentiel: number;
}

export interface OptionsDuSolveur {
  /**
   * Cartes que l'on sait hors d'atteinte — la défausse, les combinaisons
   * posées. Une ébauche dont les cartes manquantes sont toutes sorties est
   * morte : elle ne compte pas.
   */
  readonly cartesVues?: readonly Carte[];
  /** Le joueur qui poserait : les combinaisons proposées sont les siennes. */
  readonly proprietaireId?: string;
  /** Identifiant des combinaisons proposées. */
  readonly nouvelId?: () => string;
}

type Identite = `${Couleur}:${Valeur}`;
const identite = (couleur: Couleur, valeur: Valeur): Identite => `${couleur}:${valeur}`;

const valeurDuRang = (r: number): Valeur => {
  if (r === RANG_MIN || r === RANG_MAX) return 'A';
  if (r === 11) return 'V';
  if (r === 12) return 'D';
  if (r === 13) return 'R';
  return r as Valeur;
};

/** Les rangs qu'une carte peut occuper dans une suite : l'as en a deux. */
const rangsPossibles = (valeur: Valeur): number[] =>
  valeur === 'A' ? [RANG_MIN, RANG_MAX] : [rang(valeur, true)];

/** Un groupe possible : une combinaison complète, ou une ébauche. */
interface Candidat {
  readonly masque: number;
  readonly cout: number;
  readonly potentiel: number;
  /** Pour une combinaison complète : les cartes à leur place, jokers déclarés. */
  readonly posees: readonly CartePosee[] | null;
  readonly genre: { readonly type: 'tierce'; readonly couleur: Couleur } | { readonly type: 'ensemble'; readonly valeur: Valeur } | null;
}

interface Resultat {
  readonly score: number;
  readonly choix: Candidat | 'isolee' | 'defausse' | null;
}

const bit = (index: number): number => 1 << index;

const combinaisons = <T>(elements: readonly T[], taille: number): T[][] => {
  if (taille === 0) return [[]];
  if (elements.length < taille) return [];
  const [tete, ...reste] = elements as [T, ...T[]];
  return [
    ...combinaisons(reste, taille - 1).map((suite) => [tete, ...suite]),
    ...combinaisons(reste, taille),
  ];
};

/**
 * L'analyse d'une main : ses groupes possibles, calculés une fois, et la
 * recherche de la meilleure répartition, avec ou sans carte mise de côté.
 */
export class AnalyseDeMain {
  private readonly cartes: readonly Carte[];
  private readonly parPlusPetiteCarte: Candidat[][];
  private readonly nonVues: Map<Identite, number>;
  private readonly options: OptionsDuSolveur;

  constructor(main: readonly Carte[], options: OptionsDuSolveur = {}) {
    if (main.length > 30) throw new Error('Main trop grande pour le solveur');
    this.cartes = [...main];
    this.options = options;
    this.nonVues = this.compterLesCartesEnJeu(options.cartesVues ?? []);
    this.parPlusPetiteCarte = this.cartes.map(() => []);
    for (const candidat of [...this.combinaisonsCompletes(), ...this.ebauches()]) {
      const plusPetite = Math.log2(candidat.masque & -candidat.masque);
      this.parPlusPetiteCarte[plusPetite]?.push(candidat);
    }
  }

  /**
   * La meilleure répartition.
   *
   * @param miseDeCote `'libre'` : une carte non joker est mise de côté, au
   * choix du solveur ; une carte : c'est elle ; `null` : toute la main compte.
   */
  meilleure(miseDeCote: 'libre' | Carte | null = null): Repartition {
    const memo = new Map<number, Resultat>();
    let depart = 0;
    let libre = miseDeCote === 'libre';
    let defausse: Carte | null = null;
    if (miseDeCote !== null && miseDeCote !== 'libre') {
      const index = this.cartes.findIndex((carte) => carte.id === miseDeCote.id);
      if (index < 0) throw new Error(`Carte ${miseDeCote.id} absente de la main`);
      depart = bit(index);
      defausse = miseDeCote;
      libre = false;
    }

    const tout = bit(this.cartes.length) - 1;
    const chercher = (masque: number, libreEncore: boolean): Resultat => {
      if (masque === tout) return { score: libreEncore ? Number.POSITIVE_INFINITY : 0, choix: null };
      const cle = masque * 2 + (libreEncore ? 1 : 0);
      const connu = memo.get(cle);
      if (connu !== undefined) return connu;

      let i = 0;
      while ((masque & bit(i)) !== 0) i += 1;
      const carte = this.cartes[i] as Carte;

      // Seule, elle coûte deux cartes ; son potentiel départage.
      let meilleur: Resultat = {
        score: COUT_ISOLEE * POIDS_DISTANCE - this.potentielIsolee(carte) + chercher(masque | bit(i), libreEncore).score,
        choix: 'isolee',
      };
      if (libreEncore && !estJoker(carte)) {
        const score = chercher(masque | bit(i), false).score;
        if (score < meilleur.score) meilleur = { score, choix: 'defausse' };
      }
      for (const candidat of this.parPlusPetiteCarte[i] ?? []) {
        if ((candidat.masque & masque) !== 0) continue;
        const score =
          candidat.cout * POIDS_DISTANCE - candidat.potentiel + chercher(masque | candidat.masque, libreEncore).score;
        if (score < meilleur.score) meilleur = { score, choix: candidat };
      }
      memo.set(cle, meilleur);
      return meilleur;
    };

    const racine = chercher(depart, libre);
    if (!Number.isFinite(racine.score)) {
      throw new Error('Aucune carte ne peut être mise de côté : la main ne compte que des jokers');
    }

    // On refait le chemin choisi pour en tirer la répartition.
    const resultat = {
      combinaisons: [] as Combinaison[],
      ebauches: [] as Carte[][],
      isolees: [] as Carte[],
      defausse,
      distance: 0,
      potentiel: 0,
    };
    let masque = depart;
    let libreEncore = libre;
    while (masque !== tout) {
      const etape = memo.get(masque * 2 + (libreEncore ? 1 : 0));
      if (etape === undefined || etape.choix === null) break;
      let i = 0;
      while ((masque & bit(i)) !== 0) i += 1;
      const carte = this.cartes[i] as Carte;
      if (etape.choix === 'isolee') {
        resultat.isolees.push(carte);
        resultat.distance += COUT_ISOLEE;
        resultat.potentiel += this.potentielIsolee(carte);
        masque |= bit(i);
      } else if (etape.choix === 'defausse') {
        resultat.defausse = carte;
        libreEncore = false;
        masque |= bit(i);
      } else {
        const candidat = etape.choix;
        resultat.distance += candidat.cout;
        resultat.potentiel += candidat.potentiel;
        const cartes = this.cartesDu(candidat.masque);
        if (candidat.posees === null) resultat.ebauches.push(cartes);
        else resultat.combinaisons.push(this.construire(candidat));
        masque |= candidat.masque;
      }
    }
    return resultat;
  }

  // --- Les cartes encore en jeu ------------------------------------------

  private compterLesCartesEnJeu(vues: readonly Carte[]): Map<Identite, number> {
    const nonVues = new Map<Identite, number>();
    for (const couleur of COULEURS) {
      for (const r of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
        nonVues.set(identite(couleur, valeurDuRang(r)), EXEMPLAIRES);
      }
    }
    for (const carte of [...vues, ...this.cartes]) {
      if (estJoker(carte)) continue;
      const cle = identite(carte.couleur, carte.valeur);
      nonVues.set(cle, Math.max(0, (nonVues.get(cle) ?? 0) - 1));
    }
    return nonVues;
  }

  private sorties(identites: readonly Identite[]): number {
    return [...new Set(identites)].reduce((total, cle) => total + (this.nonVues.get(cle) ?? 0), 0);
  }

  /** Ce qui pourrait encore rejoindre une carte seule : même valeur, couleur voisine. */
  private potentielIsolee(carte: Carte): number {
    if (estJoker(carte)) return 0;
    const memeValeur = COULEURS.filter((c) => c !== carte.couleur).map((c) => identite(c, carte.valeur));
    const voisines = rangsPossibles(carte.valeur).flatMap((r) =>
      [r - 2, r - 1, r + 1, r + 2]
        .filter((v) => v >= RANG_MIN && v <= RANG_MAX)
        .map((v) => identite(carte.couleur, valeurDuRang(v))),
    );
    return this.sorties([...memeValeur, ...voisines]);
  }

  // --- Les groupes possibles ---------------------------------------------

  private indexDes(filtre: (carte: Carte) => boolean): number[] {
    return this.cartes.flatMap((carte, index) => (filtre(carte) ? [index] : []));
  }

  private get jokers(): number[] {
    return this.indexDes(estJoker);
  }

  private normale(index: number): CarteNormale {
    return this.cartes[index] as CarteNormale;
  }

  private masqueDe(indices: readonly number[]): number {
    return indices.reduce((masque, index) => masque | bit(index), 0);
  }

  private cartesDu(masque: number): Carte[] {
    return this.cartes.filter((_, index) => (masque & bit(index)) !== 0);
  }

  private *combinaisonsCompletes(): Generator<Candidat> {
    const vus = new Set<string>();
    const garder = (candidat: Candidat): Candidat | null => {
      const cle = `${String(candidat.masque)}:${candidat.posees?.map((cp) => `${cp.carte.id}=${cp.remplace?.couleur ?? ''}${String(cp.remplace?.valeur ?? '')}`).join(',') ?? ''}`;
      if (vus.has(cle)) return null;
      vus.add(cle);
      return this.estPosable(candidat) ? candidat : null;
    };

    // Brelans et carrés : une carte par couleur, des jokers pour le reste.
    const jokers = this.jokers;
    const parValeur = new Map<Valeur, Map<Couleur, number[]>>();
    for (const index of this.indexDes((carte) => !estJoker(carte))) {
      const { couleur, valeur } = this.normale(index);
      const couleurs = parValeur.get(valeur) ?? new Map<Couleur, number[]>();
      couleurs.set(couleur, [...(couleurs.get(couleur) ?? []), index]);
      parValeur.set(valeur, couleurs);
    }
    for (const [valeur, couleurs] of parValeur) {
      const presentes = [...couleurs.keys()];
      for (let reelles = 2; reelles <= Math.min(4, presentes.length); reelles += 1) {
        for (const choixCouleurs of combinaisons(presentes, reelles)) {
          for (const indices of this.produit(choixCouleurs.map((c) => couleurs.get(c) ?? []))) {
            for (let nbJokers = 0; nbJokers <= Math.min(jokers.length, 4 - reelles); nbJokers += 1) {
              if (reelles + nbJokers < 3) continue;
              const libres = COULEURS.filter((c) => !choixCouleurs.includes(c));
              for (const choixJokers of combinaisons(jokers, nbJokers)) {
                const posees: CartePosee[] = [
                  ...indices.map((index) => ({ carte: this.cartes[index] as Carte, remplace: null })),
                  ...choixJokers.map((index, rangJoker) => ({
                    carte: this.cartes[index] as Carte,
                    remplace: { couleur: libres[rangJoker] as Couleur, valeur },
                  })),
                ];
                const candidat = garder({
                  masque: this.masqueDe([...indices, ...choixJokers]),
                  cout: 0,
                  potentiel: 0,
                  posees,
                  genre: { type: 'ensemble', valeur },
                });
                if (candidat !== null) yield candidat;
              }
            }
          }
        }
      }
    }

    // Suites : de 3 à 5 rangs consécutifs, chaque place tenue par la bonne
    // carte ou par un joker déclaré.
    for (const couleur of COULEURS) {
      const parRang = new Map<number, number[]>();
      for (const index of this.indexDes((carte) => !estJoker(carte) && carte.couleur === couleur)) {
        for (const r of rangsPossibles(this.normale(index).valeur)) {
          parRang.set(r, [...(parRang.get(r) ?? []), index]);
        }
      }
      if (parRang.size === 0) continue;
      for (let longueur = 3; longueur <= 5; longueur += 1) {
        for (let debut = RANG_MIN; debut + longueur - 1 <= RANG_MAX; debut += 1) {
          for (const posees of this.remplir(couleur, debut, longueur, parRang, jokers)) {
            const indices = posees.map((cp) => this.cartes.findIndex((carte) => carte.id === cp.carte.id));
            const candidat = garder({
              masque: this.masqueDe(indices),
              cout: 0,
              potentiel: 0,
              posees,
              genre: { type: 'tierce', couleur },
            });
            if (candidat !== null) yield candidat;
          }
        }
      }
    }
  }

  /** Toutes les façons de tenir chaque rang d'une fenêtre de suite. */
  private *remplir(
    couleur: Couleur,
    debut: number,
    longueur: number,
    parRang: ReadonlyMap<number, readonly number[]>,
    jokers: readonly number[],
  ): Generator<CartePosee[]> {
    const places: CartePosee[] = [];
    const prises = new Set<number>();
    const self = this;
    function* suivante(position: number, jokersPris: number): Generator<CartePosee[]> {
      if (position === longueur) {
        if (places.some((cp) => !estJoker(cp.carte))) yield [...places];
        return;
      }
      const r = debut + position;
      for (const index of parRang.get(r) ?? []) {
        if (prises.has(index)) continue;
        prises.add(index);
        places.push({ carte: self.cartes[index] as Carte, remplace: null });
        yield* suivante(position + 1, jokersPris);
        places.pop();
        prises.delete(index);
      }
      const joker = jokers[jokersPris];
      if (joker !== undefined) {
        places.push({ carte: self.cartes[joker] as Carte, remplace: { couleur, valeur: valeurDuRang(r) } });
        yield* suivante(position + 1, jokersPris + 1);
        places.pop();
      }
    }
    yield* suivante(0, 0);
  }

  private *ebauches(): Generator<Candidat> {
    const normales = this.indexDes((carte) => !estJoker(carte));
    const vus = new Set<number>();
    const ebauche = (indices: readonly number[], manquantes: readonly Identite[]): Candidat | null => {
      const masque = this.masqueDe(indices);
      const sorties = this.sorties(manquantes);
      if (sorties === 0 || vus.has(masque)) return null;
      vus.add(masque);
      return { masque, cout: COUT_EBAUCHE, potentiel: sorties * POTENTIEL_PAR_SORTIE, posees: null, genre: null };
    };

    for (const [a, b] of combinaisons(normales, 2)) {
      const x = this.normale(a as number);
      const y = this.normale(b as number);
      // Même valeur, deux couleurs : il manque l'une des deux autres couleurs.
      if (x.valeur === y.valeur && x.couleur !== y.couleur) {
        const manquantes = COULEURS.filter((c) => c !== x.couleur && c !== y.couleur).map((c) =>
          identite(c, x.valeur),
        );
        const candidat = ebauche([a as number, b as number], manquantes);
        if (candidat !== null) yield candidat;
        continue;
      }
      // Même couleur, à un ou deux rangs : il manque un bout, ou le milieu.
      if (x.couleur !== y.couleur) continue;
      for (const rx of rangsPossibles(x.valeur)) {
        for (const ry of rangsPossibles(y.valeur)) {
          const [bas, haut] = rx < ry ? [rx, ry] : [ry, rx];
          const ecart = haut - bas;
          if (ecart < 1 || ecart > 2) continue;
          const rangs = ecart === 1 ? [bas - 1, haut + 1] : [bas + 1];
          const manquantes = rangs
            .filter((r) => r >= RANG_MIN && r <= RANG_MAX)
            .map((r) => identite(x.couleur, valeurDuRang(r)));
          const candidat = ebauche([a as number, b as number], manquantes);
          if (candidat !== null) yield candidat;
        }
      }
    }

    // Un joker et une carte : il ne manque qu'une carte, et presque toutes vont.
    for (const joker of this.jokers) {
      for (const index of normales) {
        const masque = this.masqueDe([joker, index]);
        if (vus.has(masque)) continue;
        vus.add(masque);
        yield { masque, cout: COUT_EBAUCHE, potentiel: POTENTIEL_EBAUCHE_JOKER, posees: null, genre: null };
      }
    }
  }

  private *produit(listes: readonly (readonly number[])[]): Generator<number[]> {
    if (listes.length === 0) {
      yield [];
      return;
    }
    const [premiere, ...reste] = listes as [readonly number[], ...(readonly number[])[]];
    for (const index of premiere) {
      for (const suite of this.produit(reste)) yield [index, ...suite];
    }
  }

  // --- Les combinaisons proposées ------------------------------------------

  private construire(candidat: Candidat, id = this.options.nouvelId?.() ?? 'solveur'): Combinaison {
    const posees = candidat.posees ?? [];
    const pure = posees.every((cp) => !estJoker(cp.carte));
    const base = { id, proprietaireId: this.options.proprietaireId ?? '', tourDePose: 0, cartes: posees, pure };
    const genre = candidat.genre;
    if (genre?.type === 'tierce') return { ...base, type: 'tierce', couleur: genre.couleur };
    if (genre?.type === 'ensemble') {
      return { ...base, type: posees.length >= 4 ? 'carre' : 'brelan', valeur: genre.valeur };
    }
    throw new Error('Une ébauche ne se pose pas');
  }

  /** La validation du moteur, déclarations comprises. */
  private estPosable(candidat: Candidat): boolean {
    const combinaison = this.construire(candidat, 'verification');
    if (!estCombinaisonValide(combinaison)) return false;
    try {
      verifierDeclarationsJokers([combinaison]);
      return true;
    } catch {
      return false;
    }
  }
}

/** La meilleure répartition d'une main. Voir `AnalyseDeMain`. */
export const repartir = (
  main: readonly Carte[],
  miseDeCote: 'libre' | Carte | null = null,
  options: OptionsDuSolveur = {},
): Repartition => new AnalyseDeMain(main, options).meilleure(miseDeCote);

/**
 * Cette main de 15 cartes peut-elle finir le coup ? Réf. § « Fin de coup
 * automatique » : les 14 cartes posées en combinaisons, la 15e défaussée — un
 * joker ne se défausse jamais.
 *
 * Rend la répartition qui finit, ou `null`.
 */
export const peutFinir = (main: readonly Carte[], options: OptionsDuSolveur = {}): Repartition | null => {
  if (main.length < 2) return null;
  const repartition = repartir(main, 'libre', options);
  return repartition.distance === 0 && repartition.defausse !== null ? repartition : null;
};
