/**
 * Gestion en mémoire des tables de jeu, adossée à un dépôt.
 *
 * Une table naît en salon : son créateur l'ouvre, un code d'invitation court
 * circule, et les places se remplissent une par une. Quand la dernière est
 * prise, le tirage d'ouverture a lieu et la partie commence.
 *
 * L'état de jeu vit en mémoire — c'est lui qui répond à chaque action — et part
 * en base à chaque tour complet : une annonce, une défausse, une donne, un
 * geste de l'entracte. Un redémarrage reprend donc chaque partie au dernier tour
 * joué ; seul le brouillon d'un tour entamé se perd, et son joueur le rejoue.
 *
 * L'identité vient du jeton de session applicatif (voir `src/auth`) : c'est lui
 * qui désigne le joueur, et non un jeton propre à la table. C'est ce qui permet
 * de retrouver sa place après un redémarrage du serveur.
 */
import type { Chronometre } from './temps-de-jeu.js';
import type { NiveauOrdinateur } from '../bots/index.js';
import {
  COUPS_FRICHES_PAR_DEFAUT,
  COUPS_PAR_NOMBRE_DE_JOUEURS,
  NOMBRE_COUPS_MAX,
  NOMBRE_COUPS_MIN,
} from '../models/index.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  Boule,
  Carte,
  CarteId,
  Coup,
  Joueur,
  JoueurId,
  MatchPanier,
  ScoreCoup,
  Variante,
} from '../models/index.js';
import {
  MANCHES_A_GAGNER_MAX,
  MANCHES_A_GAGNER_MIN,
  MONTANT_MAX,
  MONTANT_MIN,
} from '../models/index.js';
import {
  composerManche,
  construirePaquet,
  determinerJoueursAssis,
  distribuerAvecCartesConservees,
  distribuerCartes,
  distribuerLePanier,
  estCoupFriche,
  initialiserBoule,
  initialiserMatchPanier,
  melangerPaquet,
  numeroCoupCourant,
  numeroMancheCourant,
  redistribuerApresFricheGeneralisee,
  avecDernierTour,
  tirerSiegesEtDonneurInitial,
} from '../game-engine/index.js';
import { estJoker } from '../game-engine/cartes.js';
import type {
  AbandonEnregistre,
  DelaisDeJeu,
  Depot,
  GestionDeconnexion,
  JoueurEnregistre,
} from '../persistence/depot.js';
import { DELAI_DECONNEXION_PAR_DEFAUT_MS, DELAIS_ILLIMITES } from '../persistence/depot.js';
import {
  deserialiserBoule,
  deserialiserMatchPanier,
  lireEnCours,
  serialiserBoule,
  serialiserMatchPanier,
  type EnCoursPersiste,
} from '../persistence/serialisation.js';
import type { TourEnAttente } from './etat-filtre.js';

export type TableId = string;

export type { DelaisDeJeu, GestionDeconnexion };
export { DELAI_DECONNEXION_PAR_DEFAUT_MS };

/** Horloge, injectable pour que les tests n'attendent pas 90 secondes. */
export interface Minuteur {
  /** Programme `callback` et renvoie de quoi l'annuler. */
  programmer(callback: () => void, delaiMs: number): () => void;
}

export const minuteurSysteme: Minuteur = {
  programmer(callback, delaiMs) {
    const identifiant = setTimeout(callback, delaiMs);
    // Un minuteur en attente ne doit pas retenir le processus.
    identifiant.unref?.();
    return () => {
      clearTimeout(identifiant);
    };
  },
};

/**
 * Alphabet du code d'invitation : ni 0/O ni 1/I/L, pour qu'un code se dicte
 * sans ambiguïté.
 */
export const ALPHABET_CODE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LONGUEUR_CODE = 6;

/** Nombres de joueurs pour lesquels les règles donnent un nombre de coups. */
export const CAPACITE_MIN = 2;
export const CAPACITE_MAX = 6;

export type StatutTable = 'salon' | 'en-cours' | 'terminee';

/** Tour entamé par un joueur, tant que le moteur ne l'a pas validé. */
/**
 * Un joker repris pendant le tour, pas encore replacé.
 *
 * L'échange vit dans le brouillon du tour, comme les poses : le joueur le voit
 * aussitôt, les autres ne le voient qu'à la défausse. C'est ce qui permet de
 * l'annuler sans que personne en ait rien vu.
 */
export interface EchangeJokerEnAttente {
  readonly combinaisonId: string;
  readonly carteJokerId: string;
  readonly carteReelleId: string;
}

export interface TourEnCours extends TourEnAttente {
  readonly joueurId: JoueurId;
  readonly source: 'pioche' | 'defausse';
  readonly cartePiochee: Carte;
  poses: import('../models/index.js').Combinaison[];
  ajouts: { combinaisonId: string; cartes: import('../models/index.js').CartePosee[] }[];
  echangesJoker: EchangeJokerEnAttente[];
}

/**
 * L'entracte entre deux coups.
 *
 * Le coup terminé ne cède la place au suivant que lorsque tous les joueurs
 * l'ont demandé : sans cette pause, la donne suivante effaçait le décompte
 * avant que personne ait pu le lire.
 */
export interface ResultatCoupEnAttente {
  readonly numero: number;
  readonly score: ScoreCoup;
  /** Cartes restées en main, révélées le temps de l'entracte seulement. */
  readonly mains: Readonly<Record<JoueurId, Carte[]>>;
  /** Joueurs ayant demandé la suite. */
  prets: JoueurId[];
  /** La Boule s'arrête après ce coup. */
  readonly derniereCoup: boolean;
  /**
   * Les cartes que le gagnant a engagées à son dernier tour — poses, ajouts,
   * vraie carte donnée contre un joker —, pour montrer comment il a fini.
   */
  readonly poseFinale?: readonly CarteId[];
  /** La carte jetée par le gagnant pour finir, s'il en a jeté une. */
  readonly carteDefaussee?: Carte | null;
  /** Dernier coup : les joueurs qui veulent rejouer une Boule avec ce groupe. */
  rejouer: JoueurId[];
  /** Dernier coup : qui a choisi de terminer — plus de nouvelle Boule pour personne. */
  rejouerAnnulePar: JoueurId | null;
  /**
   * Panier seulement : où en est le match après cette manche. `score` reste
   * présent, vide et honnête — voir `scoreDeMancheVide` dans handlers.ts.
   */
  readonly matchPanier?: {
    readonly manchesGagnees: Readonly<Record<JoueurId, number>>;
    readonly manchesAGagner: number;
    readonly montant: number;
    readonly vainqueurId: JoueurId | null;
  };
}

/** Le délai de jeu qui court pour le joueur attendu. */
export interface AttenteDeJeu {
  /** Ce qu'on attend : même coup, même phase, même joueur, même moment. */
  readonly cle: string;
  annuler: () => void;
  /** Le joueur a signalé qu'il compose une pose. */
  composition: boolean;
  /** La prolongation a déjà été accordée pour cette attente. */
  prolongee: boolean;
  /** Ce qui court : le délai d'annonce, celui du tour, ou la prolongation. */
  nature: 'annonce' | 'jeu' | 'prolongation';
  /** Échéance, en millisecondes depuis l'époque ; `null` : prolongation illimitée. */
  finLe: number | null;
  /** Durée totale du délai qui court ; `null` : prolongation illimitée. */
  dureeMs: number | null;
}

export interface Table {
  readonly id: TableId;
  readonly codeInvitation: string;
  readonly createurId: JoueurId;
  readonly capacite: number;
  statut: StatutTable;
  /** Ouverture du salon : l'âge d'un salon jamais démarré se compte d'ici. */
  readonly creeeLe: Date;
  /** Démarrage de la partie, `null` en salon : l'inactivité d'une partie se compte d'ici. */
  demarreeLe: Date | null;
  /** Joueurs assis. En salon, dans l'ordre d'arrivée ; ensuite, celui du tirage. */
  joueurs: Joueur[];
  /**
   * Le jeu joué à cette table. Réf. docs/REGLES.md § « Le panier ». Absente
   * d'une table antérieure à la variante : c'est alors La Boule.
   */
  readonly variante: Variante;
  /** `null` tant que la partie n'a pas démarré, ou pour une table du panier. */
  boule: Boule | null;
  /** `null` hors du panier, ou tant que la partie n'a pas démarré. */
  panier: MatchPanier | null;
  /** Panier seulement : manches à gagner et montant empoché par le vainqueur. */
  readonly manchesAGagner: number;
  readonly montant: number;
  /** La force des joueurs que le serveur joue lui-même. Voir `bots/`. */
  readonly niveauOrdinateur: NiveauOrdinateur;
  coup: Coup | null;
  tourEnCours: TourEnCours | null;
  /** Socket courante de chaque joueur, `null` s'il est déconnecté. */
  readonly connexions: Map<JoueurId, string | null>;
  readonly alea: () => number;
  readonly gestionDeconnexion: GestionDeconnexion;
  /** Délais de jeu : ils valent pour tous, présents ou non. */
  readonly delais: DelaisDeJeu;
  /**
   * Coups frichés choisis à la création, avant toute friche généralisée.
   * Réf. docs/REGLES.md § « Structure d'une Boule ».
   */
  readonly coupsFrichesDepart: number;
  /**
   * Coups frichés configurés par le créateur, transmis tels quels d'une Boule
   * rejouée à la suivante : la base du report en cascade.
   */
  readonly coupsFrichesConfigures: number;
  /**
   * Report reçu de la Boule précédente au-delà du nombre de coups de celle-ci :
   * gardé pour la Boule suivante si le groupe rejoue.
   */
  readonly excedentDeFriches: number;
  /**
   * Nombre de coups de la Boule choisi à la création, de 1 à 12 ; `null` :
   * celui des règles pour ce nombre de joueurs.
   */
  readonly nombreCoups: number | null;
  /**
   * Valeur monétaire d'un point, en décimal (« 0.20 ») ; `null` : aucune.
   * Sert à convertir les écarts de fin de Boule, rien d'autre.
   */
  readonly valeurPoint: string | null;
  /** Le délai qui court pour le joueur attendu, s'il y en a un. */
  attenteDeJeu: AttenteDeJeu | null;
  /** Qui la table attend, et depuis quand : le temps de jeu en découle. */
  chronometre?: Chronometre | null;
  /** Annulation du minuteur d'abandon de tour en cours, s'il y en a un. */
  annulerMinuteur: (() => void) | null;
  /** Joueur dont le tour expirera si le minuteur va au bout. */
  joueurEnSursis: JoueurId | null;
  /** Jokers tirés à l'ouverture, conservés pour la donne du premier coup. */
  cartesConserveesParJoueur: Map<JoueurId, Carte[]>;
  /** Décompte du coup qui vient de finir, tant que tous n'ont pas dit « suite ». */
  resultatCoup: ResultatCoupEnAttente | null;
  /**
   * Le tirage d'ouverture de la Boule, pour que chacun le voie se jouer.
   * `null` avant le démarrage, et pour une partie relue après un redémarrage.
   */
  tirageOuverture: ReturnType<typeof tirerSiegesEtDonneurInitial> | null;
  /** Les places de l'étalage où chaque joueur a retourné ses cartes du tirage. */
  retournementsTirage: Map<JoueurId, number[]>;
  /**
   * Ceux qui ont appuyé sur « Passer » : le serveur retourne leurs cartes du
   * tirage à leur place, retirages compris, dès que c'est à eux.
   */
  passeursDuTirage: Set<JoueurId>;
  /**
   * Jokers que chaque joueur a gardés en main lors d'une friche généralisée,
   * pour qu'il les reconnaisse à la reprise. Vidé à chaque nouvelle donne.
   */
  jokersGardes: Map<JoueurId, Carte[]>;
  /**
   * Joueurs tenus par le serveur, qui jouent tout seuls. Une table de
   * démonstration en compte deux ; une table ordinaire, aucun.
   */
  readonly bots: Set<JoueurId>;
  /** Le geste qu'un joueur automatique s'apprête à faire, s'il y en a un. */
  actionBot: { readonly cle: string; annuler: () => void } | null;
  /** La table de la Boule rejouée avec ce groupe, une fois qu'elle existe. */
  relanceeVers?: TableId;
}

export interface TableCreee {
  readonly tableId: TableId;
  readonly codeInvitation: string;
  readonly capacite: number;
}

/**
 * Le nom sous lequel un joueur s'assoit à une table.
 *
 * Qui n'a pas encore choisi son pseudo s'affiche « Joueur N », N étant son
 * rang d'arrivée à la table : deux joueurs sans pseudo ne se confondent
 * jamais, et personne ne s'affiche sous un identifiant technique. Dès qu'il
 * en choisit un, `renommerDansLesTables` le remplace.
 */
export const nomALaTable = (
  joueur: { readonly pseudo: string; readonly pseudoChoisi?: boolean },
  rang: number,
): string => (joueur.pseudoChoisi === false ? `Joueur ${String(rang)}` : joueur.pseudo);

/**
 * Une action arrive sur une connexion qui n'a rejoint aucune table : une
 * connexion neuve après une coupure, un retour de veille ou un redémarrage du
 * serveur. Le code stable dit à l'app de rejoindre sa table et de rejouer
 * l'action, sans rien montrer au joueur.
 */
export class ErreurNonRattachee extends Error {
  readonly code = 'non-rattachee';

  constructor() {
    super('Socket non rattachee a une table');
  }
}

/** Une table telle que la décrivent l'API et l'annonce d'une nouvelle table. */
export const decrireTablePublique = (table: Table) => ({
  tableId: table.id,
  codeInvitation: table.codeInvitation,
  capacite: table.capacite,
  statut: table.statut,
  createurId: table.createurId,
  joueurs: table.joueurs.map((joueur) => ({ joueurId: joueur.id, pseudo: joueur.nom })),
  delais: table.delais,
  coupsFrichesDepart: table.coupsFrichesDepart,
  coupsFrichesConfigures: table.coupsFrichesConfigures,
  excedentDeFriches: table.excedentDeFriches,
  nombreCoups: table.nombreCoups,
  valeurPoint: table.valeurPoint,
  // Réf. § « Le panier » : le jeu joué, et pour le panier ses deux réglages.
  variante: table.variante,
  manchesAGagner: table.variante === 'panier' ? table.manchesAGagner : null,
  montant: table.variante === 'panier' ? table.montant : null,
  // Contre l'ordinateur seulement : sa force.
  niveauOrdinateur: table.bots.size > 0 ? table.niveauOrdinateur : null,
});

/** La Boule d'une table dont la partie a démarré. */
export const bouleEnCours = (table: Table): Boule => {
  if (table.boule === null) throw new Error("La partie n'a pas encore demarre");
  return table.boule;
};

/** Le match du panier d'une table dont la partie a démarré. */
export const panierEnCours = (table: Table): MatchPanier => {
  if (table.panier === null) throw new Error("La partie n'a pas encore demarre");
  return table.panier;
};

/**
 * L'état d'une table à l'instant d'un abandon, pour l'archive.
 *
 * Tout y est révélé, mains comprises — la carte piochée du joueur actif avec :
 * la partie est finie, plus rien n'en dépend, et c'est ce qui permet d'y
 * revenir. Entre deux coups, il n'y a pas de coup interrompu : le dernier est
 * déjà dans l'historique.
 */
const photographierAbandon = (table: Table, parJoueurId: JoueurId): AbandonEnregistre => {
  const boule = table.boule;
  const coup = table.resultatCoup === null ? table.coup : null;

  const mains: Record<JoueurId, Carte[]> = {};
  for (const [joueurId, cartes] of Object.entries(coup?.mains ?? {})) mains[joueurId] = [...cartes];
  const tour = table.tourEnCours;
  if (coup !== null && tour !== null) {
    mains[tour.joueurId] = [...(mains[tour.joueurId] ?? []), tour.cartePiochee];
  }

  return {
    parJoueurId,
    le: new Date(),
    coupInterrompu: {
      numero: coup?.numero ?? null,
      coupsJoues: boule?.historique.length ?? table.panier?.historique.length ?? 0,
      nombreCoupsTotal: boule?.nombreCoupsTotal ?? 0,
      nombreCoupsFriches: boule?.nombreCoupsFriches ?? 0,
      scoresCumules: { ...(boule?.scoresCumules ?? {}) },
      croix: { ...(boule?.croix ?? {}) },
      mains,
      combinaisons: [...(coup?.combinaisons ?? [])],
    },
  };
};

/**
 * Au-delà de ce délai, une table où rien ne s'est joué est supprimée : un salon
 * jamais démarré depuis sa création, une partie sans action de jeu depuis son
 * démarrage. Voir `nettoyerTablesInactives`.
 */
export const DELAI_INACTIVITE_MS = 3 * 60 * 60 * 1000;

/**
 * Rien ne s'est joué : aucun coup terminé, aucune friche généralisée, et dans
 * le premier coup personne n'a encore pioché ni défaussé. Les annonces seules
 * ne comptent pas.
 */
const sansActionDeJeu = (table: Table): boolean => {
  const boule = table.boule;
  if (boule !== null && (boule.historique.length > 0 || (boule.frichesGeneralisees ?? 0) > 0)) return false;
  // Un match du panier déjà entamé — une manche terminée — n'est pas inactif.
  if (table.panier !== null && table.panier.historique.length > 0) return false;
  if (table.tourEnCours !== null || table.resultatCoup !== null) return false;
  return table.coup === null || table.coup.defausse.length === 0;
};

const estInactive = (table: Table, maintenant: Date): boolean => {
  const age = (depuis: Date): number => maintenant.getTime() - depuis.getTime();
  if (table.statut === 'salon') return age(table.creeeLe) > DELAI_INACTIVITE_MS;
  if (table.statut !== 'en-cours' || !sansActionDeJeu(table)) return false;
  return age(table.demarreeLe ?? table.creeeLe) > DELAI_INACTIVITE_MS;
};

/**
 * Ce qu'une écriture a vu de la table : tant que rien de cela ne change, il n'y
 * a rien de neuf à écrire. Les références suffisent — le moteur rend un coup
 * neuf à chaque tour, et l'entracte remplace ses listes plutôt que les muter.
 */
interface Empreinte {
  readonly coup: Coup | null;
  readonly resultat: ResultatCoupEnAttente | null;
  readonly prets: readonly JoueurId[] | null;
  readonly rejouer: readonly JoueurId[] | null;
  readonly rejouerAnnulePar: JoueurId | null;
  readonly jokersGardes: Map<JoueurId, Carte[]>;
}

const empreinteDe = (table: Table): Empreinte => ({
  coup: table.coup,
  resultat: table.resultatCoup,
  prets: table.resultatCoup?.prets ?? null,
  rejouer: table.resultatCoup?.rejouer ?? null,
  rejouerAnnulePar: table.resultatCoup?.rejouerAnnulePar ?? null,
  jokersGardes: table.jokersGardes,
});

const memeEmpreinte = (a: Empreinte, b: Empreinte): boolean =>
  a.coup === b.coup &&
  a.resultat === b.resultat &&
  a.prets === b.prets &&
  a.rejouer === b.rejouer &&
  a.rejouerAnnulePar === b.rejouerAnnulePar &&
  a.jokersGardes === b.jokersGardes;

const enCoursDe = (table: Table): EnCoursPersiste => ({
  coup: table.coup,
  resultat: table.resultatCoup,
  jokersGardes: Object.fromEntries(table.jokersGardes),
});

/**
 * Ce qui se jouait à une table rechargée, s'il se relit et s'il concerne bien
 * les joueurs assis. Sinon `null` : le coup sera redistribué, comme avant qu'on
 * le retienne — mieux qu'une partie qui refuse de se recharger.
 */
const relireEnCours = (
  partieId: string,
  etat: unknown,
  assis: readonly Joueur[],
): EnCoursPersiste | null => {
  if (etat === null || etat === undefined) return null;
  try {
    const enCours = lireEnCours(etat);
    const ids = new Set(assis.map((joueur) => joueur.id));
    const coup = enCours?.coup ?? null;
    if (coup !== null && ![...coup.ordreJoueurs, ...coup.joueursSurLeCote].every((id) => ids.has(id))) {
      console.error(`Partie ${partieId} : coup en cours sans rapport avec les joueurs assis, il sera redistribue`);
      return null;
    }
    return enCours;
  } catch (erreur) {
    console.error(`Partie ${partieId} : coup en cours illisible, il sera redistribue`, erreur);
    return null;
  }
};

export class GameRoomManager {
  private readonly tables = new Map<TableId, Table>();
  private readonly parCode = new Map<string, TableId>();
  private readonly sockets = new Map<string, { tableId: TableId; joueurId: JoueurId }>();
  /** La dernière écriture de chaque table, pour les enchaîner dans l'ordre. */
  private readonly ecritures = new Map<TableId, Promise<void>>();
  /** Tables dont une écriture attend son tour : elle lira l'état le plus récent. */
  private readonly ecrituresEnFile = new Set<TableId>();
  /** Ce que la dernière écriture de chaque table a vu. */
  private readonly empreintes = new WeakMap<Table, Empreinte>();
  /** Tables relues au démarrage qu'aucun joueur n'a encore rejointes. */
  private readonly tablesFroides = new Set<TableId>();
  private readonly rafraichissements = new Map<TableId, Promise<void>>();

  readonly minuteur: Minuteur;
  private readonly depot: Depot | null;

  constructor(options: { readonly minuteur?: Minuteur; readonly depot?: Depot } = {}) {
    this.minuteur = options.minuteur ?? minuteurSysteme;
    this.depot = options.depot ?? null;
  }

  private tirerCode(): string {
    const octets = randomBytes(LONGUEUR_CODE);
    let code = '';
    for (const octet of octets) code += ALPHABET_CODE[octet % ALPHABET_CODE.length];
    return code;
  }

  /** Un code libre, vérifié contre les tables vivantes et contre la base. */
  private async codeUnique(): Promise<string> {
    for (let essai = 0; essai < 20; essai += 1) {
      const code = this.tirerCode();
      if (this.parCode.has(code)) continue;
      if ((await this.depot?.trouverPartieParCode(code)) != null) continue;
      return code;
    }
    throw new Error("Impossible de tirer un code d'invitation libre");
  }

  /** Ouvre un salon, son créateur assis à la première place. */
  async creerTable(
    createur: JoueurEnregistre | { id: JoueurId; pseudo: string },
    options: {
      readonly capacite?: number;
      readonly gestionDeconnexion?: GestionDeconnexion;
      /** Sans précision, aucun délai : les valeurs par défaut sont celles de l'API. */
      readonly delais?: DelaisDeJeu;
      /** Coups frichés de départ ; 2 sans précision. */
      readonly coupsFrichesDepart?: number;
      /** Base du report en cascade ; les coups frichés de départ sans précision. */
      readonly coupsFrichesConfigures?: number;
      /** Report reçu au-delà du nombre de coups ; aucun sans précision. */
      readonly excedentDeFriches?: number;
      /** Nombre de coups de la Boule ; celui des règles sans précision. */
      readonly nombreCoups?: number | null;
      /** Valeur d'un point, décimal normalisé ; aucune sans précision. */
      readonly valeurPoint?: string | null;
      /** Joueurs que le serveur joue lui-même : la table de démonstration. */
      readonly bots?: readonly JoueurId[];
      /** Leur force ; « facile » sans précision. */
      readonly niveauOrdinateur?: NiveauOrdinateur;
      readonly alea?: () => number;
      /** Le jeu joué à cette table ; sans précision, La Boule. */
      readonly variante?: Variante;
      /** Panier seulement : nombre de manches à gagner pour empocher le montant. */
      readonly manchesAGagner?: number;
      /** Panier seulement : ce que le vainqueur empoche. */
      readonly montant?: number;
    } = {},
  ): Promise<TableCreee> {
    const variante = options.variante ?? 'boule';
    const capacite = options.capacite ?? (variante === 'panier' ? 2 : 4);
    if (!Number.isInteger(capacite) || capacite < CAPACITE_MIN || capacite > CAPACITE_MAX) {
      throw new Error(
        `Nombre de joueurs hors limites : ${String(capacite)} (attendu ${String(CAPACITE_MIN)} a ${String(CAPACITE_MAX)})`,
      );
    }
    if (variante === 'panier' && capacite !== 2) {
      throw new Error(`Le panier se joue a deux : ${String(capacite)} demandes`);
    }
    const manchesAGagner = options.manchesAGagner ?? 3;
    const montant = options.montant ?? 10;
    if (variante === 'panier') {
      if (
        !Number.isInteger(manchesAGagner) ||
        manchesAGagner < MANCHES_A_GAGNER_MIN ||
        manchesAGagner > MANCHES_A_GAGNER_MAX
      ) {
        throw new Error(
          `Nombre de manches a gagner hors limites : ${String(manchesAGagner)} (attendu ${String(MANCHES_A_GAGNER_MIN)} a ${String(MANCHES_A_GAGNER_MAX)})`,
        );
      }
      if (!Number.isFinite(montant) || montant < MONTANT_MIN || montant > MONTANT_MAX) {
        throw new Error(
          `Montant hors limites : ${String(montant)} (attendu ${String(MONTANT_MIN)} a ${String(MONTANT_MAX)})`,
        );
      }
    }
    const nombreCoups = options.nombreCoups ?? null;
    if (
      nombreCoups !== null &&
      (!Number.isInteger(nombreCoups) || nombreCoups < NOMBRE_COUPS_MIN || nombreCoups > NOMBRE_COUPS_MAX)
    ) {
      throw new Error(
        `Nombre de coups hors limites : ${String(nombreCoups)} (attendu ${String(NOMBRE_COUPS_MIN)} a ${String(NOMBRE_COUPS_MAX)})`,
      );
    }
    const coupsFrichesDepart = options.coupsFrichesDepart ?? COUPS_FRICHES_PAR_DEFAUT;
    // Les coups frichés se bornent au nombre de coups de CETTE Boule : choisi,
    // ou celui des règles.
    const coupsDeLaBoule = nombreCoups ?? COUPS_PAR_NOMBRE_DE_JOUEURS[capacite] ?? 0;
    if (!Number.isInteger(coupsFrichesDepart) || coupsFrichesDepart < 0 || coupsFrichesDepart > coupsDeLaBoule) {
      throw new Error(
        `Nombre de coups friches hors limites : ${String(coupsFrichesDepart)} (attendu 0 a ${String(coupsDeLaBoule)})`,
      );
    }

    const coupsFrichesConfigures = options.coupsFrichesConfigures ?? coupsFrichesDepart;
    const excedentDeFriches = options.excedentDeFriches ?? 0;
    if (!Number.isInteger(excedentDeFriches) || excedentDeFriches < 0) {
      throw new Error(`Report de coups friches invalide : ${String(excedentDeFriches)}`);
    }

    const tableId = randomUUID();
    const codeInvitation = await this.codeUnique();
    const delais = options.delais ?? DELAIS_ILLIMITES;
    const gestionDeconnexion = options.gestionDeconnexion ?? {
      type: 'delai',
      dureeMs: DELAI_DECONNEXION_PAR_DEFAUT_MS,
    };

    const table: Table = {
      id: tableId,
      codeInvitation,
      createurId: createur.id,
      capacite,
      statut: 'salon',
      creeeLe: new Date(),
      demarreeLe: null,
      joueurs: [{ id: createur.id, nom: nomALaTable(createur, 1), croix: 0 }],
      variante,
      boule: null,
      panier: null,
      manchesAGagner,
      montant,
      niveauOrdinateur: options.niveauOrdinateur ?? 'facile',
      coup: null,
      tourEnCours: null,
      connexions: new Map([[createur.id, null]]),
      alea: options.alea ?? Math.random,
      gestionDeconnexion,
      delais,
      coupsFrichesDepart,
      coupsFrichesConfigures,
      excedentDeFriches,
      nombreCoups,
      valeurPoint: options.valeurPoint ?? null,
      attenteDeJeu: null,
      annulerMinuteur: null,
      joueurEnSursis: null,
      cartesConserveesParJoueur: new Map(),
      resultatCoup: null,
      tirageOuverture: null,
      retournementsTirage: new Map(),
      passeursDuTirage: new Set(),
      jokersGardes: new Map(),
      bots: new Set(options.bots ?? []),
      actionBot: null,
    };
    this.tables.set(tableId, table);
    this.parCode.set(codeInvitation, tableId);

    await this.depot?.creerPartie({
      id: tableId,
      codeInvitation,
      createurId: createur.id,
      capacite,
      gestionDeconnexion,
      delais,
      coupsFrichesDepart,
      coupsFrichesConfigures,
      excedentDeFriches,
      nombreCoups,
      valeurPoint: options.valeurPoint ?? null,
      variante,
      ...(variante === 'panier' ? { manchesAGagner, montant } : {}),
      robots: [...(options.bots ?? [])],
      ...(options.bots !== undefined && options.bots.length > 0
        ? { niveauOrdinateur: options.niveauOrdinateur ?? 'facile' }
        : {}),
    });
    await this.depot?.asseoirJoueur(tableId, createur.id, 0);

    return { tableId, codeInvitation, capacite };
  }

  /**
   * Assied un joueur sur une place libre, à partir du code d'invitation.
   * La partie démarre d'elle-même dès que la dernière place est prise.
   */
  async rejoindreParCode(
    code: string,
    joueur: JoueurEnregistre | { id: JoueurId; pseudo: string },
  ): Promise<Table> {
    const tableId = this.parCode.get(code.trim().toUpperCase());
    const table = tableId === undefined ? undefined : this.tables.get(tableId);
    if (table === undefined) throw new Error("Code d'invitation inconnu");

    if (table.statut !== 'salon') throw new Error('La partie a deja commence');
    if (table.connexions.has(joueur.id)) throw new Error('Vous etes deja a cette table');
    if (table.joueurs.length >= table.capacite) throw new Error('La table est complete');

    const position = table.joueurs.length;
    table.joueurs = [...table.joueurs, { id: joueur.id, nom: nomALaTable(joueur, position + 1), croix: 0 }];
    table.connexions.set(joueur.id, null);
    await this.depot?.asseoirJoueur(table.id, joueur.id, position);

    if (table.joueurs.length === table.capacite) await this.demarrerPartie(table);
    return table;
  }

  /** Tirage d'ouverture, sièges, Boule : la table quitte le salon. */
  async demarrerPartie(table: Table): Promise<void> {
    const tirage = tirerSiegesEtDonneurInitial(
      table.joueurs,
      melangerPaquet(construirePaquet(table.variante), table.alea),
    );
    table.joueurs = tirage.ordreTable.map(
      (joueurId) => table.joueurs.find((joueur) => joueur.id === joueurId) as Joueur,
    );
    if (table.variante === 'panier') {
      // Réf. § « Le panier » : le joker est offert d'office à chaque manche,
      // jamais tiré au sort. Le tirage d'ouverture ne sert ici qu'à désigner
      // qui distribue en premier (§ « Qui commence »).
      table.panier = initialiserMatchPanier(table.joueurs, table.manchesAGagner, table.montant);
    } else {
      table.boule = initialiserBoule(
        table.joueurs,
        table.coupsFrichesDepart,
        table.nombreCoups ?? undefined,
        table.excedentDeFriches,
      );
      table.cartesConserveesParJoueur = tirage.cartesConserveesParJoueur;
    }
    table.tirageOuverture = tirage;
    table.statut = 'en-cours';
    table.demarreeLe = new Date();

    await this.depot?.demarrerPartie(table.id, tirage.ordreTable);
  }

  /**
   * Abandon définitif d'une partie interrompue. La table est close et ses
   * joueurs redeviennent libres d'en rejoindre ou d'en créer une autre.
   *
   * Les sockets encore rattachées sont rendues à l'appelant : c'est à lui de
   * les prévenir, avant qu'elles ne soient détachées ici.
   */
  async abandonner(
    tableId: TableId,
    /** Qui l'a décidé ; absent quand un salon se vide de lui-même. */
    parJoueurId?: JoueurId,
  ): Promise<{ table: Table; socketsPrevenues: string[] }> {
    const table = this.table(tableId);
    // Photographiée avant que la table ne se vide : c'est l'archive de l'abandon.
    const abandon = parJoueurId === undefined ? undefined : photographierAbandon(table, parJoueurId);
    const socketsPrevenues = [...table.connexions.values()].filter(
      (socketId): socketId is string => socketId !== null,
    );
    table.annulerMinuteur?.();
    table.annulerMinuteur = null;
    table.joueurEnSursis = null;
    table.attenteDeJeu?.annuler();
    table.attenteDeJeu = null;
    table.statut = 'terminee';
    table.coup = null;
    table.tourEnCours = null;

    for (const [joueurId, socketId] of table.connexions) {
      if (socketId !== null) this.sockets.delete(socketId);
      table.connexions.set(joueurId, null);
    }
    this.parCode.delete(table.codeInvitation);
    this.tables.delete(tableId);

    // Le motif est ce qui permettra de dire à un joueur absent, à son retour,
    // que sa partie a été abandonnée plutôt qu'achevée.
    await this.persister(table);
    await this.depot?.terminerPartie(tableId, 'abandon', abandon);
    return { table, socketsPrevenues };
  }

  /**
   * Un joueur libère sa place dans un salon qui n'a pas encore démarré.
   *
   * Le salon continue d'exister pour les autres, la place redevient libre, et
   * le partant n'est plus engagé nulle part. Si personne ne reste, le salon est
   * clos : une table sans joueur n'a plus de raison d'être.
   */
  async quitterSalon(tableId: TableId, joueurId: JoueurId): Promise<Table> {
    const table = this.table(tableId);

    if (table.statut !== 'salon') {
      throw new Error(
        table.statut === 'en-cours'
          ? "La partie a commence : c'est un abandon, pas un depart de salon"
          : 'La partie est terminee',
      );
    }
    if (!table.connexions.has(joueurId)) throw new Error("Vous n'etes pas a cette table");

    const socketId = table.connexions.get(joueurId) ?? null;
    if (socketId !== null) this.sockets.delete(socketId);
    table.connexions.delete(joueurId);
    table.joueurs = table.joueurs.filter((joueur) => joueur.id !== joueurId);

    await this.depot?.retirerJoueur(
      tableId,
      joueurId,
      table.joueurs.map((joueur) => joueur.id),
    );

    if (table.joueurs.length === 0) {
      await this.abandonner(tableId);
    }
    return table;
  }

  /**
   * Supprime pour de bon les tables où rien ne s'est joué depuis plus de trois
   * heures.
   *
   * Deux cas, et seulement ceux-là : un salon jamais démarré, ouvert depuis plus
   * de trois heures ; une partie démarrée où aucune action de jeu n'a eu lieu
   * depuis son démarrage (voir `sansActionDeJeu`). Une table où un coup s'est
   * joué n'est jamais concernée, quel que soit son âge. Rien n'est archivé :
   * la partie disparaît de la base, places et Boule comprises.
   *
   * Les sockets encore rattachées sont rendues à l'appelant, qui les prévient.
   */
  async nettoyerTablesInactives(
    maintenant: Date = new Date(),
  ): Promise<{ readonly tableId: TableId; readonly socketsPrevenues: string[] }[]> {
    const supprimees: { tableId: TableId; socketsPrevenues: string[] }[] = [];

    for (const table of [...this.tables.values()]) {
      if (!estInactive(table, maintenant)) continue;

      const socketsPrevenues = [...table.connexions.values()].filter(
        (socketId): socketId is string => socketId !== null,
      );
      table.annulerMinuteur?.();
      table.annulerMinuteur = null;
      table.attenteDeJeu?.annuler();
      table.attenteDeJeu = null;
      table.statut = 'terminee';
      for (const socketId of socketsPrevenues) this.sockets.delete(socketId);
      this.parCode.delete(table.codeInvitation);
      this.tables.delete(table.id);

      await this.depot?.supprimerPartie(table.id);
      supprimees.push({ tableId: table.id, socketsPrevenues });
    }
    return supprimees;
  }

  /** Les tables vivantes où le joueur a une place : salons et parties en cours. */
  tablesDuJoueur(joueurId: JoueurId): Table[] {
    return [...this.tables.values()].filter((table) => table.connexions.has(joueurId));
  }

  /** Le compte a-t-il été supprimé ? Sans dépôt, aucun ne l'est. */
  async compteSupprime(joueurId: JoueurId): Promise<boolean> {
    const joueur = (await this.depot?.trouverJoueur(joueurId)) ?? null;
    return joueur !== null && (joueur.supprimeLe ?? null) !== null;
  }

  /** Répercute un changement de pseudo sur les tables où le joueur est assis. */
  renommerDansLesTables(joueurId: JoueurId, pseudo: string): void {
    for (const table of this.tables.values()) {
      table.joueurs = table.joueurs.map((joueur) =>
        joueur.id === joueurId ? { ...joueur, nom: pseudo } : joueur,
      );
    }
  }

  /**
   * Recharge les parties non terminées depuis le dépôt.
   *
   * Le coup en cours reprend au dernier tour joué, entracte compris. Seul un
   * état écrit avant qu'on le retienne, ou illisible, fait redistribuer le
   * coup dès que la table est de nouveau au complet.
   */
  async recharger(options: { readonly alea?: () => number } = {}): Promise<TableId[]> {
    if (this.depot === null) return [];

    const actives = await this.depot.chargerPartiesActives();
    const rechargees: TableId[] = [];

    for (const { partie, joueurs, etatBoule, etatPanier } of actives) {
      if (joueurs.length === 0) continue;

      const assis: Joueur[] = joueurs.map((joueur, rang) => ({
        id: joueur.id,
        nom: nomALaTable(joueur, rang + 1),
        croix: 0,
      }));
      const variante = partie.variante ?? 'boule';
      const enCours = partie.demarree
        ? relireEnCours(partie.id, variante === 'panier' ? etatPanier : etatBoule, assis)
        : null;

      const table: Table = {
        id: partie.id,
        codeInvitation: partie.codeInvitation,
        createurId: partie.createurId,
        capacite: partie.capacite,
        statut: partie.demarree ? 'en-cours' : 'salon',
        creeeLe: partie.creeeLe,
        demarreeLe: partie.demarree ? (partie.demarreeLe ?? partie.creeeLe) : null,
        joueurs: assis,
        variante,
        boule:
          variante === 'panier'
            ? null
            : etatBoule === null
              ? partie.demarree
                ? initialiserBoule(
                    assis,
                    partie.coupsFrichesDepart,
                    partie.nombreCoups ?? undefined,
                    partie.excedentDeFriches ?? 0,
                  )
                : null
              : deserialiserBoule(etatBoule),
        panier:
          variante !== 'panier'
            ? null
            : etatPanier === null
              ? partie.demarree
                ? initialiserMatchPanier(assis, partie.manchesAGagner ?? 3, partie.montant ?? 10)
                : null
              : deserialiserMatchPanier(etatPanier),
        manchesAGagner: partie.manchesAGagner ?? 3,
        montant: partie.montant ?? 10,
        niveauOrdinateur: partie.niveauOrdinateur ?? 'facile',
        // Le dernier tour joué ; le brouillon d'un tour entamé, lui, est perdu :
        // son joueur le rejoue.
        coup: enCours?.coup ?? null,
        tourEnCours: null,
        connexions: new Map(assis.map((joueur) => [joueur.id, null])),
        alea: options.alea ?? Math.random,
        // La configuration de déconnexion est relue avec la partie : une table
        // ne repart pas sur la valeur par défaut après un redémarrage.
        gestionDeconnexion: partie.gestionDeconnexion,
        delais: partie.delais,
        coupsFrichesDepart: partie.coupsFrichesDepart,
        coupsFrichesConfigures: partie.coupsFrichesConfigures ?? partie.coupsFrichesDepart,
        excedentDeFriches: partie.excedentDeFriches ?? 0,
        nombreCoups: partie.nombreCoups,
        valeurPoint: partie.valeurPoint,
        attenteDeJeu: null,
        annulerMinuteur: null,
        joueurEnSursis: null,
        // Les jokers du tirage d'ouverture appartiennent au premier coup, déjà
        // joué si la Boule a un historique.
        cartesConserveesParJoueur: new Map(),
      resultatCoup:
        enCours?.resultat == null
          ? null
          : { ...enCours.resultat, prets: [...enCours.resultat.prets], rejouer: [...enCours.resultat.rejouer] },
      tirageOuverture: null,
      retournementsTirage: new Map(),
      passeursDuTirage: new Set(),
      jokersGardes: new Map(Object.entries(enCours?.jokersGardes ?? {})),
      // Les joueurs que le serveur joue lui-même reprennent leur place : une
      // partie contre l'ordinateur continue après un redémarrage.
      bots: new Set(partie.robots ?? []),
      actionBot: null,
      };

      // Ce qui vient d'être relu est déjà en base : rien à réécrire tant que la
      // partie n'avance pas.
      this.empreintes.set(table, empreinteDe(table));
      if (partie.demarree) this.tablesFroides.add(table.id);
      this.tables.set(table.id, table);
      this.parCode.set(table.codeInvitation, table.id);
      rechargees.push(partie.id);
    }

    return rechargees;
  }

  /**
   * Écrit l'état de la table : la Boule ou le match, et ce qui s'y joue en ce
   * moment — le coup en cours, l'entracte.
   *
   * Les écritures d'une même table passent l'une après l'autre : lancées
   * ensemble, elles pourraient arriver en base dans le désordre, la plus
   * ancienne écrasant la plus récente. Une écriture qui attend encore son tour
   * lit l'état au moment où elle part : une nouvelle demande pendant ce temps
   * n'ajoute rien, elle la rejoint.
   */
  persister(table: Table): Promise<void> {
    if (this.depot === null) return Promise.resolve();
    const enFile = this.ecritures.get(table.id);
    if (enFile !== undefined && this.ecrituresEnFile.has(table.id)) return enFile;

    this.ecrituresEnFile.add(table.id);
    const suite = (enFile ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        this.ecrituresEnFile.delete(table.id);
        this.empreintes.set(table, empreinteDe(table));
        await this.ecrireMaintenant(table);
      });
    this.ecritures.set(table.id, suite);
    const oublier = (): void => {
      if (this.ecritures.get(table.id) === suite) this.ecritures.delete(table.id);
    };
    suite.then(oublier, oublier);
    return suite;
  }

  /** Sérialise tout de suite — avant la moindre attente — puis écrit. */
  private async ecrireMaintenant(table: Table): Promise<void> {
    if (table.panier !== null) {
      await this.depot?.enregistrerMatchPanier(table.id, serialiserMatchPanier(table.panier, enCoursDe(table)));
      return;
    }
    if (table.boule === null) return;
    await this.depot?.enregistrerBoule(table.id, serialiserBoule(table.boule, enCoursDe(table)));
  }

  /**
   * Appelé à chaque publication de la table : n'écrit que si la partie a
   * avancé — une donne, une annonce, un tour joué jusqu'à la défausse, un
   * geste de l'entracte. Piocher ou composer une pose ne touche que le
   * brouillon du tour : rien à écrire.
   *
   * L'écriture part sans retenir la réponse : une base lente ne ralentit pas
   * la table. Au redémarrage, `attendreLesEcritures` laisse finir celles en vol.
   */
  sauvegarderSiNecessaire(table: Table): void {
    if (this.depot === null || table.statut !== 'en-cours') return;
    if (table.boule === null && table.panier === null) return;

    const actuelle = empreinteDe(table);
    const derniere = this.empreintes.get(table);
    if (derniere === undefined && table.coup === null && table.resultatCoup === null) {
      // Le tirage d'ouverture : rien ne se joue encore, rien à reprendre.
      this.empreintes.set(table, actuelle);
      return;
    }
    if (derniere !== undefined && memeEmpreinte(derniere, actuelle)) return;

    this.persister(table).catch((erreur: unknown) => {
      console.error(`Table ${table.id} : ecriture de l'etat impossible`, erreur);
    });
  }

  /**
   * Relit en base une table rechargée au démarrage, à l'arrivée de son premier
   * joueur.
   *
   * Pendant un redéploiement, l'ancien serveur continue de faire jouer ses
   * tables après que le nouveau a lu la base : sans cette relecture, la partie
   * reculerait des tours joués entre-temps. L'ancien serveur écrit tout ce qui
   * est en vol avant de couper ses connexions (voir `attendreLesEcritures`) :
   * quand un joueur arrive ici, la base est à jour.
   */
  rafraichirSiFroide(tableId: TableId): Promise<void> {
    const enCours = this.rafraichissements.get(tableId);
    if (enCours !== undefined) return enCours;
    if (!this.tablesFroides.has(tableId) || this.depot === null) return Promise.resolve();
    this.tablesFroides.delete(tableId);

    const depot = this.depot;
    const relecture = (async () => {
      const table = this.tables.get(tableId);
      const relue = await depot.chargerArchive(tableId);
      if (table === undefined || relue === null) return;
      if (relue.partie.termineeLe !== null) {
        // Close par l'ancien serveur : elle ne se sert plus d'ici.
        this.tables.delete(tableId);
        this.parCode.delete(table.codeInvitation);
        return;
      }
      if (table.variante === 'panier') {
        if (relue.etatPanier !== null) table.panier = deserialiserMatchPanier(relue.etatPanier);
      } else if (relue.etatBoule !== null) {
        table.boule = deserialiserBoule(relue.etatBoule);
      }
      const enCoursRelu = relireEnCours(
        tableId,
        table.variante === 'panier' ? relue.etatPanier : relue.etatBoule,
        table.joueurs,
      );
      table.coup = enCoursRelu?.coup ?? null;
      table.tourEnCours = null;
      table.resultatCoup =
        enCoursRelu?.resultat == null
          ? null
          : { ...enCoursRelu.resultat, prets: [...enCoursRelu.resultat.prets], rejouer: [...enCoursRelu.resultat.rejouer] };
      table.jokersGardes = new Map(Object.entries(enCoursRelu?.jokersGardes ?? {}));
      this.empreintes.set(table, empreinteDe(table));
    })().finally(() => {
      this.rafraichissements.delete(tableId);
    });
    this.rafraichissements.set(tableId, relecture);
    return relecture;
  }

  /** Laisse finir les écritures en vol : avant d'arrêter le serveur. */
  async attendreLesEcritures(): Promise<void> {
    while (this.ecritures.size > 0) await Promise.allSettled([...this.ecritures.values()]);
  }

  async cloreLaPartie(table: Table): Promise<void> {
    table.attenteDeJeu?.annuler();
    table.attenteDeJeu = null;
    table.statut = 'terminee';
    // Le code cesse d'être valide : mieux vaut « code inconnu » que « partie
    // déjà commencée » pour qui tenterait de rejoindre une table achevée.
    this.parCode.delete(table.codeInvitation);
    await this.depot?.terminerPartie(table.id, 'achevee');
  }

  /** Table vivante où ce joueur a une place, s'il y en a une. */
  tableDuJoueur(joueurId: JoueurId): Table | null {
    for (const table of this.tables.values()) {
      if (table.statut !== 'terminee' && table.connexions.has(joueurId)) return table;
    }
    return null;
  }

  table(tableId: TableId): Table {
    const table = this.tables.get(tableId);
    if (table === undefined) throw new Error(`Table ${tableId} introuvable`);
    return table;
  }

  tableParCode(code: string): Table | null {
    const tableId = this.parCode.get(code.trim().toUpperCase());
    return tableId === undefined ? null : (this.tables.get(tableId) ?? null);
  }

  /** Rattache une socket à la place d'un joueur, une fois son identité vérifiée. */
  attacherSocket(tableId: TableId, joueurId: JoueurId, socketId: string): Table {
    const table = this.table(tableId);
    if (!table.connexions.has(joueurId)) {
      throw new Error(`${joueurId} n'a pas de place a cette table`);
    }

    // Un joueur peut être assis à plusieurs tables, mais une connexion n'en
    // suit qu'une : rattachée ailleurs, elle quitte la précédente, qui ne doit
    // plus lui envoyer son état. Il y redevient absent jusqu'à ce qu'une
    // connexion l'y rattache.
    const precedente = this.sockets.get(socketId);
    if (precedente !== undefined && precedente.tableId !== tableId) {
      const quittee = this.tables.get(precedente.tableId);
      if (quittee?.connexions.get(precedente.joueurId) === socketId) {
        quittee.connexions.set(precedente.joueurId, null);
      }
    }

    // Une reconnexion remplace la socket précédente sans toucher au jeu, et
    // désamorce l'abandon automatique de son tour s'il était en sursis.
    if (table.joueurEnSursis === joueurId) {
      table.annulerMinuteur?.();
      table.annulerMinuteur = null;
      table.joueurEnSursis = null;
    }
    table.connexions.set(joueurId, socketId);
    this.sockets.set(socketId, { tableId, joueurId });
    return table;
  }

  detacherSocket(socketId: string): { table: Table; joueurId: JoueurId } | null {
    const place = this.sockets.get(socketId);
    if (place === undefined) return null;
    this.sockets.delete(socketId);

    const table = this.tables.get(place.tableId);
    if (table === undefined) return null;
    // La place reste occupée : le jeu du joueur l'attend.
    if (table.connexions.get(place.joueurId) === socketId) {
      table.connexions.set(place.joueurId, null);
    }
    return { table, joueurId: place.joueurId };
  }

  /** La table en mémoire, si elle y vit encore : une partie abandonnée n'y est plus. */
  tableVivante(tableId: TableId): Table | null {
    return this.tables.get(tableId) ?? null;
  }

  /** La table que suit cette connexion, s'il y en a une. */
  tableDeLaSocket(socketId: string): Table | null {
    const place = this.sockets.get(socketId);
    return place === undefined ? null : (this.tables.get(place.tableId) ?? null);
  }

  placeDeLaSocket(socketId: string): { table: Table; joueurId: JoueurId } {
    const place = this.sockets.get(socketId);
    if (place === undefined) throw new ErreurNonRattachee();
    return { table: this.table(place.tableId), joueurId: place.joueurId };
  }

  joueursConnectes(table: Table): JoueurId[] {
    return [...table.connexions.entries()]
      .filter(([, socketId]) => socketId !== null)
      .map(([joueurId]) => joueurId);
  }

  /**
   * Ceux qui sont à la table, tels que les autres les voient : les joueurs
   * connectés, et ceux que le serveur joue lui-même — jamais absents.
   */
  joueursPresents(table: Table): JoueurId[] {
    return [...new Set([...this.joueursConnectes(table), ...table.bots])];
  }

  socketDe(table: Table, joueurId: JoueurId): string | null {
    return table.connexions.get(joueurId) ?? null;
  }

  /**
   * Tout le monde est là ? Les joueurs automatiques comptent comme présents :
   * ils n'ont pas de connexion, et la table ne les attend jamais.
   */
  tousConnectes(table: Table): boolean {
    return this.joueursConnectes(table).length + table.bots.size === table.joueurs.length;
  }
}

/** Distribue un nouveau coup et ouvre la phase des annonces. */
const recapitulatifsVides = (joueursActifs: readonly JoueurId[]): Coup['recapitulatifs'] => {
  const recapitulatifs: Coup['recapitulatifs'] = {};
  for (const id of joueursActifs) {
    recapitulatifs[id] = { toursAvecPose: [], aAjouteSurCombinaisonAutrui: false };
  }
  return recapitulatifs;
};

/** Distribue le premier coup du panier : § « Le panier », composerManche. */
const demarrerManchePanier = (table: Table): Coup => {
  const match = panierEnCours(table);
  const numero = numeroMancheCourant(match);
  const { joueursActifs, donneurId } = composerManche(match, numero);

  const actifs = table.joueurs.filter((joueur) => joueursActifs.includes(joueur.id));
  const ordonnes = joueursActifs.map((id) => actifs.find((joueur) => joueur.id === id) as Joueur);
  const paquet = melangerPaquet(construirePaquet('panier'), table.alea);
  const { mains, pioche } = distribuerLePanier(ordonnes, paquet);

  const coup: Coup = {
    variante: 'panier',
    numero,
    donneurId,
    ordreJoueurs: joueursActifs,
    joueursSurLeCote: [],
    phase: 'annonces',
    annonces: {},
    mains,
    pioche,
    defausse: [],
    combinaisons: [],
    joueurActifId: joueursActifs[0] as JoueurId,
    numeroTour: 1,
    // Au panier, aucun coup ne compte double : pas de coups frichés.
    estFriche: false,
    recapitulatifs: recapitulatifsVides(joueursActifs),
    gagnantId: null,
    aParler: joueursActifs[0] as JoueurId,
    enAttente: [],
    engageId: null,
  };

  table.coup = coup;
  table.tourEnCours = null;
  table.jokersGardes = new Map();
  return coup;
};

export const demarrerCoup = (table: Table): Coup => {
  if (table.variante === 'panier') return demarrerManchePanier(table);

  const boule = bouleEnCours(table);
  const numero = numeroCoupCourant(boule);
  const { joueursActifs, joueursAssis, donneurId } = determinerJoueursAssis(boule, numero);

  const actifs = table.joueurs.filter((joueur) => joueursActifs.includes(joueur.id));
  // `distribuerCartes` sert dans l'ordre reçu : on suit l'ordre de jeu.
  const ordonnes = joueursActifs.map(
    (id) => actifs.find((joueur) => joueur.id === id) as Joueur,
  );

  // Au tout premier coup, les jokers tirés à l'ouverture restent en main : on
  // ne sert que le complément, comme après une friche généralisée.
  const conservees: Record<JoueurId, Carte[]> = {};
  let aConserve = false;
  for (const joueurId of joueursActifs) {
    const cartes = numero === 1 ? (table.cartesConserveesParJoueur.get(joueurId) ?? []) : [];
    conservees[joueurId] = cartes;
    if (cartes.length > 0) aConserve = true;
  }

  const idsConserves = new Set(Object.values(conservees).flat().map((carte) => carte.id));
  const paquet = melangerPaquet(
    construirePaquet().filter((carte) => !idsConserves.has(carte.id)),
    table.alea,
  );

  const { mains, pioche } = aConserve
    ? distribuerAvecCartesConservees(conservees, paquet)
    : distribuerCartes(ordonnes, paquet);

  const coup: Coup = {
    numero,
    donneurId,
    ordreJoueurs: joueursActifs,
    joueursSurLeCote: joueursAssis,
    phase: 'annonces',
    annonces: {},
    mains,
    pioche,
    defausse: [],
    combinaisons: [],
    joueurActifId: joueursActifs[0] as JoueurId,
    numeroTour: 1,
    estFriche: estCoupFriche(boule, numero),
    recapitulatifs: recapitulatifsVides(joueursActifs),
    gagnantId: null,
    // La parole commence à la gauche du donneur, comme le jeu.
    aParler: joueursActifs[0] as JoueurId,
    enAttente: [],
    engageId: null,
  };

  table.coup = coup;
  table.tourEnCours = null;
  table.jokersGardes = new Map();
  return coup;
};

/**
 * Redistribue après une friche généralisée.
 *
 * § « Les joueurs qui avaient déjà des jokers en main les conservent, et
 * reçoivent une distribution ajustée pour revenir à 14 cartes. » Le donneur et
 * la composition de la table ne changent pas : le coup est rejoué à sa place.
 */
/**
 * Redistribue une manche du panier : contrairement à La Boule, aucun joker
 * n'est conservé — chacun en reçoit un nouveau, offert d'office, exactement
 * comme au premier coup (§ « Le panier »).
 */
const redistribuerManchePanier = (table: Table): Coup => {
  const coup = table.coup;
  if (coup === null) throw new Error('Aucune manche a redistribuer');

  const paquet = melangerPaquet(construirePaquet('panier'), table.alea);
  const joueurs = coup.ordreJoueurs.map(
    (id) => table.joueurs.find((joueur) => joueur.id === id) as Joueur,
  );
  const { mains, pioche } = distribuerLePanier(joueurs, paquet);

  const rejoue: Coup = {
    // Une autre donne : ce que disait le dernier tour ne vaut plus.
    ...avecDernierTour(coup, undefined),
    phase: 'annonces',
    annonces: {},
    mains,
    pioche,
    defausse: [],
    combinaisons: [],
    joueurActifId: coup.ordreJoueurs[0] as JoueurId,
    numeroTour: 1,
    estFriche: false,
    recapitulatifs: recapitulatifsVides(coup.ordreJoueurs),
    gagnantId: null,
    aParler: coup.ordreJoueurs[0] as JoueurId,
    enAttente: [],
    engageId: null,
  };

  table.jokersGardes = new Map();
  table.coup = rejoue;
  table.tourEnCours = null;
  return rejoue;
};

export const redistribuerCoup = (table: Table): Coup => {
  if (table.variante === 'panier') return redistribuerManchePanier(table);

  const coup = table.coup;
  if (coup === null) throw new Error('Aucun coup a redistribuer');
  const boule = bouleEnCours(table);

  const jokersConserves: Record<JoueurId, Carte[]> = {};
  const aRedistribuer: Carte[] = [...coup.pioche, ...coup.defausse];

  for (const joueurId of coup.ordreJoueurs) {
    const main = coup.mains[joueurId] ?? [];
    jokersConserves[joueurId] = main.filter(estJoker);
    aRedistribuer.push(...main.filter((carte) => !estJoker(carte)));
  }

  const { mains, pioche } = redistribuerApresFricheGeneralisee(
    jokersConserves,
    melangerPaquet(aRedistribuer, table.alea),
  );

  const rejoue: Coup = {
    // Une autre donne : ce que disait le dernier tour ne vaut plus.
    ...avecDernierTour(coup, undefined),
    // Le numéro de coup et le donneur sont inchangés : même place, même donneur.
    phase: 'annonces',
    annonces: {},
    mains,
    pioche,
    defausse: [],
    combinaisons: [],
    joueurActifId: coup.ordreJoueurs[0] as JoueurId,
    numeroTour: 1,
    estFriche: estCoupFriche(boule, coup.numero),
    recapitulatifs: recapitulatifsVides(coup.ordreJoueurs),
    gagnantId: null,
    aParler: coup.ordreJoueurs[0] as JoueurId,
    enAttente: [],
    engageId: null,
  };

  table.jokersGardes = new Map(Object.entries(jokersConserves));
  table.coup = rejoue;
  table.tourEnCours = null;
  return rejoue;
};
