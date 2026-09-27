/**
 * Sérialisation de l'état d'une Boule.
 *
 * L'état d'une Boule est déjà un objet TypeScript cohérent : il est stocké tel
 * quel en JSON plutôt qu'éclaté en tables. Ce qui traverse la base est donc
 * relu comme une donnée extérieure, jamais comme un objet de confiance : tout
 * passe par une validation explicite.
 *
 * Ce qui se joue en ce moment — le coup en cours, l'entracte qui le suit — part
 * avec l'état, à chaque tour complet (voir `EnCoursPersiste`) : un redémarrage
 * du serveur reprend la partie au dernier tour joué, pas à une donne neuve. Seul
 * le brouillon d'un tour entamé — carte piochée, pose en composition — se perd :
 * le joueur rejoue ce tour-là.
 */
import type {
  Boule,
  Carte,
  CarteId,
  Combinaison,
  Coup,
  JoueurId,
  MatchPanier,
  ResultatCoup,
  ResultatManche,
  ScoreCoup,
  TypeVictoire,
} from '../models/index.js';

/** Version du format, pour pouvoir faire évoluer le schéma sans casser l'existant. */
export const VERSION_ETAT_BOULE = 1;

export interface EtatBoulePersiste {
  readonly version: number;
  readonly ordreTable: JoueurId[];
  readonly nombreCoupsTotal: number;
  readonly nombreCoupsFriches: number;
  /** Absent d'un état écrit avant qu'on les compte. */
  readonly frichesGeneralisees?: number;
  /** Absent d'un état écrit avant le suivi du report. */
  readonly reportDeFriches?: number;
  /** Absent d'un état écrit avant qu'on mesure le temps de jeu. */
  readonly tempsDeJeu?: Record<JoueurId, number>;
  readonly scoresCumules: Record<JoueurId, number>;
  readonly croix: Record<JoueurId, number>;
  readonly historique: ResultatCoup[];
  /** Absent d'un état écrit avant qu'on le retienne : le coup est redistribué. */
  readonly enCours?: EnCoursPersiste;
}

/** Le décompte d'un coup fini, tant que tous n'ont pas demandé la suite. */
export interface ResultatEnAttentePersiste {
  readonly numero: number;
  readonly score: ScoreCoup;
  readonly mains: Readonly<Record<JoueurId, Carte[]>>;
  readonly prets: JoueurId[];
  readonly derniereCoup: boolean;
  readonly poseFinale?: readonly CarteId[];
  readonly carteDefaussee?: Carte | null;
  readonly rejouer: JoueurId[];
  readonly rejouerAnnulePar: JoueurId | null;
  readonly matchPanier?: {
    readonly manchesGagnees: Readonly<Record<JoueurId, number>>;
    readonly manchesAGagner: number;
    readonly montant: number;
    readonly vainqueurId: JoueurId | null;
  };
}

/**
 * Ce qui se joue à la table entre deux fins de coup : le coup lui-même, le
 * décompte de l'entracte, et les jokers gardés d'une friche généralisée — ce
 * qu'il faut pour reprendre exactement là où la table en était.
 */
export interface EnCoursPersiste {
  readonly coup: Coup | null;
  readonly resultat: ResultatEnAttentePersiste | null;
  readonly jokersGardes: Record<JoueurId, Carte[]>;
}

/**
 * Une copie indépendante : le dépôt en mémoire garde l'objet tel quel, et le
 * coup vivant continue d'être modifié après l'écriture.
 */
const copierEnCours = (enCours: EnCoursPersiste): EnCoursPersiste => structuredClone(enCours);

export const serialiserBoule = (boule: Boule, enCours?: EnCoursPersiste): EtatBoulePersiste => ({
  version: VERSION_ETAT_BOULE,
  ordreTable: [...boule.ordreTable],
  nombreCoupsTotal: boule.nombreCoupsTotal,
  nombreCoupsFriches: boule.nombreCoupsFriches,
  ...(boule.frichesGeneralisees === undefined ? {} : { frichesGeneralisees: boule.frichesGeneralisees }),
  ...(boule.reportDeFriches === undefined ? {} : { reportDeFriches: boule.reportDeFriches }),
  ...(boule.tempsDeJeu === undefined ? {} : { tempsDeJeu: { ...boule.tempsDeJeu } }),
  scoresCumules: { ...boule.scoresCumules },
  croix: { ...boule.croix },
  historique: boule.historique.map((resultat) => ({ ...resultat })),
  ...(enCours === undefined ? {} : { enCours: copierEnCours(enCours) }),
});

class EtatIllisibleError extends Error {
  constructor(detail: string) {
    super(`Etat de Boule illisible : ${detail}`);
    this.name = 'EtatIllisibleError';
  }
}

const objet = (valeur: unknown, chemin: string): Record<string, unknown> => {
  if (typeof valeur !== 'object' || valeur === null || Array.isArray(valeur)) {
    throw new EtatIllisibleError(`${chemin} n'est pas un objet`);
  }
  return valeur as Record<string, unknown>;
};

const entier = (valeur: unknown, chemin: string): number => {
  if (typeof valeur !== 'number' || !Number.isFinite(valeur)) {
    throw new EtatIllisibleError(`${chemin} n'est pas un nombre`);
  }
  return valeur;
};

const texte = (valeur: unknown, chemin: string): string => {
  if (typeof valeur !== 'string') throw new EtatIllisibleError(`${chemin} n'est pas une chaine`);
  return valeur;
};

const listeDeTextes = (valeur: unknown, chemin: string): string[] => {
  if (!Array.isArray(valeur)) throw new EtatIllisibleError(`${chemin} n'est pas une liste`);
  return valeur.map((element, index) => texte(element, `${chemin}[${String(index)}]`));
};

const scores = (valeur: unknown, chemin: string): Record<JoueurId, number> => {
  const brut = objet(valeur, chemin);
  const resultat: Record<JoueurId, number> = {};
  for (const [joueurId, points] of Object.entries(brut)) {
    resultat[joueurId] = entier(points, `${chemin}.${joueurId}`);
  }
  return resultat;
};

const TYPES_VICTOIRE: readonly string[] = ['simple', 'double', 'triple'];

const resultatCoup = (valeur: unknown, chemin: string): ResultatCoup => {
  const brut = objet(valeur, chemin);
  const typeVictoire = texte(brut['typeVictoire'], `${chemin}.typeVictoire`);
  if (!TYPES_VICTOIRE.includes(typeVictoire)) {
    throw new EtatIllisibleError(`${chemin}.typeVictoire inconnu : ${typeVictoire}`);
  }
  if (typeof brut['estFriche'] !== 'boolean') {
    throw new EtatIllisibleError(`${chemin}.estFriche n'est pas un booleen`);
  }

  // L'archive d'un coup ne sert qu'à le relire : aucune règle n'en dépend.
  // Elle est reprise telle que le serveur l'a écrite, et son absence — un coup
  // enregistré avant qu'on la retienne — est tolérée.
  const combinaisons = brut['combinaisons'];
  const mainsRevelees = brut['mainsRevelees'];

  return {
    numero: entier(brut['numero'], `${chemin}.numero`),
    gagnantId: texte(brut['gagnantId'], `${chemin}.gagnantId`),
    typeVictoire: typeVictoire as TypeVictoire,
    estFriche: brut['estFriche'],
    scores: scores(brut['scores'], `${chemin}.scores`),
    croixGagnees: scores(brut['croixGagnees'], `${chemin}.croixGagnees`),
    ...(Array.isArray(combinaisons) ? { combinaisons: combinaisons as Combinaison[] } : {}),
    ...(typeof mainsRevelees === 'object' && mainsRevelees !== null && !Array.isArray(mainsRevelees)
      ? { mainsRevelees: mainsRevelees as Record<JoueurId, Carte[]> }
      : {}),
    ...(Array.isArray(brut['poseFinale'])
      ? { poseFinale: listeDeTextes(brut['poseFinale'], `${chemin}.poseFinale`) }
      : {}),
  };
};

/**
 * Relit un état venu de la base et reconstruit la Boule.
 *
 * @throws EtatIllisibleError si le JSON ne correspond pas au format attendu.
 */
export const deserialiserBoule = (valeur: unknown): Boule => {
  const brut = objet(valeur, 'etat');

  const version = entier(brut['version'], 'etat.version');
  if (version !== VERSION_ETAT_BOULE) {
    throw new EtatIllisibleError(`version ${String(version)} non prise en charge`);
  }

  const historiqueBrut = brut['historique'];
  if (!Array.isArray(historiqueBrut)) {
    throw new EtatIllisibleError("etat.historique n'est pas une liste");
  }

  return {
    ordreTable: listeDeTextes(brut['ordreTable'], 'etat.ordreTable'),
    nombreCoupsTotal: entier(brut['nombreCoupsTotal'], 'etat.nombreCoupsTotal'),
    nombreCoupsFriches: entier(brut['nombreCoupsFriches'], 'etat.nombreCoupsFriches'),
    ...(brut['frichesGeneralisees'] === undefined
      ? {}
      : { frichesGeneralisees: entier(brut['frichesGeneralisees'], 'etat.frichesGeneralisees') }),
    ...(brut['reportDeFriches'] === undefined
      ? {}
      : { reportDeFriches: entier(brut['reportDeFriches'], 'etat.reportDeFriches') }),
    ...(brut['tempsDeJeu'] === undefined ? {} : { tempsDeJeu: scores(brut['tempsDeJeu'], 'etat.tempsDeJeu') }),
    // Le coup en cours vit sur la table, pas dans la Boule : `lireEnCours`.
    coupEnCours: null,
    historique: historiqueBrut.map((resultat, index) =>
      resultatCoup(resultat, `etat.historique[${String(index)}]`),
    ),
    scoresCumules: scores(brut['scoresCumules'], 'etat.scoresCumules'),
    croix: scores(brut['croix'], 'etat.croix'),
  };
};

/**
 * Sérialisation d'un match du panier : le même principe que pour une Boule,
 * mais une forme bien plus courte — pas de coups frichés, pas de croix, pas de
 * points cumulés.
 */
export const VERSION_ETAT_PANIER = 1;

export interface EtatPanierPersiste {
  readonly version: number;
  readonly ordreTable: JoueurId[];
  readonly manchesAGagner: number;
  readonly montant: number;
  readonly manchesGagnees: Record<JoueurId, number>;
  readonly historique: ResultatManche[];
  readonly vainqueurId: JoueurId | null;
  readonly tempsDeJeu?: Record<JoueurId, number>;
  /** Comme pour une Boule : la manche en cours et son entracte. */
  readonly enCours?: EnCoursPersiste;
}

export const serialiserMatchPanier = (match: MatchPanier, enCours?: EnCoursPersiste): EtatPanierPersiste => ({
  version: VERSION_ETAT_PANIER,
  ordreTable: [...match.ordreTable],
  manchesAGagner: match.manchesAGagner,
  montant: match.montant,
  manchesGagnees: { ...match.manchesGagnees },
  historique: match.historique.map((manche) => ({ ...manche })),
  vainqueurId: match.vainqueurId,
  ...(match.tempsDeJeu === undefined ? {} : { tempsDeJeu: { ...match.tempsDeJeu } }),
  ...(enCours === undefined ? {} : { enCours: copierEnCours(enCours) }),
});

const resultatManche = (valeur: unknown, chemin: string): ResultatManche => {
  const brut = objet(valeur, chemin);
  // Comme pour l'archive d'un coup : reprise telle quelle, aucune règle n'en
  // dépend, seule la relecture en a besoin.
  const combinaisons = brut['combinaisons'];
  const mainsRevelees = brut['mainsRevelees'];
  return {
    numero: entier(brut['numero'], `${chemin}.numero`),
    gagnantId: texte(brut['gagnantId'], `${chemin}.gagnantId`),
    combinaisons: Array.isArray(combinaisons) ? (combinaisons as Combinaison[]) : [],
    mainsRevelees:
      typeof mainsRevelees === 'object' && mainsRevelees !== null && !Array.isArray(mainsRevelees)
        ? (mainsRevelees as Record<JoueurId, Carte[]>)
        : {},
  };
};

/**
 * Relit un état de match du panier venu de la base.
 *
 * @throws EtatIllisibleError si le JSON ne correspond pas au format attendu.
 */
export const deserialiserMatchPanier = (valeur: unknown): MatchPanier => {
  const brut = objet(valeur, 'etat');

  const version = entier(brut['version'], 'etat.version');
  if (version !== VERSION_ETAT_PANIER) {
    throw new EtatIllisibleError(`version panier ${String(version)} non prise en charge`);
  }

  const historiqueBrut = brut['historique'];
  if (!Array.isArray(historiqueBrut)) {
    throw new EtatIllisibleError("etat.historique n'est pas une liste");
  }

  const vainqueurId = brut['vainqueurId'];
  if (vainqueurId !== null && typeof vainqueurId !== 'string') {
    throw new EtatIllisibleError("etat.vainqueurId n'est ni une chaine ni null");
  }

  return {
    ordreTable: listeDeTextes(brut['ordreTable'], 'etat.ordreTable'),
    manchesAGagner: entier(brut['manchesAGagner'], 'etat.manchesAGagner'),
    montant: entier(brut['montant'], 'etat.montant'),
    manchesGagnees: scores(brut['manchesGagnees'], 'etat.manchesGagnees'),
    historique: historiqueBrut.map((manche, index) => resultatManche(manche, `etat.historique[${String(index)}]`)),
    vainqueurId,
    ...(brut['tempsDeJeu'] === undefined ? {} : { tempsDeJeu: scores(brut['tempsDeJeu'], 'etat.tempsDeJeu') }),
  };
};

// --- Ce qui se joue en ce moment ------------------------------------------

/*
 * Contrairement à l'archive d'un coup fini, qu'on ne fait que relire, le coup
 * rechargé redevient l'état vivant sur lequel le moteur tranche : qui joue,
 * ce que chacun tient. Chaque champ est donc vérifié, carte comprise — une
 * donnée abîmée doit être refusée ici, pas faire tomber un tour plus tard.
 * Le détail des combinaisons, lui, est repris tel quel : le moteur les a
 * validées à la pose, et les revalide à chaque ajout.
 */

const booleen = (valeur: unknown, chemin: string): boolean => {
  if (typeof valeur !== 'boolean') throw new EtatIllisibleError(`${chemin} n'est pas un booleen`);
  return valeur;
};

const texteOuNul = (valeur: unknown, chemin: string): string | null =>
  valeur === null ? null : texte(valeur, chemin);

const liste = (valeur: unknown, chemin: string): unknown[] => {
  if (!Array.isArray(valeur)) throw new EtatIllisibleError(`${chemin} n'est pas une liste`);
  return valeur;
};

const TYPES_CARTE: readonly string[] = ['normale', 'joker', 'coucou'];

const carte = (valeur: unknown, chemin: string): Carte => {
  const brut = objet(valeur, chemin);
  texte(brut['id'], `${chemin}.id`);
  const type = texte(brut['type'], `${chemin}.type`);
  if (!TYPES_CARTE.includes(type)) throw new EtatIllisibleError(`${chemin}.type inconnu : ${type}`);
  if (type === 'normale') {
    texte(brut['couleur'], `${chemin}.couleur`);
    if (typeof brut['valeur'] !== 'number' && typeof brut['valeur'] !== 'string') {
      throw new EtatIllisibleError(`${chemin}.valeur illisible`);
    }
  }
  return brut as unknown as Carte;
};

const cartes = (valeur: unknown, chemin: string): Carte[] =>
  liste(valeur, chemin).map((element, index) => carte(element, `${chemin}[${String(index)}]`));

const mainsParJoueur = (valeur: unknown, chemin: string): Record<JoueurId, Carte[]> => {
  const brut = objet(valeur, chemin);
  const resultat: Record<JoueurId, Carte[]> = {};
  for (const [joueurId, main] of Object.entries(brut)) resultat[joueurId] = cartes(main, `${chemin}.${joueurId}`);
  return resultat;
};

const PHASES: readonly string[] = ['annonces', 'jeu', 'termine'];
const ANNONCES: readonly string[] = ['friche', 'je-joue'];

const coup = (valeur: unknown, chemin: string): Coup => {
  const brut = objet(valeur, chemin);
  const phase = texte(brut['phase'], `${chemin}.phase`);
  if (!PHASES.includes(phase)) throw new EtatIllisibleError(`${chemin}.phase inconnue : ${phase}`);

  const annonces = objet(brut['annonces'], `${chemin}.annonces`);
  for (const [joueurId, annonce] of Object.entries(annonces)) {
    if (!ANNONCES.includes(texte(annonce, `${chemin}.annonces.${joueurId}`))) {
      throw new EtatIllisibleError(`${chemin}.annonces.${joueurId} inconnue`);
    }
  }

  const ordreJoueurs = listeDeTextes(brut['ordreJoueurs'], `${chemin}.ordreJoueurs`);
  const mains = mainsParJoueur(brut['mains'], `${chemin}.mains`);
  // Chaque joueur assis a une main : sans elle, le premier tour tomberait.
  for (const joueurId of ordreJoueurs) {
    if (mains[joueurId] === undefined) throw new EtatIllisibleError(`${chemin}.mains.${joueurId} absente`);
  }

  const recapitulatifs = objet(brut['recapitulatifs'], `${chemin}.recapitulatifs`);
  for (const [joueurId, recap] of Object.entries(recapitulatifs)) {
    const r = objet(recap, `${chemin}.recapitulatifs.${joueurId}`);
    liste(r['toursAvecPose'], `${chemin}.recapitulatifs.${joueurId}.toursAvecPose`).forEach((tour, index) =>
      entier(tour, `${chemin}.recapitulatifs.${joueurId}.toursAvecPose[${String(index)}]`),
    );
    booleen(r['aAjouteSurCombinaisonAutrui'], `${chemin}.recapitulatifs.${joueurId}.aAjouteSurCombinaisonAutrui`);
  }

  const joueurActifId = texte(brut['joueurActifId'], `${chemin}.joueurActifId`);
  if (!ordreJoueurs.includes(joueurActifId)) {
    throw new EtatIllisibleError(`${chemin}.joueurActifId n'est pas assis`);
  }

  return {
    numero: entier(brut['numero'], `${chemin}.numero`),
    donneurId: texte(brut['donneurId'], `${chemin}.donneurId`),
    ordreJoueurs,
    joueursSurLeCote: listeDeTextes(brut['joueursSurLeCote'], `${chemin}.joueursSurLeCote`),
    phase: phase as Coup['phase'],
    annonces: annonces as Coup['annonces'],
    mains,
    pioche: cartes(brut['pioche'], `${chemin}.pioche`),
    defausse: cartes(brut['defausse'], `${chemin}.defausse`),
    combinaisons: liste(brut['combinaisons'], `${chemin}.combinaisons`) as Combinaison[],
    joueurActifId,
    numeroTour: entier(brut['numeroTour'], `${chemin}.numeroTour`),
    estFriche: booleen(brut['estFriche'], `${chemin}.estFriche`),
    recapitulatifs: recapitulatifs as Coup['recapitulatifs'],
    gagnantId: texteOuNul(brut['gagnantId'], `${chemin}.gagnantId`),
    ...(brut['aParler'] === undefined ? {} : { aParler: texteOuNul(brut['aParler'], `${chemin}.aParler`) }),
    ...(brut['enAttente'] === undefined
      ? {}
      : { enAttente: listeDeTextes(brut['enAttente'], `${chemin}.enAttente`) }),
    ...(brut['variante'] === undefined
      ? {}
      : { variante: texte(brut['variante'], `${chemin}.variante`) as NonNullable<Coup['variante']> }),
    ...(brut['engageId'] === undefined ? {} : { engageId: texteOuNul(brut['engageId'], `${chemin}.engageId`) }),
  };
};

const resultatEnAttente = (valeur: unknown, chemin: string): ResultatEnAttentePersiste => {
  const brut = objet(valeur, chemin);
  // Le score est celui que le moteur a calculé et déjà cumulé dans la Boule :
  // l'entracte ne fait que le montrer.
  objet(brut['score'], `${chemin}.score`);
  return {
    numero: entier(brut['numero'], `${chemin}.numero`),
    score: brut['score'] as ScoreCoup,
    mains: mainsParJoueur(brut['mains'], `${chemin}.mains`),
    prets: listeDeTextes(brut['prets'], `${chemin}.prets`),
    derniereCoup: booleen(brut['derniereCoup'], `${chemin}.derniereCoup`),
    ...(brut['poseFinale'] === undefined
      ? {}
      : { poseFinale: listeDeTextes(brut['poseFinale'], `${chemin}.poseFinale`) }),
    ...(brut['carteDefaussee'] === undefined
      ? {}
      : { carteDefaussee: brut['carteDefaussee'] === null ? null : carte(brut['carteDefaussee'], `${chemin}.carteDefaussee`) }),
    rejouer: listeDeTextes(brut['rejouer'], `${chemin}.rejouer`),
    rejouerAnnulePar: texteOuNul(brut['rejouerAnnulePar'], `${chemin}.rejouerAnnulePar`),
    ...(brut['matchPanier'] === undefined
      ? {}
      : { matchPanier: objet(brut['matchPanier'], `${chemin}.matchPanier`) as unknown as NonNullable<ResultatEnAttentePersiste['matchPanier']> }),
  };
};

/**
 * Relit, dans l'état d'une Boule ou d'un match, ce qui se jouait à la table.
 * `null` pour un état écrit avant qu'on le retienne : le coup sera redistribué.
 *
 * @throws EtatIllisibleError si ce qui est écrit ne correspond pas au format.
 */
export const lireEnCours = (valeur: unknown): EnCoursPersiste | null => {
  const brut = objet(valeur, 'etat');
  if (brut['enCours'] === undefined) return null;
  const enCours = objet(brut['enCours'], 'etat.enCours');
  return {
    coup: enCours['coup'] === null ? null : coup(enCours['coup'], 'etat.enCours.coup'),
    resultat: enCours['resultat'] === null ? null : resultatEnAttente(enCours['resultat'], 'etat.enCours.resultat'),
    jokersGardes: mainsParJoueur(enCours['jokersGardes'], 'etat.enCours.jokersGardes'),
  };
};

export { EtatIllisibleError };
