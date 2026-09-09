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
  distribuerCartes,
  estCoupFriche,
  initialiserBoule,
  melangerPaquet,
  numeroCoupCourant,
  redistribuerApresFricheGeneralisee,
} from '../game-engine/index.js';
import { estJoker } from '../game-engine/cartes.js';
import type { TourEnAttente } from './etat-filtre.js';

export type TableId = string;
export type Jeton = string;

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

  creerTable(
    noms: readonly string[],
    options: { readonly nombreCoupsFriches?: number; readonly alea?: () => number } = {},
  ): { tableId: TableId; places: PlaceCreee[] } {
    const tableId = randomUUID();
    const joueurs: Joueur[] = noms.map((nom, index) => ({
      id: `j${String(index + 1)}`,
      nom,
      croix: 0,
    }));

    const table: Table = {
      id: tableId,
      joueurs,
      boule: initialiserBoule(joueurs, options.nombreCoupsFriches),
      coup: null,
      tourEnCours: null,
      connexions: new Map(joueurs.map((joueur) => [joueur.id, null])),
      alea: options.alea ?? Math.random,
    };
    this.tables.set(tableId, table);

    const places = joueurs.map((joueur) => {
      const jeton = randomUUID();
      this.places.set(jeton, { tableId, joueurId: joueur.id });
      return { joueurId: joueur.id, nom: joueur.nom, jeton };
    });

    return { tableId, places };
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
    // Une reconnexion remplace la socket précédente sans toucher au jeu.
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
  const { mains, pioche } = distribuerCartes(
    ordonnes,
    melangerPaquet(construirePaquet(), table.alea),
  );

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
