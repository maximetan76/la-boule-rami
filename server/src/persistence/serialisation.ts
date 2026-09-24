/**
 * Sérialisation de l'état d'une Boule.
 *
 * L'état d'une Boule est déjà un objet TypeScript cohérent : il est stocké tel
 * quel en JSON plutôt qu'éclaté en tables. Ce qui traverse la base est donc
 * relu comme une donnée extérieure, jamais comme un objet de confiance : tout
 * passe par une validation explicite.
 *
 * Le coup en cours n'est délibérément pas persisté : la sauvegarde a lieu en
 * fin de coup, et un redémarrage refait la donne du coup entamé. C'est ce que
 * signifie « ne jamais perdre plus d'un coup en cours ».
 */
import type {
  Boule,
  Carte,
  Combinaison,
  JoueurId,
  MatchPanier,
  ResultatCoup,
  ResultatManche,
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
}

export const serialiserBoule = (boule: Boule): EtatBoulePersiste => ({
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
    // Le coup en cours n'est pas persisté : il sera redistribué au redémarrage.
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
}

export const serialiserMatchPanier = (match: MatchPanier): EtatPanierPersiste => ({
  version: VERSION_ETAT_PANIER,
  ordreTable: [...match.ordreTable],
  manchesAGagner: match.manchesAGagner,
  montant: match.montant,
  manchesGagnees: { ...match.manchesGagnees },
  historique: match.historique.map((manche) => ({ ...manche })),
  vainqueurId: match.vainqueurId,
  ...(match.tempsDeJeu === undefined ? {} : { tempsDeJeu: { ...match.tempsDeJeu } }),
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

export { EtatIllisibleError };
