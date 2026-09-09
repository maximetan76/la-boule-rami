/**
 * Gestion en mémoire des tables de jeu.
 *
 * Aucune persistance à ce stade : l'état vit dans le processus. Un joueur
 * déconnecté garde sa place et son jeu, et retrouve exactement le même état en
 * revenant avec son jeton, tant que le serveur n'a pas redémarré.
 */
import { randomUUID } from 'node:crypto';
import type { Boule, Carte, Coup, Joueur, JoueurId } from '../models/index.js';
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
import type { TourEnAttente } from './etat-filtre.js';

export type TableId = string;
export type Jeton = string;

/**
 * Que faire d'un tour entamé par un joueur qui se déconnecte.
 *
 * `delai` défausse automatiquement au bout de `dureeMs` et passe la main, pour
 * que la table ne reste pas bloquée. `illimite` attend son retour.
 */
export type GestionDeconnexion =
  | { readonly type: 'delai'; readonly dureeMs: number }
  | { readonly type: 'illimite' };

export const DELAI_DECONNEXION_PAR_DEFAUT_MS = 90_000;

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

/** Tour entamé par un joueur, tant que le moteur ne l'a pas validé. */
export interface TourEnCours extends TourEnAttente {
  readonly joueurId: JoueurId;
  readonly source: 'pioche' | 'defausse';
  readonly cartePiochee: Carte;
  poses: import('../models/index.js').Combinaison[];
  ajouts: { combinaisonId: string; cartes: import('../models/index.js').CartePosee[] }[];
}

export interface Table {
  readonly id: TableId;
  readonly joueurs: Joueur[];
  boule: Boule;
  coup: Coup | null;
  tourEnCours: TourEnCours | null;
  /** Socket courante de chaque joueur, `null` s'il est déconnecté. */
  readonly connexions: Map<JoueurId, string | null>;
  readonly alea: () => number;
  readonly gestionDeconnexion: GestionDeconnexion;
  /** Annulation du minuteur d'abandon de tour en cours, s'il y en a un. */
  annulerMinuteur: (() => void) | null;
  /** Jokers tirés à l'ouverture, conservés pour la donne du premier coup. */
  readonly cartesConserveesParJoueur: Map<JoueurId, Carte[]>;
}

export interface PlaceCreee {
  readonly joueurId: JoueurId;
  readonly nom: string;
  readonly jeton: Jeton;
}

/**
 * Authentification volontairement minimale à ce stade : un jeton opaque par
 * place, remis à la création de la table. Il identifie le joueur de façon
 * stable, ce qui suffit à la reconnexion. Une vraie authentification viendra
 * plus tard.
 */
export class GameRoomManager {
  private readonly tables = new Map<TableId, Table>();
  private readonly places = new Map<Jeton, { tableId: TableId; joueurId: JoueurId }>();
  private readonly sockets = new Map<string, { tableId: TableId; joueurId: JoueurId }>();

  constructor(readonly minuteur: Minuteur = minuteurSysteme) {}

  creerTable(
    noms: readonly string[],
    options: {
      readonly nombreCoupsFriches?: number;
      readonly alea?: () => number;
      readonly gestionDeconnexion?: GestionDeconnexion;
    } = {},
  ): { tableId: TableId; places: PlaceCreee[]; donneurInitial: JoueurId } {
    const tableId = randomUUID();
    const alea = options.alea ?? Math.random;
    const joueurs: Joueur[] = noms.map((nom, index) => ({
      id: `j${String(index + 1)}`,
      nom,
      croix: 0,
    }));

    // Tirage d'ouverture : il fixe les sièges, le donneur initial, et laisse à
    // qui a tiré un joker sa carte pour la donne du premier coup.
    const tirage = tirerSiegesEtDonneurInitial(joueurs, melangerPaquet(construirePaquet(), alea));
    const assis = tirage.ordreTable.map(
      (joueurId) => joueurs.find((joueur) => joueur.id === joueurId) as Joueur,
    );

    const table: Table = {
      id: tableId,
      joueurs: assis,
      boule: initialiserBoule(assis, options.nombreCoupsFriches),
      coup: null,
      tourEnCours: null,
      connexions: new Map(joueurs.map((joueur) => [joueur.id, null])),
      alea,
      gestionDeconnexion: options.gestionDeconnexion ?? {
        type: 'delai',
        dureeMs: DELAI_DECONNEXION_PAR_DEFAUT_MS,
      },
      annulerMinuteur: null,
      cartesConserveesParJoueur: tirage.cartesConserveesParJoueur,
    };
    this.tables.set(tableId, table);

    const places = joueurs.map((joueur) => {
      const jeton = randomUUID();
      this.places.set(jeton, { tableId, joueurId: joueur.id });
      return { joueurId: joueur.id, nom: joueur.nom, jeton };
    });

    return { tableId, places, donneurInitial: tirage.donneurInitial };
  }

  table(tableId: TableId): Table {
    const table = this.tables.get(tableId);
    if (table === undefined) throw new Error(`Table ${tableId} introuvable`);
    return table;
  }

  /** Rattache une socket à la place désignée par le jeton. */
  attacherSocket(jeton: Jeton, socketId: string): { table: Table; joueurId: JoueurId } {
    const place = this.places.get(jeton);
    if (place === undefined) throw new Error('Jeton de session inconnu');

    const table = this.table(place.tableId);
    // Une reconnexion remplace la socket précédente sans toucher au jeu, et
    // désamorce l'abandon automatique du tour que le joueur avait entamé.
    if (table.tourEnCours?.joueurId === place.joueurId) {
      table.annulerMinuteur?.();
      table.annulerMinuteur = null;
    }
    table.connexions.set(place.joueurId, socketId);
    this.sockets.set(socketId, place);
    return { table, joueurId: place.joueurId };
  }

  detacherSocket(socketId: string): { table: Table; joueurId: JoueurId } | null {
    const place = this.sockets.get(socketId);
    if (place === undefined) return null;
    this.sockets.delete(socketId);

    const table = this.table(place.tableId);
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
  const numero = numeroCoupCourant(table.boule);
  const { joueursActifs, joueursAssis, donneurId } = determinerJoueursAssis(table.boule, numero);

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
    estFriche: estCoupFriche(table.boule, numero),
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
    estFriche: estCoupFriche(table.boule, coup.numero),
    recapitulatifs,
    gagnantId: null,
  };

  table.coup = rejoue;
  table.tourEnCours = null;
  return rejoue;
};
