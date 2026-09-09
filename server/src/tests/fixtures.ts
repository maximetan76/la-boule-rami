/**
 * Constructeurs de cartes et de combinaisons pour les tests.
 * Aucune logique de jeu ici : uniquement de quoi écrire des cas lisibles.
 */
import type {
  Boule,
  Carte,
  CarteNormale,
  CartePosee,
  Combinaison,
  Coucou,
  Couleur,
  Coup,
  Ensemble,
  JokerNormal,
  Joueur,
  JoueurId,
  RecapJoueurCoup,
  Tierce,
  Valeur,
} from '../models/index.js';

let compteur = 0;
const prochainId = (prefixe: string): string => `${prefixe}-${(compteur += 1)}`;

/** Une carte ordinaire, par ex. `c('coeur', 7)`. */
export const c = (couleur: Couleur, valeur: Valeur): CarteNormale => ({
  type: 'normale',
  id: prochainId('carte'),
  couleur,
  valeur,
});

/** Un des 4 jokers normaux. */
export const joker = (): JokerNormal => ({ type: 'joker', id: prochainId('joker') });

/** Le super joker. */
export const coucou = (): Coucou => ({ type: 'coucou', id: prochainId('coucou') });

type Entree = Carte | CartePosee;

const estCartePosee = (e: Entree): e is CartePosee => 'carte' in e;

const poser = (e: Entree): CartePosee => (estCartePosee(e) ? e : { carte: e, remplace: null });

/** Un joker normal posé en déclarant la carte qu'il remplace. */
export const jokerPour = (couleur: Couleur, valeur: Valeur): CartePosee => ({
  carte: joker(),
  remplace: { couleur, valeur },
});

/** Le coucou posé en déclarant la carte qu'il remplace. */
export const coucouPour = (couleur: Couleur, valeur: Valeur): CartePosee => ({
  carte: coucou(),
  remplace: { couleur, valeur },
});

const contientJoker = (cartes: readonly CartePosee[]): boolean =>
  cartes.some((cp) => cp.carte.type !== 'normale');

export const tierce = (
  couleur: Couleur,
  entrees: readonly Entree[],
  proprietaireId: JoueurId = 'j1',
  tourDePose = 1,
): Tierce => {
  const cartes = entrees.map(poser);
  return {
    id: prochainId('comb'),
    type: 'tierce',
    proprietaireId,
    tourDePose,
    couleur,
    cartes,
    pure: !contientJoker(cartes),
  };
};

export const ensemble = (
  valeur: Valeur,
  entrees: readonly Entree[],
  proprietaireId: JoueurId = 'j1',
  tourDePose = 1,
): Ensemble => {
  const cartes = entrees.map(poser);
  return {
    id: prochainId('comb'),
    type: cartes.length === 4 ? 'carre' : 'brelan',
    proprietaireId,
    tourDePose,
    valeur,
    cartes,
    pure: !contientJoker(cartes),
  };
};

export const recap = (partiel: Partial<RecapJoueurCoup> = {}): RecapJoueurCoup => ({
  toursAvecPose: [1],
  aAjouteSurCombinaisonAutrui: false,
  ...partiel,
});

/** Un coup minimal, suffisant pour les fonctions de fin de coup. */
export const coup = (partiel: Partial<Coup> = {}): Coup => ({
  numero: 1,
  donneurId: 'j1',
  ordreJoueurs: ['j1', 'j2', 'j3'],
  joueursSurLeCote: [],
  phase: 'jeu',
  annonces: {},
  pioche: [],
  defausse: [],
  combinaisons: [],
  joueurActifId: 'j2',
  numeroTour: 1,
  estFriche: false,
  recapitulatifs: {},
  gagnantId: null,
  ...partiel,
});

export const joueur = (id: JoueurId, main: Carte[] = [], partiel: Partial<Joueur> = {}): Joueur => ({
  id,
  nom: id.toUpperCase(),
  main,
  aPose: false,
  croix: 0,
  ...partiel,
});

export const boule = (partiel: Partial<Boule> = {}): Boule => ({
  nombreCoupsTotal: 8,
  nombreCoupsFriches: 2,
  coupEnCours: null,
  historique: [],
  scoresCumules: {},
  croix: {},
  ...partiel,
});

export const combinaisonsDe = (...combinaisons: Combinaison[]): Combinaison[] => combinaisons;
