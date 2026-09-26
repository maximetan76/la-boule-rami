/**
 * Endpoints HTTP : authentification, salons, compte joueur.
 *
 * Tout ce qui touche au jeu passe par les sockets ; le HTTP sert à ce qui se
 * fait hors table — s'authentifier, ouvrir un salon, le rejoindre par code,
 * abandonner une partie, changer de pseudo, supprimer son compte.
 */
import { decrireTablePublique, nomALaTable } from './game-room-manager.js';
import type { NiveauOrdinateur } from '../bots/index.js';
import {
  COUPS_PAR_NOMBRE_DE_JOUEURS,
  estVariante,
  MANCHES_A_GAGNER_MAX,
  MANCHES_A_GAGNER_MIN,
  MONTANT_MAX,
  MONTANT_MIN,
  NOMBRE_COUPS_MAX,
  NOMBRE_COUPS_MIN,
} from '../models/index.js';
import { calculerFinDeBoule, estBouleTerminee, reportEnCours } from '../game-engine/index.js';
import { randomUUID } from 'node:crypto';
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
import { deserialiserBoule, deserialiserMatchPanier } from '../persistence/serialisation.js';
import type { MatchPanier, ResultatCoup, Variante } from '../models/index.js';
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
  /** Coupe toutes les connexions encore ouvertes d'un joueur : son compte vient d'être supprimé. */
  readonly deconnecterJoueur?: (joueurId: string) => void;
}

/**
 * Le compte tel que l'API le rend. `pseudoChoisi` absent d'un compte d'avant
 * ce champ : il vaut comme choisi, pour ne jamais bloquer un ancien joueur.
 */
const decrireJoueur = (joueur: JoueurEnregistre) => ({
  id: joueur.id,
  pseudo: joueur.pseudo,
  pseudoChoisi: joueur.pseudoChoisi ?? true,
});

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
  // Un jeton signé avant la suppression du compte ne vaut plus rien.
  if ((joueur.supprimeLe ?? null) !== null) throw new ErreurHttp(401, 'Compte supprime');
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
    joueur: decrireJoueur(joueur),
  };
};

/** Pseudo du compte de démonstration servi à la revue Apple. */
export const PSEUDO_DEMO = 'Testeur';

/** Le nom de l'adversaire d'une partie contre l'ordinateur. */
export const PSEUDO_ORDINATEUR = 'Ordinateur';
/** Ses adversaires, tenus par le serveur. */
const PSEUDOS_DES_ROBOTS = ['Robot Bo', 'Robot Cy'];

/**
 * Ouvre une session de démonstration, sans Sign in with Apple, et sert une
 * table déjà démarrée.
 *
 * Destinée à la revue de l'App Store : le compte est créé à la volée — un
 * compte neuf par appel, pour que deux réviseurs ne se marchent pas dessus —,
 * assis à une table de trois joueurs dont deux sont tenus par le serveur (voir
 * `jouerPourLeBot`). La partie démarre dès que le réviseur s'y connecte.
 */
const ouvrirSessionDemo = async (deps: DependancesHttp): Promise<unknown> => {
  const marque = `demo-reviewer:${randomUUID()}`;
  const testeur = await deps.depot.trouverOuCreerJoueurApple(marque, PSEUDO_DEMO, { pseudoChoisi: true });

  const robots: JoueurEnregistre[] = [];
  for (const [rang, pseudo] of PSEUDOS_DES_ROBOTS.entries()) {
    robots.push(
      await deps.depot.trouverOuCreerJoueurApple(`${marque}:robot-${String(rang)}`, pseudo, { pseudoChoisi: true }),
    );
  }

  const { tableId, codeInvitation } = await deps.manager.creerTable(
    { id: testeur.id, pseudo: testeur.pseudo },
    {
      capacite: PSEUDOS_DES_ROBOTS.length + 1,
      // Rien ne presse un réviseur : ni délai de jeu, ni sursis d'absence.
      gestionDeconnexion: { type: 'illimite' },
      delais: DELAIS_PAR_DEFAUT,
      bots: robots.map((robot) => robot.id),
    },
  );
  for (const robot of robots) {
    await deps.manager.rejoindreParCode(codeInvitation, { id: robot.id, pseudo: robot.pseudo });
  }

  return {
    jetonSession: await signerJetonSession(testeur.id, deps.session),
    joueur: decrireJoueur(testeur),
    tableId,
    codeInvitation,
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

/**
 * Le nombre de coups de la Boule demandé : absent ou nul, celui des règles ;
 * sinon un entier de 1 à 12.
 */
const lireNombreCoups = (valeur: unknown): number | null => {
  if (valeur === undefined || valeur === null) return null;
  if (typeof valeur !== 'number' || !Number.isInteger(valeur) || valeur < NOMBRE_COUPS_MIN || valeur > NOMBRE_COUPS_MAX) {
    throw new ErreurHttp(400, `Nombre de coups invalide (${String(NOMBRE_COUPS_MIN)} a ${String(NOMBRE_COUPS_MAX)})`);
  }
  return valeur;
};

/**
 * Les coups frichés de départ demandés : absents, 2 ; sinon un entier de 0 au
 * nombre de coups de la Boule pour cette table.
 */
const lireCoupsFriches = (valeur: unknown, capacite: number, nombreCoups: number | null): number | undefined => {
  if (valeur === undefined || valeur === null) return undefined;
  const plafond = nombreCoups ?? COUPS_PAR_NOMBRE_DE_JOUEURS[capacite] ?? 0;
  if (typeof valeur !== 'number' || !Number.isInteger(valeur) || valeur < 0 || valeur > plafond) {
    throw new ErreurHttp(400, `Nombre de coups friches invalide (0 a ${String(plafond)})`);
  }
  return valeur;
};

/**
 * La valeur d'un point demandée : absente, vide ou nulle, aucune ; sinon un
 * décimal positif, virgule ou point, au plus 4 décimales (« 0,20 », 2.1).
 * Rendue normalisée, avec un point : « 0.20 ».
 */
const lireValeurPoint = (valeur: unknown): string | null => {
  if (valeur === undefined || valeur === null || valeur === '') return null;
  const texte = typeof valeur === 'number' ? String(valeur) : typeof valeur === 'string' ? valeur.trim() : null;
  const normalise = texte?.replace(',', '.') ?? '';
  if (!/^\d{1,6}(\.\d{1,4})?$/.test(normalise) || Number(normalise) <= 0) {
    throw new ErreurHttp(400, "Valeur d'un point invalide (un montant positif, 4 decimales au plus)");
  }
  return normalise;
};

/** La variante demandée : absente, La Boule. */
const lireVariante = (valeur: unknown): Variante => {
  if (valeur === undefined || valeur === null) return 'boule';
  if (!estVariante(valeur)) throw new ErreurHttp(400, 'Variante inconnue (boule ou panier)');
  return valeur;
};

/** L'adversaire d'une partie de panier : un autre joueur (par défaut), ou l'ordinateur. */
const lireAdversaire = (valeur: unknown): 'humain' | 'ordinateur' => {
  if (valeur === undefined || valeur === null || valeur === 'humain') return 'humain';
  if (valeur === 'ordinateur') return 'ordinateur';
  throw new ErreurHttp(400, 'Adversaire inconnu (humain ou ordinateur)');
};

/** La force de l'ordinateur : absente, « facile ». */
const lireNiveau = (valeur: unknown): NiveauOrdinateur => {
  if (valeur === undefined || valeur === null) return 'facile';
  if (valeur === 'facile' || valeur === 'fort') return valeur;
  throw new ErreurHttp(400, 'Niveau inconnu (facile ou fort)');
};

/** Manches à gagner du panier : absent, 3 ; sinon un entier dans les bornes. */
const lireManchesAGagner = (valeur: unknown): number | undefined => {
  if (valeur === undefined || valeur === null) return undefined;
  if (
    typeof valeur !== 'number' ||
    !Number.isInteger(valeur) ||
    valeur < MANCHES_A_GAGNER_MIN ||
    valeur > MANCHES_A_GAGNER_MAX
  ) {
    throw new ErreurHttp(
      400,
      `Nombre de manches a gagner invalide (${String(MANCHES_A_GAGNER_MIN)} a ${String(MANCHES_A_GAGNER_MAX)})`,
    );
  }
  return valeur;
};

/** Montant du panier : absent, 10 ; sinon un nombre positif dans les bornes. */
const lireMontant = (valeur: unknown): number | undefined => {
  if (valeur === undefined || valeur === null) return undefined;
  if (typeof valeur !== 'number' || !Number.isFinite(valeur) || valeur < MONTANT_MIN || valeur > MONTANT_MAX) {
    throw new ErreurHttp(400, `Montant invalide (${String(MONTANT_MIN)} a ${String(MONTANT_MAX)})`);
  }
  return valeur;
};

const decrireTable = decrireTablePublique;

const creerTable = async (
  corps: Record<string, unknown>,
  deps: DependancesHttp,
  joueur: JoueurEnregistre,
): Promise<unknown> => {
  const variante = lireVariante(corps['variante']);
  if (variante === 'panier') {
    // Réf. § « Le panier » : deux joueurs, ni coups frichés ni valeur du point.
    const manchesAGagner = lireManchesAGagner(corps['manchesAGagner']);
    const montant = lireMontant(corps['montant']);
    const contreLOrdinateur = lireAdversaire(corps['adversaire']) === 'ordinateur';
    // Lu avant de créer le compte de l'ordinateur : un niveau refusé n'en laisse aucun.
    const niveauOrdinateur = contreLOrdinateur ? lireNiveau(corps['niveau']) : 'facile';
    // L'ordinateur a son propre compte, un par partie : il s'assied comme
    // n'importe quel joueur, et le serveur joue pour lui (voir `bots/`).
    const ordinateur = contreLOrdinateur
      ? await deps.depot.trouverOuCreerJoueurApple(`robot:${randomUUID()}`, PSEUDO_ORDINATEUR, { pseudoChoisi: true })
      : null;
    const creee = await deps.manager.creerTable(joueur, {
      variante: 'panier',
      capacite: 2,
      ...(ordinateur === null ? {} : { bots: [ordinateur.id], niveauOrdinateur }),
      ...(manchesAGagner === undefined ? {} : { manchesAGagner }),
      ...(montant === undefined ? {} : { montant }),
      delais: lireDelais(corps['delais']),
      ...(() => {
        const gestion = lireGestionDeconnexion(corps['gestionDeconnexion']);
        return gestion === undefined ? {} : { gestionDeconnexion: gestion };
      })(),
    });
    // La table est aussitôt complète : la partie démarre dès que le joueur
    // s'y connecte.
    if (ordinateur !== null) {
      await deps.manager.rejoindreParCode(creee.codeInvitation, { id: ordinateur.id, pseudo: ordinateur.pseudo });
    }
    return decrireTable(deps.manager.table(creee.tableId));
  }

  const capacite = corps['nombreJoueurs'];
  if (capacite !== undefined && typeof capacite !== 'number') {
    throw new ErreurHttp(400, 'Nombre de joueurs invalide');
  }

  const nombreCoups = lireNombreCoups(corps['nombreCoups']);
  const coupsFrichesDepart = lireCoupsFriches(corps['coupsFrichesDepart'], capacite ?? 4, nombreCoups);
  const creee = await deps.manager.creerTable(joueur, {
    ...(capacite === undefined ? {} : { capacite }),
    nombreCoups,
    ...(coupsFrichesDepart === undefined ? {} : { coupsFrichesDepart }),
    valeurPoint: lireValeurPoint(corps['valeurPoint']),
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

/**
 * Ce que le tableau de scores lit en plus des coups : l'ordre des joueurs à la
 * table, la valeur d'un point, et le report de coups frichés — ceux que la
 * Boule suivante reprendrait en plus de ses coups frichés configurés.
 */
const configurationDuTableau = (
  ordreJoueurs: readonly string[],
  coupsFrichesDepart: number,
  valeurPoint: string | null,
  boule: Parameters<typeof estBouleTerminee>[0] | null,
) => ({
  ordreJoueurs: [...ordreJoueurs],
  coupsFrichesDepart,
  // Le report tel qu'il est suivi pendant la Boule, pas sa seule croissance.
  coupsFrichesEnPlus: boule === null ? null : reportEnCours(boule, coupsFrichesDepart),
  valeurPoint,
});

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
/**
 * Le match du panier tel que l'API le raconte : où il en est, et chaque manche
 * jouée. `null` pour une partie de La Boule.
 */
const decrirePanier = (match: MatchPanier | null) =>
  match === null
    ? null
    : {
        manchesAGagner: match.manchesAGagner,
        montant: match.montant,
        manchesGagnees: { ...match.manchesGagnees },
        vainqueurId: match.vainqueurId,
        manches: match.historique.map((manche) => ({
          numero: manche.numero,
          gagnantId: manche.gagnantId,
          combinaisons: manche.combinaisons.map((combinaison) => ({ ...combinaison })),
          mainsRevelees: Object.fromEntries(
            Object.entries(manche.mainsRevelees).map(([joueurId, cartes]) => [joueurId, [...cartes]]),
          ),
        })),
      };

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
      variante: vivante.variante,
      panier: decrirePanier(vivante.panier),
      statut: vivante.statut,
      coups: decrireCoups(vivante.boule?.historique ?? []),
      finDeBoule: finDe(vivante.boule),
      ...configurationDuTableau(
        vivante.joueurs.map((joueur) => joueur.id),
        vivante.coupsFrichesDepart,
        vivante.valeurPoint,
        vivante.boule,
      ),
      abandon: null,
    };
  }

  const archive = await deps.depot.chargerArchive(tableId);
  if (archive === null) throw new ErreurHttp(404, 'Table introuvable');
  const { partie } = archive;
  const bouleArchivee = archive.etatBoule === null ? null : deserialiserBoule(archive.etatBoule);
  const panierArchive = archive.etatPanier === null ? null : deserialiserMatchPanier(archive.etatPanier);
  if (!partie.joueursIds.includes(joueur.id)) {
    throw new ErreurHttp(403, "Vous n'etes pas a cette table");
  }

  return {
    tableId,
    variante: partie.variante ?? 'boule',
    panier: decrirePanier(panierArchive),
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
    ...configurationDuTableau(partie.joueursIds, partie.coupsFrichesDepart, partie.valeurPoint, bouleArchivee),
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
  // Le nouveau pseudo vaut aussi pour les tables déjà en mémoire, et part
  // aussitôt vers les joueurs qui y sont connectés : sans cela, ils
  // garderaient l'ancien jusqu'à leur prochaine entrée dans la table.
  deps.manager.renommerDansLesTables(joueur.id, pseudo);
  for (const table of deps.manager.tablesDuJoueur(joueur.id)) deps.notifier?.(table);

  return { joueur: decrireJoueur(renomme) };
};

/**
 * Supprime le compte de l'appelant, par anonymisation.
 *
 * Une partie en cours s'abandonne d'abord, au nom du joueur : aucune table ne
 * reste à attendre quelqu'un qui ne reviendra pas. Un salon se quitte. Le
 * compte perd ensuite son identifiant Apple — une prochaine connexion Apple en
 * ouvre un neuf — et son pseudo ; plus aucune session ne l'ouvre, et ses
 * connexions encore ouvertes sont coupées. Les parties archivées restent,
 * lisibles par les autres joueurs sous « Joueur supprimé ».
 */
const supprimerCompte = async (deps: DependancesHttp, joueur: JoueurEnregistre): Promise<unknown> => {
  for (const table of deps.manager.tablesDuJoueur(joueur.id)) {
    if (table.statut === 'salon') {
      const restante = await deps.manager.quitterSalon(table.id, joueur.id);
      if (restante.joueurs.length > 0) deps.notifier?.(restante);
    } else if (table.statut === 'en-cours') {
      const { socketsPrevenues } = await deps.manager.abandonner(table.id, joueur.id);
      deps.annoncerAbandon?.(socketsPrevenues, {
        tableId: table.id,
        motif: 'abandon',
        parJoueurId: joueur.id,
        termineeLe: new Date().toISOString(),
      });
    }
  }

  await deps.depot.anonymiserJoueur(joueur.id, `supprime:${randomUUID()}`);
  deps.deconnecterJoueur?.(joueur.id);
  return { ok: true };
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

/** Résumé d'un match du panier, pour un client qui reprend sans coup distribué. */
const resumerMatch = (match: MatchPanier | null) =>
  match === null
    ? null
    : {
        manche: match.historique.length + 1,
        manchesGagnees: { ...match.manchesGagnees },
        manchesAGagner: match.manchesAGagner,
        montant: match.montant,
        vainqueurId: match.vainqueurId,
      };

const resumerPanier = (table: Table) => resumerMatch(table.panier);

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
      panier: resumerPanier(table),
      // Le coup en cours n'est pas persisté : après un redémarrage, il n'y a
      // rien à filtrer tant que la donne n'a pas été refaite.
      etat:
        table.coup === null
          ? null
          : filtrerEtatPourJoueur(
              table.coup,
              table.variante === 'panier'
                ? { panier: table.panier as NonNullable<typeof table.panier> }
                : { boule: table.boule as NonNullable<typeof table.boule> },
              joueur.id,
              {
                tableId: table.id,
                connectes: deps.manager.joueursPresents(table),
                pseudos: Object.fromEntries(table.joueurs.map((assis) => [assis.id, assis.nom])),
                tourEnAttente: table.tourEnCours,
              },
            ),
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
    partie.joueursIds.map(async (joueurId, rang) => {
      const joueur = await depot.trouverJoueur(joueurId);
      // Jamais d'identifiant technique à l'écran, même pour un compte introuvable.
      return { joueurId, pseudo: joueur === null ? `Joueur ${String(rang + 1)}` : nomALaTable(joueur, rang + 1) };
    }),
  );
  return {
    tableId: partie.id,
    codeInvitation: partie.codeInvitation,
    capacite: partie.capacite,
    statut: partie.demarree ? 'en-cours' : 'salon',
    createurId: partie.createurId,
    joueurs,
    coupsFrichesDepart: partie.coupsFrichesDepart,
    coupsFrichesConfigures: partie.coupsFrichesConfigures ?? partie.coupsFrichesDepart,
    excedentDeFriches: partie.excedentDeFriches ?? 0,
    nombreCoups: partie.nombreCoups,
    valeurPoint: partie.valeurPoint,
    variante: partie.variante ?? 'boule',
    manchesAGagner: partie.variante === 'panier' ? (partie.manchesAGagner ?? null) : null,
    montant: partie.variante === 'panier' ? (partie.montant ?? null) : null,
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
  // Le temps de jeu des parties closes, lu en une fois ; une table vivante le
  // porte en mémoire.
  const archives = await deps.depot.tempsDeJeuDesParties(
    parties
      .filter((partie) => partie.termineeLe !== null || deps.manager.tableVivante(partie.id) === null)
      .map((partie) => partie.id),
  );
  // Le match des paniers clos, lu en une fois ; une table vivante le porte.
  const matchs = await deps.depot.matchsDesPaniers(
    parties
      .filter(
        (partie) =>
          partie.variante === 'panier' && (partie.termineeLe !== null || deps.manager.tableVivante(partie.id) === null),
      )
      .map((partie) => partie.id),
  );
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
          // Millisecondes passées à être attendu par la table, par joueur.
          tempsDeJeu: vivante?.boule?.tempsDeJeu ?? vivante?.panier?.tempsDeJeu ?? archives[partie.id] ?? {},
          variante: description.variante,
          manchesAGagner: description.manchesAGagner,
          montant: description.montant,
          // Panier seulement : où en est le match, ou comment il s'est fini.
          panier: resumerMatch(vivante?.panier ?? matchs[partie.id] ?? null),
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
      if (methode === 'GET' && chemin === '/sante') {
        // Render donne le commit déployé : le dire permet de vérifier, d'un
        // simple appel, que la production porte bien le dernier correctif.
        const commit = process.env['RENDER_GIT_COMMIT']?.slice(0, 7);
        return { code: 200, corps: commit === undefined || commit === '' ? { ok: true } : { ok: true, commit } };
      }

      if (methode === 'POST' && chemin === '/auth/apple') {
        return { code: 200, corps: await ouvrirSession(await lireCorps(requete), deps) };
      }

      if (methode === 'POST' && chemin === '/auth/demo') {
        return { code: 200, corps: await ouvrirSessionDemo(deps) };
      }

      if (methode === 'POST' && chemin === '/auth/renouveler') {
        const jeton = texteOuNull((await lireCorps(requete))['jeton']);
        if (jeton === null) throw new ErreurHttp(401, 'Jeton manquant');
        let renouvele: string;
        let joueurId: string;
        try {
          ({ joueurId } = await verifierJetonSession(jeton, deps.session));
          renouvele = await renouvelerJetonSession(jeton, deps.session);
        } catch {
          throw new ErreurHttp(401, 'Jeton de session refuse');
        }
        // Un compte supprimé ne se prolonge pas.
        const joueur = await deps.depot.trouverJoueur(joueurId);
        if (joueur === null || (joueur.supprimeLe ?? null) !== null) {
          throw new ErreurHttp(401, 'Jeton de session refuse');
        }
        return { code: 200, corps: { jetonSession: renouvele } };
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

      if (methode === 'DELETE' && chemin === '/joueur/compte') {
        return { code: 200, corps: await supprimerCompte(deps, await authentifier(requete, deps)) };
      }

      if (methode === 'GET' && chemin === '/joueur/moi') {
        return { code: 200, corps: { joueur: decrireJoueur(await authentifier(requete, deps)) } };
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
