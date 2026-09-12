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
import { randomBytes, randomUUID } from 'node:crypto';
import type { Boule, Carte, Coup, Joueur, JoueurId, ScoreCoup } from '../models/index.js';
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
import type { Depot, GestionDeconnexion, JoueurEnregistre } from '../persistence/depot.js';
import { DELAI_DECONNEXION_PAR_DEFAUT_MS } from '../persistence/depot.js';
import { deserialiserBoule, serialiserBoule } from '../persistence/serialisation.js';
import type { TourEnAttente } from './etat-filtre.js';

export type TableId = string;

export type { GestionDeconnexion };
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
export interface TourEnCours extends TourEnAttente {
  readonly joueurId: JoueurId;
  readonly source: 'pioche' | 'defausse';
  readonly cartePiochee: Carte;
  poses: import('../models/index.js').Combinaison[];
  ajouts: { combinaisonId: string; cartes: import('../models/index.js').CartePosee[] }[];
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
  /** Annulation du minuteur d'abandon de tour en cours, s'il y en a un. */
  annulerMinuteur: (() => void) | null;
  /** Joueur dont le tour expirera si le minuteur va au bout. */
  joueurEnSursis: JoueurId | null;
  /** Jokers tirés à l'ouverture, conservés pour la donne du premier coup. */
  cartesConserveesParJoueur: Map<JoueurId, Carte[]>;
  /** Décompte du coup qui vient de finir, tant que tous n'ont pas dit « suite ». */
  resultatCoup: ResultatCoupEnAttente | null;
}

export interface TableCreee {
  readonly tableId: TableId;
  readonly codeInvitation: string;
  readonly capacite: number;
}

/** La Boule d'une table dont la partie a démarré. */
export const bouleEnCours = (table: Table): Boule => {
  if (table.boule === null) throw new Error("La partie n'a pas encore demarre");
  return table.boule;
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

  /** Refuse d'asseoir un joueur déjà engagé ailleurs. */
  private async verifierLibre(joueurId: JoueurId): Promise<void> {
    for (const table of this.tables.values()) {
      if (table.statut !== 'terminee' && table.connexions.has(joueurId)) {
        throw new Error(`${joueurId} est deja engage sur une autre table`);
      }
    }
    const active = await this.depot?.partieActiveDuJoueur(joueurId);
    if (active != null) throw new Error(`${joueurId} est deja engage sur une autre table`);
  }

  async creerTable(
    createur: JoueurEnregistre | { id: JoueurId; pseudo: string },
    options: {
      readonly capacite?: number;
      readonly gestionDeconnexion?: GestionDeconnexion;
      readonly alea?: () => number;
    } = {},
  ): Promise<TableCreee> {
    const capacite = options.capacite ?? 4;
    if (!Number.isInteger(capacite) || capacite < CAPACITE_MIN || capacite > CAPACITE_MAX) {
      throw new Error(
        `Nombre de joueurs hors limites : ${String(capacite)} (attendu ${String(CAPACITE_MIN)} a ${String(CAPACITE_MAX)})`,
      );
    }
    await this.verifierLibre(createur.id);

    const tableId = randomUUID();
    const codeInvitation = await this.codeUnique();
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
      annulerMinuteur: null,
      joueurEnSursis: null,
      cartesConserveesParJoueur: new Map(),
      resultatCoup: null,
    };
    this.tables.set(tableId, table);
    this.parCode.set(codeInvitation, tableId);

    await this.depot?.creerPartie({
      id: tableId,
      codeInvitation,
      createurId: createur.id,
      capacite,
      gestionDeconnexion,
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
    await this.verifierLibre(joueur.id);

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
    table.boule = initialiserBoule(table.joueurs);
    table.cartesConserveesParJoueur = tirage.cartesConserveesParJoueur;
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
  async abandonner(tableId: TableId): Promise<{ table: Table; socketsPrevenues: string[] }> {
    const table = this.table(tableId);
    const socketsPrevenues = [...table.connexions.values()].filter(
      (socketId): socketId is string => socketId !== null,
    );
    table.annulerMinuteur?.();
    table.annulerMinuteur = null;
    table.joueurEnSursis = null;
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
    await this.depot?.terminerPartie(tableId, 'abandon');
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
              ? initialiserBoule(assis)
              : null
            : deserialiserBoule(etatBoule),
        coup: null,
        tourEnCours: null,
        connexions: new Map(assis.map((joueur) => [joueur.id, null])),
        alea: options.alea ?? Math.random,
        // La configuration de déconnexion est relue avec la partie : une table
        // ne repart pas sur la valeur par défaut après un redémarrage.
        gestionDeconnexion: partie.gestionDeconnexion,
        annulerMinuteur: null,
        joueurEnSursis: null,
        // Les jokers du tirage d'ouverture appartiennent au premier coup, déjà
        // joué si la Boule a un historique.
        cartesConserveesParJoueur: new Map(),
      resultatCoup: null,
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

  table.coup = rejoue;
  table.tourEnCours = null;
  return rejoue;
};
