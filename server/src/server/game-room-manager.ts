/**
 * Gestion en mémoire des tables de jeu, adossée à un dépôt.
 *
 * Une table naît en salon : son créateur l'ouvre, un code d'invitation court
 * circule, et les places se remplissent une par une. Quand la dernière est
 * prise, le tirage d'ouverture a lieu et la partie commence.
 *
 * L'état de jeu vit en mémoire — c'est lui qui répond à chaque action — et n'est
 * écrit en base qu'aux moments qui comptent : fin de coup et fin de Boule. Un
 * redémarrage ne perd donc jamais plus que le coup en cours, redistribué.
 *
 * L'identité vient du jeton de session applicatif (voir `src/auth`) : c'est lui
 * qui désigne le joueur, et non un jeton propre à la table. C'est ce qui permet
 * de retrouver sa place après un redémarrage du serveur.
 */
import { COUPS_FRICHES_PAR_DEFAUT, COUPS_PAR_NOMBRE_DE_JOUEURS } from '../models/index.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  Boule,
  Carte,
  CarteId,
  Coup,
  Joueur,
  JoueurId,
  ScoreCoup,
} from '../models/index.js';
import {
  construirePaquet,
  determinerJoueursAssis,
  distribuerAvecCartesConservees,
  distribuerCartes,
  estCoupFriche,
  initialiserBoule,
  melangerPaquet,
  numeroCoupCourant,
  redistribuerApresFricheGeneralisee,
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
import { deserialiserBoule, serialiserBoule } from '../persistence/serialisation.js';
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
  /** Joueurs assis. En salon, dans l'ordre d'arrivée ; ensuite, celui du tirage. */
  joueurs: Joueur[];
  /** `null` tant que la partie n'a pas démarré. */
  boule: Boule | null;
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
   * Valeur monétaire d'un point, en décimal (« 0.20 ») ; `null` : aucune.
   * Sert à convertir les écarts de fin de Boule, rien d'autre.
   */
  readonly valeurPoint: string | null;
  /** Le délai qui court pour le joueur attendu, s'il y en a un. */
  attenteDeJeu: AttenteDeJeu | null;
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
   * Jokers que chaque joueur a gardés en main lors d'une friche généralisée,
   * pour qu'il les reconnaisse à la reprise. Vidé à chaque nouvelle donne.
   */
  jokersGardes: Map<JoueurId, Carte[]>;
}

export interface TableCreee {
  readonly tableId: TableId;
  readonly codeInvitation: string;
  readonly capacite: number;
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
  valeurPoint: table.valeurPoint,
});

/** La Boule d'une table dont la partie a démarré. */
export const bouleEnCours = (table: Table): Boule => {
  if (table.boule === null) throw new Error("La partie n'a pas encore demarre");
  return table.boule;
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
      coupsJoues: boule?.historique.length ?? 0,
      nombreCoupsTotal: boule?.nombreCoupsTotal ?? 0,
      nombreCoupsFriches: boule?.nombreCoupsFriches ?? 0,
      scoresCumules: { ...(boule?.scoresCumules ?? {}) },
      croix: { ...(boule?.croix ?? {}) },
      mains,
      combinaisons: [...(coup?.combinaisons ?? [])],
    },
  };
};

export class GameRoomManager {
  private readonly tables = new Map<TableId, Table>();
  private readonly parCode = new Map<string, TableId>();
  private readonly sockets = new Map<string, { tableId: TableId; joueurId: JoueurId }>();

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
      /** Valeur d'un point, décimal normalisé ; aucune sans précision. */
      readonly valeurPoint?: string | null;
      readonly alea?: () => number;
    } = {},
  ): Promise<TableCreee> {
    const capacite = options.capacite ?? 4;
    if (!Number.isInteger(capacite) || capacite < CAPACITE_MIN || capacite > CAPACITE_MAX) {
      throw new Error(
        `Nombre de joueurs hors limites : ${String(capacite)} (attendu ${String(CAPACITE_MIN)} a ${String(CAPACITE_MAX)})`,
      );
    }
    const coupsFrichesDepart = options.coupsFrichesDepart ?? COUPS_FRICHES_PAR_DEFAUT;
    const coupsDeLaBoule = COUPS_PAR_NOMBRE_DE_JOUEURS[capacite] ?? 0;
    if (!Number.isInteger(coupsFrichesDepart) || coupsFrichesDepart < 0 || coupsFrichesDepart > coupsDeLaBoule) {
      throw new Error(
        `Nombre de coups friches hors limites : ${String(coupsFrichesDepart)} (attendu 0 a ${String(coupsDeLaBoule)})`,
      );
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
      joueurs: [{ id: createur.id, nom: createur.pseudo, croix: 0 }],
      boule: null,
      coup: null,
      tourEnCours: null,
      connexions: new Map([[createur.id, null]]),
      alea: options.alea ?? Math.random,
      gestionDeconnexion,
      delais,
      coupsFrichesDepart,
      valeurPoint: options.valeurPoint ?? null,
      attenteDeJeu: null,
      annulerMinuteur: null,
      joueurEnSursis: null,
      cartesConserveesParJoueur: new Map(),
      resultatCoup: null,
      tirageOuverture: null,
      retournementsTirage: new Map(),
      jokersGardes: new Map(),
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
      valeurPoint: options.valeurPoint ?? null,
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
    table.joueurs = [...table.joueurs, { id: joueur.id, nom: joueur.pseudo, croix: 0 }];
    table.connexions.set(joueur.id, null);
    await this.depot?.asseoirJoueur(table.id, joueur.id, position);

    if (table.joueurs.length === table.capacite) await this.demarrerPartie(table);
    return table;
  }

  /** Tirage d'ouverture, sièges, Boule : la table quitte le salon. */
  async demarrerPartie(table: Table): Promise<void> {
    const tirage = tirerSiegesEtDonneurInitial(
      table.joueurs,
      melangerPaquet(construirePaquet(), table.alea),
    );
    table.joueurs = tirage.ordreTable.map(
      (joueurId) => table.joueurs.find((joueur) => joueur.id === joueurId) as Joueur,
    );
    table.boule = initialiserBoule(table.joueurs, table.coupsFrichesDepart);
    table.cartesConserveesParJoueur = tirage.cartesConserveesParJoueur;
    table.tirageOuverture = tirage;
    table.statut = 'en-cours';

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
   * Le coup en cours n'est pas restauré : il sera redistribué dès que la table
   * sera de nouveau au complet.
   */
  async recharger(options: { readonly alea?: () => number } = {}): Promise<TableId[]> {
    if (this.depot === null) return [];

    const actives = await this.depot.chargerPartiesActives();
    const rechargees: TableId[] = [];

    for (const { partie, joueurs, etatBoule } of actives) {
      if (joueurs.length === 0) continue;

      const assis: Joueur[] = joueurs.map((joueur) => ({
        id: joueur.id,
        nom: joueur.pseudo,
        croix: 0,
      }));

      const table: Table = {
        id: partie.id,
        codeInvitation: partie.codeInvitation,
        createurId: partie.createurId,
        capacite: partie.capacite,
        statut: partie.demarree ? 'en-cours' : 'salon',
        joueurs: assis,
        boule:
          etatBoule === null
            ? partie.demarree
              ? initialiserBoule(assis, partie.coupsFrichesDepart)
              : null
            : deserialiserBoule(etatBoule),
        coup: null,
        tourEnCours: null,
        connexions: new Map(assis.map((joueur) => [joueur.id, null])),
        alea: options.alea ?? Math.random,
        // La configuration de déconnexion est relue avec la partie : une table
        // ne repart pas sur la valeur par défaut après un redémarrage.
        gestionDeconnexion: partie.gestionDeconnexion,
        delais: partie.delais,
        coupsFrichesDepart: partie.coupsFrichesDepart,
        valeurPoint: partie.valeurPoint,
        attenteDeJeu: null,
        annulerMinuteur: null,
        joueurEnSursis: null,
        // Les jokers du tirage d'ouverture appartiennent au premier coup, déjà
        // joué si la Boule a un historique.
        cartesConserveesParJoueur: new Map(),
      resultatCoup: null,
      tirageOuverture: null,
      retournementsTirage: new Map(),
      jokersGardes: new Map(),
      };

      this.tables.set(table.id, table);
      this.parCode.set(table.codeInvitation, table.id);
      rechargees.push(partie.id);
    }

    return rechargees;
  }

  /** Écrit l'état de la Boule. Appelé aux fins de coup et de Boule, pas plus souvent. */
  async persister(table: Table): Promise<void> {
    if (table.boule === null) return;
    await this.depot?.enregistrerBoule(table.id, serialiserBoule(table.boule));
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
    if (place === undefined) throw new Error('Socket non rattachee a une table');
    return { table: this.table(place.tableId), joueurId: place.joueurId };
  }

  joueursConnectes(table: Table): JoueurId[] {
    return [...table.connexions.entries()]
      .filter(([, socketId]) => socketId !== null)
      .map(([joueurId]) => joueurId);
  }

  socketDe(table: Table, joueurId: JoueurId): string | null {
    return table.connexions.get(joueurId) ?? null;
  }

  tousConnectes(table: Table): boolean {
    return this.joueursConnectes(table).length === table.joueurs.length;
  }
}

/** Distribue un nouveau coup et ouvre la phase des annonces. */
export const demarrerCoup = (table: Table): Coup => {
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

  const recapitulatifs: Coup['recapitulatifs'] = {};
  for (const id of joueursActifs) {
    recapitulatifs[id] = { toursAvecPose: [], aAjouteSurCombinaisonAutrui: false };
  }

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
    recapitulatifs,
    gagnantId: null,
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
export const redistribuerCoup = (table: Table): Coup => {
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

  const recapitulatifs: Coup['recapitulatifs'] = {};
  for (const id of coup.ordreJoueurs) {
    recapitulatifs[id] = { toursAvecPose: [], aAjouteSurCombinaisonAutrui: false };
  }

  const rejoue: Coup = {
    ...coup,
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
    recapitulatifs,
    gagnantId: null,
  };

  table.jokersGardes = new Map(Object.entries(jokersConserves));
  table.coup = rejoue;
  table.tourEnCours = null;
  return rejoue;
};
