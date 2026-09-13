/**
 * Filtrage de l'état de jeu, par joueur.
 *
 * C'est la seule porte de sortie de l'état vers un client : tout ce qui n'est
 * pas explicitement recopié ici reste au serveur. Rien ne doit contourner cette
 * fonction, sous peine de fuiter une information cachée.
 *
 * Ce qu'un joueur a le droit de voir :
 * - sa propre main, en clair ;
 * - des autres joueurs, seulement le nombre de cartes qu'ils tiennent ;
 * - du talon de pioche, rien du tout : ni contenu, ni nombre de cartes ;
 * - de la défausse, la dernière carte (la seule piochable, § « Règle spéciale :
 *   piocher la carte de la défausse ») et l'ensemble des cartes déjà sorties,
 *   sans ordre ni attribution ;
 * - toutes les combinaisons posées, qui sont face visible par définition.
 */
import type {
  Annonce,
  Boule,
  Carte,
  Combinaison,
  Coup,
  JoueurId,
  PhaseCoup,
} from '../models/index.js';

/** Ce qu'un joueur voit de la main d'un autre : son volume, rien de plus. */
export interface MainAdversaire {
  readonly joueurId: JoueurId;
  readonly nombreCartes: number;
  /** Le joueur a déjà posé son jeu ce coup-ci. */
  readonly aPose: boolean;
  readonly connecte: boolean;
}

export interface DefausseVisible {
  /** Dernière carte défaussée : la seule que l'on puisse prendre. */
  readonly derniereCarte: Carte | null;
  /**
   * Toutes les cartes sorties depuis le début du coup, dans un ordre canonique
   * indépendant de l'ordre de défausse, et sans indication de qui les a jetées.
   * Permet le comptage stratégique sans révéler le jeu de personne.
   */
  readonly cartesSorties: Carte[];
}

/** Le tour en cours d'un joueur, tant qu'il n'est pas validé par le moteur. */
export interface TourEnAttente {
  readonly joueurId: JoueurId;
  readonly source: 'pioche' | 'defausse';
  readonly cartePiochee: Carte;
  readonly poses: readonly Combinaison[];
  readonly ajouts: readonly { readonly combinaisonId: string }[];
}

/**
 * Le décompte d'un coup terminé, tel que chacun le voit pendant l'entracte.
 *
 * C'est le seul moment où les mains des autres joueurs sont montrées : le coup
 * est fini, plus rien n'en dépend, et c'est ce qui permet de vérifier le
 * décompte. Réf. docs/REGLES.md § « Fin d'un coup et scoring ».
 */
export interface ResultatCoupFiltre {
  readonly numero: number;
  readonly gagnantId: JoueurId;
  readonly typeVictoire: string;
  readonly estFriche: boolean;
  readonly multiplicateur: number;
  /** Ce que ce coup a rapporté ou coûté à chacun. */
  readonly scores: Readonly<Record<JoueurId, number>>;
  readonly croixGagnees: Readonly<Record<JoueurId, number>>;
  /** Cartes restées en main, révélées pour ce seul entracte. */
  readonly mainsRevelees: Readonly<Record<JoueurId, Carte[]>>;
  /** Joueurs ayant demandé la suite. */
  readonly prets: JoueurId[];
  /** La Boule s'arrête après ce coup. */
  readonly derniereCoup: boolean;
}

/**
 * Ce que les échanges de joker du tour changent pour celui qui les fait — et
 * pour lui seul : la vraie carte est sur la table, le joker est à part.
 */
export interface VueEchanges {
  readonly combinaisons: Combinaison[];
  readonly main: Carte[];
  readonly jokers: Carte[];
  /** La carte piochée a servi à un échange : elle est sur la table. */
  readonly carteConsommee: boolean;
}

export interface EtatCoupFiltre {
  readonly tableId: string;
  readonly moi: {
    readonly joueurId: JoueurId;
    readonly main: Carte[];
    readonly aPose: boolean;
    /** Carte piochée ce tour-ci, pas encore engagée dans une action validée. */
    readonly carteEnAttente: Carte | null;
    /**
     * D'où vient cette carte. Seul son propriétaire le voit — c'est déjà lui
     * qui l'a prise — et cela décide de ce qu'il peut en faire : une prise en
     * défausse se rend, une carte du talon a été vue et ne se rend pas.
     */
    readonly sourceCarteEnAttente: 'pioche' | 'defausse' | null;
    /**
     * Jokers repris ce tour-ci et pas encore replacés. Ils ne sont pas dans
     * `main` : ils se tiennent à part, comme la carte piochée.
     */
    readonly jokersRecuperes: Carte[];
  };
  readonly adversaires: MainAdversaire[];
  readonly coup: {
    readonly numero: number;
    readonly donneurId: JoueurId;
    readonly ordreJoueurs: JoueurId[];
    readonly joueursSurLeCote: JoueurId[];
    readonly phase: PhaseCoup;
    readonly annonces: Record<JoueurId, Annonce>;
    readonly joueurActifId: JoueurId;
    readonly numeroTour: number;
    readonly estFriche: boolean;
    readonly gagnantId: JoueurId | null;
  };
  readonly defausse: DefausseVisible;
  readonly combinaisons: Combinaison[];
  /** Renseigné entre deux coups, `null` pendant le jeu. */
  readonly resultat: ResultatCoupFiltre | null;
  readonly boule: {
    readonly nombreCoupsTotal: number;
    readonly nombreCoupsFriches: number;
    readonly coupsJoues: number;
    readonly scoresCumules: Record<JoueurId, number>;
    readonly croix: Record<JoueurId, number>;
  };
}

const aPose = (coup: Coup, joueurId: JoueurId): boolean =>
  (coup.recapitulatifs[joueurId]?.toursAvecPose.length ?? 0) > 0;

/**
 * Ordre canonique des cartes sorties : il ne dépend que de l'ensemble des
 * cartes, jamais de l'ordre dans lequel elles ont été défaussées. Deux parties
 * ayant défaussé les mêmes cartes dans des ordres différents produisent la même
 * liste.
 */
const parIdentifiant = (a: Carte, b: Carte): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Réduit l'état complet d'un coup à ce que `joueurId` a le droit de voir.
 *
 * @param connectes joueurs actuellement connectés à la table.
 * @param tourEnAttente tour entamé mais pas encore validé par le moteur. Seul
 * son propriétaire en voit la carte piochée.
 */
export const filtrerEtatPourJoueur = (
  coup: Coup,
  boule: Boule,
  joueurId: JoueurId,
  options: {
    readonly tableId?: string;
    readonly connectes?: readonly JoueurId[];
    readonly tourEnAttente?: TourEnAttente | null;
    readonly resultat?: ResultatCoupFiltre | null;
    readonly echangesDuTour?: VueEchanges | null;
  } = {},
): EtatCoupFiltre => {
  const {
    tableId = '',
    connectes = [],
    tourEnAttente = null,
    resultat = null,
    echangesDuTour = null,
  } = options;

  const tousLesJoueurs = [...coup.ordreJoueurs, ...coup.joueursSurLeCote];
  const adversaires = tousLesJoueurs
    .filter((autre) => autre !== joueurId)
    .map((autre) => ({
      joueurId: autre,
      // Le volume de la main, jamais son contenu.
      nombreCartes: (coup.mains[autre] ?? []).length,
      aPose: aPose(coup, autre),
      connecte: connectes.includes(autre),
    }));

  const monTour = tourEnAttente !== null && tourEnAttente.joueurId === joueurId;
  // Les échanges de joker ne regardent que celui qui les fait : les autres
  // voient la table telle qu'elle était, jusqu'à la défausse.
  const echanges = monTour ? echangesDuTour : null;
  const consommee = echanges?.carteConsommee ?? false;
  const carteEnAttente = monTour && !consommee ? (tourEnAttente?.cartePiochee ?? null) : null;
  const sourceCarteEnAttente = monTour && !consommee ? (tourEnAttente?.source ?? null) : null;

  return {
    tableId,
    moi: {
      joueurId,
      main: echanges ? [...echanges.main] : [...(coup.mains[joueurId] ?? [])],
      aPose: aPose(coup, joueurId),
      carteEnAttente,
      sourceCarteEnAttente,
      jokersRecuperes: echanges ? [...echanges.jokers] : [],
    },
    adversaires,
    coup: {
      numero: coup.numero,
      donneurId: coup.donneurId,
      ordreJoueurs: [...coup.ordreJoueurs],
      joueursSurLeCote: [...coup.joueursSurLeCote],
      phase: coup.phase,
      annonces: { ...coup.annonces },
      joueurActifId: coup.joueurActifId,
      numeroTour: coup.numeroTour,
      estFriche: coup.estFriche,
      gagnantId: coup.gagnantId,
    },
    defausse: {
      derniereCarte: coup.defausse.at(-1) ?? null,
      cartesSorties: [...coup.defausse].sort(parIdentifiant),
    },
    // Les combinaisons sont face visible sur la table : tout le monde les voit.
    combinaisons: echanges ? [...echanges.combinaisons] : [...coup.combinaisons],
    // Les mains des autres ne sortent que par ici, et seulement entre deux
    // coups : c'est la seule porte, et elle ne s'ouvre qu'une fois le coup joué.
    resultat,
    boule: {
      nombreCoupsTotal: boule.nombreCoupsTotal,
      nombreCoupsFriches: boule.nombreCoupsFriches,
      coupsJoues: boule.historique.length,
      scoresCumules: { ...boule.scoresCumules },
      croix: { ...boule.croix },
    },
    // Le talon n'apparaît nulle part : ni son contenu, ni sa taille.
  };
};
