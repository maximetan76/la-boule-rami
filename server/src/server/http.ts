/**
 * Endpoints HTTP : authentification, salons, compte joueur.
 *
 * Tout ce qui touche au jeu passe par les sockets ; le HTTP sert à ce qui se
 * fait hors table — s'authentifier, ouvrir un salon, le rejoindre par code,
 * abandonner une partie, changer de pseudo.
 */
import { calculerFinDeBoule, estBouleTerminee } from '../game-engine/index.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifierJetonApple, type ConfigApple } from '../auth/apple.js';
import {
  renouvelerJetonSession,
  signerJetonSession,
  verifierJetonSession,
  type ConfigSession,
} from '../auth/session.js';
import type {
  Depot,
  GestionDeconnexion,
  JoueurEnregistre,
  PartieEnregistree,
} from '../persistence/depot.js';
import { DELAI_DECONNEXION_PAR_DEFAUT_MS, DELAIS_PAR_DEFAUT } from '../persistence/depot.js';
import type { DelaisDeJeu } from '../persistence/depot.js';
import { joueurAttendu } from './handlers.js';
import { deserialiserBoule } from '../persistence/serialisation.js';
import type { ResultatCoup } from '../models/index.js';
import { filtrerEtatPourJoueur } from './etat-filtre.js';
import type { GameRoomManager, Table } from './game-room-manager.js';

/** Au-delà, la requête est rejetée : un jeton d'identité tient largement dedans. */
const TAILLE_CORPS_MAX = 16 * 1024;

export const PSEUDO_LONGUEUR_MIN = 2;
export const PSEUDO_LONGUEUR_MAX = 24;

export interface DependancesHttp {
  readonly depot: Depot;
  readonly manager: GameRoomManager;
  readonly session: ConfigSession;
  /** `null` quand Sign in with Apple n'est pas configuré : la route est alors hors service. */
  readonly apple: ConfigApple | null;
  /** Prévient les joueurs connectés qu'une table a changé. */
  readonly notifier?: (table: Table) => void;
  /**
   * Pousse l'abandon aux sockets encore ouvertes au moment où il est décidé.
   * Sans cela, l'app ne l'apprendrait qu'au prochain `GET /tables/moi`.
   */
  readonly annoncerAbandon?: (socketIds: readonly string[], charge: unknown) => void;
}

/** Erreur destinée au client, avec le code HTTP qui va avec. */
class ErreurHttp extends Error {
  constructor(
    readonly statut: number,
    message: string,
  ) {
    super(message);
    this.name = 'ErreurHttp';
  }
}

const lireCorps = async (requete: IncomingMessage): Promise<Record<string, unknown>> => {
  const morceaux: Buffer[] = [];
  let taille = 0;

  for await (const morceau of requete) {
    const bloc = morceau as Buffer;
    taille += bloc.length;
    if (taille > TAILLE_CORPS_MAX) throw new ErreurHttp(413, 'Corps de requete trop volumineux');
    morceaux.push(bloc);
  }

  if (morceaux.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(morceaux).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new ErreurHttp(400, 'Corps de requete illisible');
  }
};

const repondreJson = (reponse: ServerResponse, code: number, corps: unknown): void => {
  const charge = JSON.stringify(corps);
  reponse.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(charge),
  });
  reponse.end(charge);
};

const texteOuNull = (valeur: unknown): string | null =>
  typeof valeur === 'string' && valeur.length > 0 ? valeur : null;

/** Identifie l'appelant à partir de l'en-tête `Authorization: Bearer`. */
const authentifier = async (
  requete: IncomingMessage,
  deps: DependancesHttp,
): Promise<JoueurEnregistre> => {
  const entete = requete.headers.authorization ?? '';
  const jeton = entete.startsWith('Bearer ') ? entete.slice('Bearer '.length) : null;
  if (jeton === null) throw new ErreurHttp(401, 'Jeton de session manquant');

  let joueurId: string;
  try {
    ({ joueurId } = await verifierJetonSession(jeton, deps.session));
  } catch {
    throw new ErreurHttp(401, 'Jeton de session refuse');
  }

  const joueur = await deps.depot.trouverJoueur(joueurId);
  if (joueur === null) throw new ErreurHttp(401, 'Compte inconnu');
  return joueur;
};

/**
 * Ouvre une session à partir d'un jeton d'identité Apple.
 *
 * Apple ne transmet le nom qu'à la toute première connexion : l'app le joint
 * quand elle l'a, et le pseudo déjà enregistré sert ensuite.
 */
const ouvrirSession = async (
  corps: Record<string, unknown>,
  deps: DependancesHttp,
): Promise<unknown> => {
  if (deps.apple === null) {
    throw new ErreurHttp(
      503,
      "Authentification Apple non configuree sur ce serveur : APPLE_CLIENT_ID n'est pas defini",
    );
  }

  const jetonIdentite = texteOuNull(corps['jetonIdentite']);
  if (jetonIdentite === null) throw new ErreurHttp(401, "Jeton d'identite Apple manquant");

  let identifiantApple: string;
  try {
    ({ identifiantApple } = await verifierJetonApple(jetonIdentite, deps.apple));
  } catch {
    throw new ErreurHttp(401, 'Authentification Apple refusee');
  }

  const pseudo = texteOuNull(corps['pseudo']) ?? 'Joueur';
  const joueur = await deps.depot.trouverOuCreerJoueurApple(identifiantApple, pseudo);

  return {
    jetonSession: await signerJetonSession(joueur.id, deps.session),
    joueur: { id: joueur.id, pseudo: joueur.pseudo },
  };
};

/** Lit la configuration de déconnexion envoyée par le client. */
const lireGestionDeconnexion = (valeur: unknown): GestionDeconnexion | undefined => {
  if (valeur === undefined || valeur === null) return undefined;
  const brut = valeur as Record<string, unknown>;

  if (brut['type'] === 'illimite') return { type: 'illimite' };
  if (brut['type'] === 'delai') {
    const dureeMs = brut['dureeMs'];
    if (dureeMs === undefined) return { type: 'delai', dureeMs: DELAI_DECONNEXION_PAR_DEFAUT_MS };
    if (typeof dureeMs !== 'number' || !Number.isFinite(dureeMs) || dureeMs <= 0) {
      throw new ErreurHttp(400, 'Delai de deconnexion invalide');
    }
    return { type: 'delai', dureeMs };
  }
  throw new ErreurHttp(400, 'Gestion de deconnexion invalide : « delai » ou « illimite » attendus');
};

/**
 * Lit les délais de jeu envoyés à la création d'une table.
 *
 * Un délai absent prend sa valeur par défaut — illimité —, `null` le rend
 * illimité explicitement. La
 * prolongation peut valoir 0 : aucune.
 */
const lireDelais = (valeur: unknown): DelaisDeJeu => {
  if (valeur === undefined || valeur === null) return DELAIS_PAR_DEFAUT;
  if (typeof valeur !== 'object' || Array.isArray(valeur)) {
    throw new ErreurHttp(400, 'Delais de jeu invalides');
  }
  const brut = valeur as Record<string, unknown>;
  const lire = (cle: keyof DelaisDeJeu, minimumMs: number): number | null => {
    if (!(cle in brut)) return DELAIS_PAR_DEFAUT[cle];
    const ms = brut[cle];
    if (ms === null) return null;
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < minimumMs) {
      throw new ErreurHttp(400, `Delai ${cle} invalide`);
    }
    return ms;
  };
  return {
    annonceMs: lire('annonceMs', 5_000),
    jeuMs: lire('jeuMs', 5_000),
    prolongationMs: lire('prolongationMs', 0),
  };
};

const decrireTable = (table: Table) => ({
  tableId: table.id,
  codeInvitation: table.codeInvitation,
  capacite: table.capacite,
  statut: table.statut,
  createurId: table.createurId,
  joueurs: table.joueurs.map((joueur) => ({ joueurId: joueur.id, pseudo: joueur.nom })),
  delais: table.delais,
});

const creerTable = async (
  corps: Record<string, unknown>,
  deps: DependancesHttp,
  joueur: JoueurEnregistre,
): Promise<unknown> => {
  const capacite = corps['nombreJoueurs'];
  if (capacite !== undefined && typeof capacite !== 'number') {
    throw new ErreurHttp(400, 'Nombre de joueurs invalide');
  }

  const creee = await deps.manager.creerTable(joueur, {
    ...(capacite === undefined ? {} : { capacite }),
    delais: lireDelais(corps['delais']),
    ...(() => {
      const gestion = lireGestionDeconnexion(corps['gestionDeconnexion']);
      return gestion === undefined ? {} : { gestionDeconnexion: gestion };
    })(),
  });

  return decrireTable(deps.manager.table(creee.tableId));
};

const rejoindreTable = async (
  corps: Record<string, unknown>,
  deps: DependancesHttp,
  joueur: JoueurEnregistre,
): Promise<unknown> => {
  const code = texteOuNull(corps['code']);
  if (code === null) throw new ErreurHttp(400, "Code d'invitation manquant");

  const table = await deps.manager.rejoindreParCode(code, joueur);
  // Les joueurs déjà assis voient la place se remplir, et la partie démarrer.
  deps.notifier?.(table);
  return decrireTable(table);
};

const abandonner = async (
  tableId: string,
  deps: DependancesHttp,
  joueur: JoueurEnregistre,
): Promise<unknown> => {
  let table: Table;
  try {
    table = deps.manager.table(tableId);
  } catch {
    throw new ErreurHttp(404, 'Table introuvable');
  }
  if (!table.connexions.has(joueur.id)) {
    throw new ErreurHttp(403, "Vous n'etes pas a cette table");
  }

  const { table: abandonnee, socketsPrevenues } = await deps.manager.abandonner(tableId, joueur.id);
  deps.annoncerAbandon?.(socketsPrevenues, {
    tableId,
    motif: 'abandon',
    parJoueurId: joueur.id,
    termineeLe: new Date().toISOString(),
  });

  return { tableId, statut: abandonnee.statut };
};

/**
 * Départ d'un salon : la place se libère et le salon poursuit sans le partant.
 * Une partie déjà commencée ne se quitte pas, elle s'abandonne.
 */
/**
 * Les coups déjà joués de la Boule en cours : qui a posé quoi, et ce qui est
 * resté dans les mains.
 *
 * Réservé aux joueurs de la table. Rien n'y fuit qui n'ait déjà été montré :
 * les combinaisons étaient face visible, et les mains ont été révélées à
 * l'entracte de chaque coup. Le coup en cours, lui, n'y figure jamais.
 */
/** Le décompte d'une Boule dont tous les coups sont joués ; `null` avant, ou après un abandon. */
const finDe = (boule: Parameters<typeof estBouleTerminee>[0] | null) =>
  boule !== null && estBouleTerminee(boule) ? calculerFinDeBoule(boule) : null;

/** Les coups archivés, tels que l'historique les montre. */
const decrireCoups = (historique: readonly ResultatCoup[]) =>
  historique.map((coup) => ({
    numero: coup.numero,
    gagnantId: coup.gagnantId,
    typeVictoire: coup.typeVictoire,
    estFriche: coup.estFriche,
    scores: coup.scores,
    croixGagnees: coup.croixGagnees,
    combinaisons: coup.combinaisons ?? [],
    mainsRevelees: coup.mainsRevelees ?? {},
    // Vide pour un coup archivé avant qu'on la retienne.
    poseFinale: coup.poseFinale ?? [],
  }));

/**
 * L'historique complet d'une Boule, pendant la partie comme après.
 *
 * Tant que la table vit en mémoire, c'est elle qui répond. Une partie close —
 * abandonnée, ou achevée puis sortie de la mémoire à un redémarrage — se relit
 * en base, où chaque fin de coup a écrit la Boule. Un abandon y ajoute qui l'a
 * décidé, quand, et le coup interrompu, mains de tous comprises. Seuls les
 * joueurs de la partie y ont accès.
 */
const historiqueDeLaBoule = async (
  tableId: string,
  deps: DependancesHttp,
  joueur: JoueurEnregistre,
): Promise<unknown> => {
  const vivante = deps.manager.tableVivante(tableId);
  if (vivante !== null) {
    if (!vivante.connexions.has(joueur.id)) {
      throw new ErreurHttp(403, "Vous n'etes pas a cette table");
    }
    return {
      tableId,
      statut: vivante.statut,
      coups: decrireCoups(vivante.boule?.historique ?? []),
      finDeBoule: finDe(vivante.boule),
      abandon: null,
    };
  }

  const archive = await deps.depot.chargerArchive(tableId);
  if (archive === null) throw new ErreurHttp(404, 'Table introuvable');
  const { partie } = archive;
  const bouleArchivee = archive.etatBoule === null ? null : deserialiserBoule(archive.etatBoule);
  if (!partie.joueursIds.includes(joueur.id)) {
    throw new ErreurHttp(403, "Vous n'etes pas a cette table");
  }

  return {
    tableId,
    statut:
      partie.termineeLe === null
        ? partie.demarree
          ? 'en-cours'
          : 'salon'
        : partie.motifFin === 'abandon'
          ? 'abandonnee'
          : 'terminee',
    coups: decrireCoups(bouleArchivee?.historique ?? []),
    finDeBoule: finDe(bouleArchivee),
    abandon:
      partie.abandon === null
        ? null
        : {
            parJoueurId: partie.abandon.parJoueurId,
            le: partie.abandon.le.toISOString(),
            coupInterrompu: partie.abandon.coupInterrompu,
          },
  };
};

const quitterSalon = async (
  tableId: string,
  deps: DependancesHttp,
  joueur: JoueurEnregistre,
): Promise<unknown> => {
  let table: Table;
  try {
    table = deps.manager.table(tableId);
  } catch {
    throw new ErreurHttp(404, 'Table introuvable');
  }
  if (!table.connexions.has(joueur.id)) {
    throw new ErreurHttp(403, "Vous n'etes pas a cette table");
  }

  const restante = await deps.manager.quitterSalon(tableId, joueur.id);
  // Les joueurs restants voient la place se libérer.
  deps.notifier?.(restante);

  return {
    tableId,
    statut: restante.statut,
    placesOccupees: restante.joueurs.length,
    capacite: restante.capacite,
  };
};

const changerPseudo = async (
  corps: Record<string, unknown>,
  deps: DependancesHttp,
  joueur: JoueurEnregistre,
): Promise<unknown> => {
  const pseudo = (texteOuNull(corps['pseudo']) ?? '').trim();
  if (pseudo.length < PSEUDO_LONGUEUR_MIN || pseudo.length > PSEUDO_LONGUEUR_MAX) {
    throw new ErreurHttp(
      400,
      `Pseudo invalide : entre ${String(PSEUDO_LONGUEUR_MIN)} et ${String(PSEUDO_LONGUEUR_MAX)} caracteres`,
    );
  }

  const renomme = await deps.depot.renommerJoueur(joueur.id, pseudo);
  // Le nouveau pseudo vaut aussi pour les tables déjà en mémoire.
  deps.manager.renommerDansLesTables(joueur.id, pseudo);

  return { joueur: { id: renomme.id, pseudo: renomme.pseudo } };
};

/** Résumé de Boule, pour un client qui reprend une partie sans coup distribué. */
const resumerBoule = (table: Table) =>
  table.boule === null
    ? null
    : {
        nombreCoupsTotal: table.boule.nombreCoupsTotal,
        nombreCoupsFriches: table.boule.nombreCoupsFriches,
        coupsJoues: table.boule.historique.length,
        scoresCumules: { ...table.boule.scoresCumules },
        croix: { ...table.boule.croix },
      };

/**
 * Où en est le joueur : c'est le point d'entrée d'un client qui n'a gardé que
 * son jeton de session — après un redémarrage du serveur, ou une réinstallation
 * de l'application.
 *
 * Une partie abandonnée en son absence est signalée comme telle plutôt que
 * passée sous silence : sans cela, un joueur revenu trop tard croirait n'avoir
 * jamais eu de partie en cours. La réponse redevient « aucune » dès qu'il
 * ouvre ou rejoint une autre table.
 */
const situationDuJoueur = async (
  deps: DependancesHttp,
  joueur: JoueurEnregistre,
): Promise<unknown> => {
  const table = deps.manager.tableDuJoueur(joueur.id);

  if (table !== null) {
    if (table.statut === 'salon') return { statut: 'salon', table: decrireTable(table) };
    return {
      statut: 'en-cours',
      table: decrireTable(table),
      boule: resumerBoule(table),
      // Le coup en cours n'est pas persisté : après un redémarrage, il n'y a
      // rien à filtrer tant que la donne n'a pas été refaite.
      etat:
        table.coup === null
          ? null
          : filtrerEtatPourJoueur(table.coup, table.boule as NonNullable<typeof table.boule>, joueur.id, {
              tableId: table.id,
              connectes: deps.manager.joueursConnectes(table),
              tourEnAttente: table.tourEnCours,
            }),
    };
  }

  const derniere = await deps.depot.dernierePartieDuJoueur(joueur.id);
  if (derniere === null) return { statut: 'aucune' };

  if (derniere.termineeLe !== null) {
    // Une partie achevée normalement n'a rien à signaler : le joueur en a vu
    // le décompte final. Un abandon, lui, s'est produit sans lui.
    if (derniere.motifFin !== 'abandon') return { statut: 'aucune' };
    return {
      statut: 'abandonnee',
      tableId: derniere.id,
      codeInvitation: derniere.codeInvitation,
      termineeLe: derniere.termineeLe.toISOString(),
    };
  }

  // La base connaît une partie vivante que la mémoire ignore : le serveur n'a
  // pas encore rechargé. Mieux vaut le dire que renvoyer « aucune table ».
  return {
    statut: derniere.demarree ? 'en-cours' : 'salon',
    table: await decrirePartie(derniere, deps.depot),
    boule: null,
    etat: null,
  };
};

const decrirePartie = async (partie: PartieEnregistree, depot: Depot) => {
  const joueurs = await Promise.all(
    partie.joueursIds.map(async (joueurId) => ({
      joueurId,
      pseudo: (await depot.trouverJoueur(joueurId))?.pseudo ?? joueurId,
    })),
  );
  return {
    tableId: partie.id,
    codeInvitation: partie.codeInvitation,
    capacite: partie.capacite,
    statut: partie.demarree ? 'en-cours' : 'salon',
    createurId: partie.createurId,
    joueurs,
  };
};

/** Où en est une partie, dans la liste d'un joueur. */
type StatutDePartie = 'salon' | 'en-cours' | 'terminee' | 'abandonnee';

/**
 * Toutes les parties du joueur — salons, parties en cours, terminées ou
 * abandonnées —, la plus récente d'abord.
 *
 * Une table vivante se décrit depuis la mémoire, qui sait si elle attend ce
 * joueur ; une partie close ne vit plus qu'en base.
 */
const mesParties = async (deps: DependancesHttp, joueur: JoueurEnregistre): Promise<unknown> => {
  const parties = await deps.depot.partiesDuJoueur(joueur.id);
  return {
    parties: await Promise.all(
      parties.map(async (partie) => {
        const vivante = partie.termineeLe === null ? deps.manager.tableVivante(partie.id) : null;
        const description = vivante === null ? await decrirePartie(partie, deps.depot) : decrireTable(vivante);
        const statut: StatutDePartie =
          partie.termineeLe !== null
            ? partie.motifFin === 'abandon'
              ? 'abandonnee'
              : 'terminee'
            : (vivante?.statut ?? description.statut) === 'salon'
              ? 'salon'
              : 'en-cours';
        const coup = vivante?.coup ?? null;
        return {
          tableId: description.tableId,
          codeInvitation: description.codeInvitation,
          capacite: description.capacite,
          createurId: description.createurId,
          joueurs: description.joueurs,
          statut,
          creeeLe: partie.creeeLe.toISOString(),
          termineeLe: partie.termineeLe?.toISOString() ?? null,
          abandonneParId: partie.abandon?.parJoueurId ?? null,
          // La table attend-elle ce joueur, là, maintenant ?
          aMoiDAgir:
            vivante !== null && vivante.resultatCoup === null && coup !== null && joueurAttendu(coup) === joueur.id,
        };
      }),
    ),
  };
};

const ABANDON = /^\/tables\/([^/]+)\/abandonner$/;
const QUITTER = /^\/tables\/([^/]+)\/quitter$/;
const HISTORIQUE = /^\/tables\/([^/]+)\/historique$/;

/**
 * Gestionnaire de requêtes, à brancher sur le serveur HTTP que socket.io
 * partage. Les échecs d'authentification remontent en 401 avec un message
 * court : rien de ce que dit `jose` sur la vérification n'est renvoyé tel quel.
 */
export const gererRequeteHttp =
  (deps: DependancesHttp) =>
  (requete: IncomingMessage, reponse: ServerResponse): void => {
    const chemin = (requete.url ?? '').split('?')[0] ?? '';
    const methode = requete.method ?? 'GET';

    const traiter = async (): Promise<{ code: number; corps: unknown }> => {
      if (methode === 'GET' && chemin === '/sante') return { code: 200, corps: { ok: true } };

      if (methode === 'POST' && chemin === '/auth/apple') {
        return { code: 200, corps: await ouvrirSession(await lireCorps(requete), deps) };
      }

      if (methode === 'POST' && chemin === '/auth/renouveler') {
        const jeton = texteOuNull((await lireCorps(requete))['jeton']);
        if (jeton === null) throw new ErreurHttp(401, 'Jeton manquant');
        try {
          return { code: 200, corps: { jetonSession: await renouvelerJetonSession(jeton, deps.session) } };
        } catch {
          throw new ErreurHttp(401, 'Jeton de session refuse');
        }
      }

      if (methode === 'GET' && chemin === '/tables') {
        return { code: 200, corps: await mesParties(deps, await authentifier(requete, deps)) };
      }

      if (methode === 'GET' && chemin === '/tables/moi') {
        return { code: 200, corps: await situationDuJoueur(deps, await authentifier(requete, deps)) };
      }

      if (methode === 'POST' && chemin === '/tables') {
        const corps = await lireCorps(requete);
        return { code: 201, corps: await creerTable(corps, deps, await authentifier(requete, deps)) };
      }

      if (methode === 'POST' && chemin === '/tables/rejoindre') {
        const corps = await lireCorps(requete);
        return { code: 200, corps: await rejoindreTable(corps, deps, await authentifier(requete, deps)) };
      }

      const abandon = ABANDON.exec(chemin);
      if (methode === 'POST' && abandon !== null) {
        const joueur = await authentifier(requete, deps);
        return { code: 200, corps: await abandonner(abandon[1] as string, deps, joueur) };
      }

      const depart = QUITTER.exec(chemin);
      if (methode === 'POST' && depart !== null) {
        const joueur = await authentifier(requete, deps);
        return { code: 200, corps: await quitterSalon(depart[1] as string, deps, joueur) };
      }

      const historique = HISTORIQUE.exec(chemin);
      if (methode === 'GET' && historique !== null) {
        const joueur = await authentifier(requete, deps);
        return { code: 200, corps: await historiqueDeLaBoule(historique[1] as string, deps, joueur) };
      }

      if (methode === 'PATCH' && chemin === '/joueur/pseudo') {
        const corps = await lireCorps(requete);
        return { code: 200, corps: await changerPseudo(corps, deps, await authentifier(requete, deps)) };
      }

      throw new ErreurHttp(404, 'Ressource inconnue');
    };

    traiter()
      .then(({ code, corps }) => {
        repondreJson(reponse, code, corps);
      })
      .catch((erreur: unknown) => {
        if (erreur instanceof ErreurHttp) {
          repondreJson(reponse, erreur.statut, { erreur: erreur.message });
          return;
        }
        // Une règle métier refusée (code inconnu, table pleine, partie déjà
        // commencée) remonte ici : le message du moteur est explicite.
        repondreJson(reponse, 400, {
          erreur: erreur instanceof Error ? erreur.message : 'Requete refusee',
        });
      });
  };
