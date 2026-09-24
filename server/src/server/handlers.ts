/**
 * Handlers socket.io.
 *
 * Deux principes gouvernent ce fichier :
 *
 * 1. Le moteur décide. Chaque action est validée par `game-engine` AVANT toute
 *    modification d'état ; les fonctions du moteur étant pures, un refus laisse
 *    la table strictement inchangée et le client reçoit le message d'erreur.
 * 2. Rien ne sort sans filtrage. L'état n'est jamais diffusé en bloc : après
 *    chaque action réussie, chaque joueur reçoit SA vue, construite par
 *    `filtrerEtatPourJoueur`.
 *
 * Les cartes envoyées par un client ne sont jamais reprises telles quelles :
 * seul leur identifiant est lu, et la carte est relue depuis l'état serveur.
 * Sans cela, un client pourrait déclarer un 7 de cœur porteur de l'identifiant
 * d'un 2 de pique qu'il détient.
 */
import { avancerLeChronometre } from './temps-de-jeu.js';
import { COUPS_PAR_NOMBRE_DE_JOUEURS } from '../models/index.js';
import type { Server, Socket } from 'socket.io';
import type {
  Annonce,
  Carte,
  CarteId,
  CartePosee,
  Combinaison,
  Couleur,
  Coup,
  JoueurId,
  ScoreCoup,
  Valeur,
} from '../models/index.js';
import {
  calculerScoreCoup,
  detecterDoubleOuTriple,
  enregistrerResultatCoup,
  calculerFinDeBoule,
  reportDeFriches,
  estBouleTerminee,
  estJoker,
  jouerTour,
  echangerJoker,
  reformerTalon,
  annoncer,
  apresTour,
  joueurQuiParle,
  enregistrerResultatManche,
  estMatchTermine,
} from '../game-engine/index.js';
import { verifierJetonSession, type ConfigSession } from '../auth/session.js';
import { filtrerEtatPourJoueur } from './etat-filtre.js';
import type { EcheanceFiltree, ResultatCoupFiltre, TirageOuvertureFiltre, VueEchanges } from './etat-filtre.js';
import type { AttenteDeJeu, ResultatCoupEnAttente, TourEnCours } from './game-room-manager.js';
import { filtrerTirage, retournerCarte } from './tirage-en-direct.js';
import {
  bouleEnCours,
  panierEnCours,
  ErreurNonRattachee,
  decrireTablePublique,
  demarrerCoup,
  GameRoomManager,
  redistribuerCoup,
  type Table,
} from './game-room-manager.js';

/** Réponse d'acquittement renvoyée à l'émetteur de chaque action. */
export type Acquittement = (reponse: { ok: true } | { ok: false; erreur: string; code?: string }) => void;

interface CartePoseeProposee {
  readonly carteId: CarteId;
  readonly remplace?: { readonly couleur: Couleur; readonly valeur: Valeur } | null;
}

interface CombinaisonProposee {
  readonly type: 'tierce' | 'ensemble';
  readonly couleur?: Couleur;
  readonly valeur?: Valeur;
  readonly cartes: readonly CartePoseeProposee[];
}

let compteurCombinaison = 0;

/** Cartes qu'un joueur peut légitimement engager : sa main et sa carte piochée. */
const cartesDuJoueur = (table: Table, joueurId: JoueurId): Map<CarteId, Carte> => {
  const coup = table.coup;
  const disponibles = new Map<CarteId, Carte>();
  const tour = table.tourEnCours;
  const monTour = tour !== null && tour.joueurId === joueurId;

  // Les échanges de joker du tour changent ce que le joueur tient : la vraie
  // carte est partie sur la table, le joker est à lui.
  const vue = coup !== null && monTour ? vueDesEchanges(coup, tour) : null;
  for (const carte of vue?.main ?? coup?.mains[joueurId] ?? []) disponibles.set(carte.id, carte);

  if (monTour) {
    if (!(vue?.carteConsommee ?? false)) disponibles.set(tour.cartePiochee.id, tour.cartePiochee);
    for (const joker of vue?.jokers ?? []) disponibles.set(joker.id, joker);
  }
  return disponibles;
};

/**
 * Le coup tel que le joueur actif le tient, ses échanges de joker appliqués.
 *
 * Rien de tout cela n'est écrit dans `table.coup` : c'est le brouillon du
 * tour, que la défausse rend réel et qu'une annulation efface sans trace.
 */
const appliquerEchanges = (
  coup: Coup,
  tour: TourEnCours,
): { readonly coup: Coup; readonly jokers: Carte[]; readonly carteConsommee: boolean } => {
  let courant = coup;
  const jokers: Carte[] = [];
  let carteConsommee = false;

  for (const echange of tour.echangesJoker) {
    const depuisLaMain = (courant.mains[tour.joueurId] ?? []).find(
      (carte) => carte.id === echange.carteReelleId,
    );
    const depuisLaPioche =
      !carteConsommee && tour.cartePiochee.id === echange.carteReelleId ? tour.cartePiochee : undefined;
    const carteReelle = depuisLaMain ?? depuisLaPioche;
    if (carteReelle === undefined) {
      throw new Error(`Carte ${echange.carteReelleId} indisponible pour cet echange`);
    }

    const resultat = echangerJoker(
      courant,
      tour.joueurId,
      carteReelle,
      { combinaisonId: echange.combinaisonId, carteJokerId: echange.carteJokerId },
      depuisLaMain === undefined ? { carte: tour.cartePiochee, source: tour.source } : null,
    );
    courant = resultat.coup;
    jokers.push(resultat.joker);
    if (depuisLaMain === undefined) carteConsommee = true;
  }

  return { coup: courant, jokers, carteConsommee };
};

/** Ce que les échanges du tour montrent à celui qui les fait, et à lui seul. */
const vueDesEchanges = (coup: Coup, tour: TourEnCours): VueEchanges | null => {
  if (tour.echangesJoker.length === 0) return null;

  const { coup: applique, jokers, carteConsommee } = appliquerEchanges(coup, tour);
  const idsJokers = new Set(jokers.map((joker) => joker.id));
  return {
    combinaisons: [...applique.combinaisons],
    main: (applique.mains[tour.joueurId] ?? []).filter((carte) => !idsJokers.has(carte.id)),
    jokers,
    carteConsommee,
  };
};

/** Un joker repris est-il engagé dans le brouillon du tour ? */
const jokerEngage = (tour: TourEnCours, jokerId: string): boolean =>
  tour.poses.some((pose) => pose.cartes.some((cp) => cp.carte.id === jokerId)) ||
  tour.ajouts.some((ajout) => ajout.cartes.some((cp) => cp.carte.id === jokerId));

const resoudreCarte = (disponibles: Map<CarteId, Carte>, carteId: unknown): Carte => {
  if (typeof carteId !== 'string') throw new Error('Identifiant de carte invalide');
  const carte = disponibles.get(carteId);
  if (carte === undefined) throw new Error(`Carte ${carteId} indisponible`);
  return carte;
};

const construireCartePosee = (
  disponibles: Map<CarteId, Carte>,
  proposee: CartePoseeProposee,
): CartePosee => ({
  carte: resoudreCarte(disponibles, proposee.carteId),
  remplace: proposee.remplace ?? null,
});

/**
 * Reconstruit une combinaison à partir de ce que propose le client. Le serveur
 * signe lui-même l'identifiant, le propriétaire et le tour de pose : le client
 * n'a la main que sur le choix des cartes.
 */
const construireCombinaison = (
  proposee: CombinaisonProposee,
  disponibles: Map<CarteId, Carte>,
  proprietaireId: JoueurId,
  tourDePose: number,
): Combinaison => {
  const cartes = proposee.cartes.map((carte) => construireCartePosee(disponibles, carte));
  const id = `comb-${String((compteurCombinaison += 1))}`;
  const pure = cartes.every((posee) => posee.carte.type === 'normale');

  if (proposee.type === 'tierce') {
    if (proposee.couleur === undefined) throw new Error('Couleur manquante pour une tierce');
    return { id, type: 'tierce', proprietaireId, tourDePose, couleur: proposee.couleur, cartes, pure };
  }
  if (proposee.valeur === undefined) throw new Error('Valeur manquante pour un brelan ou un carre');
  return {
    id,
    type: cartes.length === 4 ? 'carre' : 'brelan',
    proprietaireId,
    tourDePose,
    valeur: proposee.valeur,
    cartes,
    pure,
  };
};

const coupEnCours = (table: Table): Coup => {
  if (table.coup === null) throw new Error("Aucun coup en cours sur cette table");
  return table.coup;
};

/**
 * Le joueur que la table attend, selon la phase : celui qui doit parler pendant
 * les annonces, celui qui doit jouer ensuite. `null` si rien n'est attendu.
 */
export const joueurAttendu = (coup: Coup): JoueurId | null => {
  if (coup.phase === 'annonces') return joueurQuiParle(coup);
  if (coup.phase === 'jeu') return coup.joueurActifId;
  return null;
};

/**
 * Enregistre une annonce et fait avancer le coup.
 *
 * Réf. docs/REGLES.md § « Phase Friche / Je joue » : la parole tourne tant que
 * personne n'a posé (voir `game-engine/parole.ts`). Si tous frichent d'affilée,
 * au début du coup comme en cours de coup, le coup est rejoué à la même place,
 * avec le même donneur, jokers en main conservés.
 */
const appliquerAnnonce = (table: Table, joueurId: JoueurId, annonce: Annonce): void => {
  const coup = table.coup;
  if (coup === null) return;

  const { coup: apres, toutLeMondeAFriche } = annoncer(coup, joueurId, annonce);
  table.coup = apres;
  if (toutLeMondeAFriche) {
    if (table.variante === 'panier') {
      table.panier = enregistrerResultatManche(panierEnCours(table), coup.numero, {
        toutLeMondeAFriche: true,
      });
    } else {
      table.boule = enregistrerResultatCoup(bouleEnCours(table), coup.numero, {
        toutLeMondeAFriche: true,
      });
    }
    redistribuerCoup(table);
  }
};

/**
 * Envoie à chaque joueur connecté sa propre vue de la table. Jamais de
 * diffusion groupée : deux joueurs ne reçoivent pas le même objet.
 */
export const diffuserEtat = (io: Server, manager: GameRoomManager, table: Table): void => {
  const connectes = manager.joueursConnectes(table);
  const coup = table.coup;

  if (coup === null) {
    // Avant la première donne, il n'y a rien à filtrer : on décrit le salon.
    const salon = {
      tableId: table.id,
      codeInvitation: table.codeInvitation,
      capacite: table.capacite,
      statut: table.statut,
      createurId: table.createurId,
      joueurs: table.joueurs.map((joueur) => ({
        joueurId: joueur.id,
        pseudo: joueur.nom,
        connecte: connectes.includes(joueur.id),
      })),
      // Le salon ne remplace pas la description : il doit porter la variante.
      variante: table.variante,
      manchesAGagner: table.variante === 'panier' ? table.manchesAGagner : null,
      montant: table.variante === 'panier' ? table.montant : null,
    };
    for (const joueurId of connectes) {
      const socketId = manager.socketDe(table, joueurId);
      if (socketId !== null) io.to(socketId).emit('salon', salon);
    }
    return;
  }

  // Les échanges de joker ne sont montrés qu'à celui qui les fait :
  // `filtrerEtatPourJoueur` ne s'en sert que pour lui.
  const echanges = table.tourEnCours === null ? null : vueDesEchanges(coup, table.tourEnCours);
  const echeance = echeanceFiltree(table, coup);
  // La Boule complète, son décompte part avec chaque état : pendant l'entracte
  // du dernier coup, puis une fois la partie close.
  const finDeBoule =
    table.boule !== null && estBouleTerminee(table.boule) ? calculerFinDeBoule(table.boule) : null;

  for (const joueurId of connectes) {
    const socketId = manager.socketDe(table, joueurId);
    if (socketId === null) continue;

    io.to(socketId).emit(
      'etat',
      filtrerEtatPourJoueur(
        coup,
        table.variante === 'panier' ? { panier: panierEnCours(table) } : { boule: bouleEnCours(table) },
        joueurId,
        {
        tableId: table.id,
        connectes,
        pseudos: Object.fromEntries(table.joueurs.map((joueur) => [joueur.id, joueur.nom])),
        tourEnAttente: table.tourEnCours,
        resultat: resultatFiltre(table),
        echangesDuTour: echanges,
        tirageOuverture: tirageFiltre(table),
        jokersGardes: (table.jokersGardes.get(joueurId) ?? []).map((joker) => joker.id),
        jokersConserves: Object.fromEntries(table.jokersGardes),
        finDeBoule,
        echeance,
      },
      ),
    );
  }
};

/**
 * Le délai qui court, pour que chacun voie l'échéance approcher : le joueur
 * attendu, la nature du délai, et ce qu'il en reste à l'instant de l'envoi.
 */
const echeanceFiltree = (table: Table, coup: Coup): EcheanceFiltree | null => {
  const attente = table.attenteDeJeu;
  const attendu = joueurAttendu(coup);
  if (attente === null || attente.finLe === null || attente.dureeMs === null || attendu === null) return null;
  return {
    joueurId: attendu,
    nature: attente.nature,
    restantMs: Math.max(0, attente.finLe - Date.now()),
    dureeMs: attente.dureeMs,
  };
};

/**
 * Le tirage d'ouverture, tant que la Boule en est à son premier coup : c'est
 * là que chacun le découvre, avant la première donne.
 */
const tirageFiltre = (table: Table): TirageOuvertureFiltre | null => {
  const tirage = table.tirageOuverture;
  if (tirage === null || table.coup?.numero !== 1) return null;

  // Seules les cartes retournées par leur joueur sortent : voir tirage-en-direct.
  return filtrerTirage(tirage, table.retournementsTirage);
};

/**
 * Le décompte du coup terminé, mis en forme pour les clients.
 *
 * `null` pendant le jeu : c'est ce qui garde les mains des autres cachées, et
 * cette fonction est le seul endroit où elles sont recopiées.
 */
const resultatFiltre = (table: Table): ResultatCoupFiltre | null => {
  const resultat = table.resultatCoup;
  if (resultat === null) return null;

  return {
    numero: resultat.numero,
    gagnantId: resultat.score.gagnantId,
    typeVictoire: resultat.score.typeVictoire,
    estFriche: resultat.score.estFriche,
    multiplicateur: resultat.score.multiplicateur,
    scores: { ...resultat.score.scores },
    croixGagnees: { ...resultat.score.croixGagnees },
    chocolatId: resultat.score.chocolatId,
    mainsRevelees: Object.fromEntries(
      Object.entries(resultat.mains).map(([joueurId, cartes]) => [joueurId, [...cartes]]),
    ),
    prets: [...resultat.prets],
    derniereCoup: resultat.derniereCoup,
    poseFinale: [...(resultat.poseFinale ?? [])],
    carteDefaussee: resultat.carteDefaussee ?? null,
    rejouer: [...resultat.rejouer],
    rejouerAnnulePar: resultat.rejouerAnnulePar,
    ...(resultat.matchPanier === undefined
      ? {}
      : {
          matchPanier: {
            manchesGagnees: { ...resultat.matchPanier.manchesGagnees },
            manchesAGagner: resultat.matchPanier.manchesAGagner,
            montant: resultat.matchPanier.montant,
            vainqueurId: resultat.matchPanier.vainqueurId,
          },
        }),
  };
};

/**
 * Clôt le coup : score, cumul dans la Boule, coup suivant s'il y a lieu.
 *
 * C'est l'un des deux moments où l'état part en base — l'autre étant la fin de
 * Boule. Entre deux, tout vit en mémoire : un redémarrage ne coûte que le coup
 * en cours, qui sera redistribué.
 */
/**
 * Un score de coup vide, honnête : au panier, il n'y a ni points, ni croix,
 * ni double ou triple — seule la manche gagnée compte, portée à part dans
 * `table.resultatCoup.matchPanier`.
 */
const scoreDeMancheVide = (coup: Coup, gagnantId: JoueurId): ScoreCoup => ({
  gagnantId,
  typeVictoire: 'simple',
  estFriche: false,
  multiplicateur: 1,
  scores: Object.fromEntries(coup.ordreJoueurs.map((id) => [id, 0])),
  croixGagnees: Object.fromEntries(coup.ordreJoueurs.map((id) => [id, 0])),
  chocolatId: null,
});

const cloturerCoup = async (
  manager: GameRoomManager,
  table: Table,
  coup: Coup,
  /** Les cartes engagées par le gagnant à son dernier tour. */
  poseFinale: readonly CarteId[] = [],
): Promise<void> => {
  const gagnantId = coup.gagnantId;
  if (gagnantId === null) return;

  let scoreCoup: ScoreCoup;
  let derniereCoup: boolean;
  let matchPanier: ResultatCoupEnAttente['matchPanier'];

  if (table.variante === 'panier') {
    scoreCoup = scoreDeMancheVide(coup, gagnantId);
    table.panier = enregistrerResultatManche(panierEnCours(table), coup.numero, {
      gagnantId,
      combinaisons: coup.combinaisons,
      mainsRevelees: coup.mains,
    });
    derniereCoup = estMatchTermine(table.panier);
    matchPanier = {
      manchesGagnees: { ...table.panier.manchesGagnees },
      manchesAGagner: table.panier.manchesAGagner,
      montant: table.panier.montant,
      vainqueurId: table.panier.vainqueurId,
    };
  } else {
    const typeVictoire = detecterDoubleOuTriple(coup, gagnantId);
    scoreCoup = calculerScoreCoup(coup, gagnantId, typeVictoire, coup.estFriche);
    table.boule = enregistrerResultatCoup(bouleEnCours(table), coup.numero, scoreCoup, {
      combinaisons: coup.combinaisons,
      mainsRevelees: coup.mains,
      poseFinale: [...poseFinale],
    });
    derniereCoup = estBouleTerminee(bouleEnCours(table));
    matchPanier = undefined;
  }

  // Le coup est fini : le dernier temps de jeu part avec la Boule enregistrée.
  mesurerLeTempsDeJeu(table);
  await manager.persister(table);

  // Le coup suivant n'est pas distribué ici : la donne effacerait le décompte
  // avant que personne ait pu le lire. La table entre en entracte, et n'en
  // sort que lorsque tous les joueurs ont demandé la suite.
  table.resultatCoup = {
    numero: coup.numero,
    score: scoreCoup,
    ...(matchPanier === undefined ? {} : { matchPanier }),
    mains: Object.fromEntries(
      Object.entries(coup.mains).map(([joueurId, cartes]) => [joueurId, [...cartes]]),
    ),
    prets: [],
    derniereCoup,
    poseFinale: [...poseFinale],
    // La défausse qui a clos le coup : la carte du dessus est la sienne.
    carteDefaussee: poseFinale.length === 0 && coup.defausse.length === 0 ? null : (coup.defausse.at(-1) ?? null),
    rejouer: [],
    rejouerAnnulePar: null,
  };
};

/**
 * Sort de l'entracte : distribue le coup suivant, ou clôt la partie.
 *
 * N'est appelée qu'une fois tous les joueurs prêts — c'est le sens même de
 * l'entracte.
 */
const enchainer = async (io: Server, manager: GameRoomManager, table: Table): Promise<void> => {
  const resultat = table.resultatCoup;
  const derniere = resultat?.derniereCoup ?? false;
  const rejouer =
    resultat !== null &&
    resultat.rejouerAnnulePar === null &&
    table.joueurs.every((joueur) => resultat.rejouer.includes(joueur.id));
  table.resultatCoup = null;

  if (derniere) {
    await manager.cloreLaPartie(table);
    if (rejouer) await rejouerAvecLeGroupe(io, manager, table);
    return;
  }
  demarrerCoup(table);
};

/**
 * Relance une Boule avec le même groupe, tous l'ayant confirmé.
 *
 * Une nouvelle table naît avec les mêmes joueurs, assis d'office — sans code à
 * saisir —, et la même configuration : places, délais, gestion des
 * déconnexions. Seuls les coups frichés de départ changent, en cascade : les
 * coups frichés configurés, plus le surplus des friches généralisées de la
 * Boule qui s'achève, plus le report qu'elle avait reçu. Au-delà du nombre de
 * coups, la nouvelle Boule est entièrement frichée et garde l'excédent pour la
 * suivante. Chaque joueur reçoit `nouvelle-table` et y bascule.
 */
const rejouerAvecLeGroupe = async (io: Server, manager: GameRoomManager, table: Table): Promise<void> => {
  const createur = table.joueurs.find((joueur) => joueur.id === table.createurId) ?? table.joueurs[0];
  if (createur === undefined) return;

  // Réf. § « Le panier » : un nouveau match repart de zéro, sans report — la
  // notion de coups frichés ne lui appartient pas.
  let creee: Awaited<ReturnType<typeof manager.creerTable>>;
  if (table.variante === 'panier') {
    creee = await manager.creerTable(
      { id: createur.id, pseudo: createur.nom },
      {
        variante: 'panier',
        capacite: table.capacite,
        gestionDeconnexion: table.gestionDeconnexion,
        delais: table.delais,
        manchesAGagner: table.manchesAGagner,
        montant: table.montant,
        alea: table.alea,
      },
    );
  } else {
    const report = reportDeFriches(bouleEnCours(table), {
      coupsFrichesConfigures: table.coupsFrichesConfigures,
      coupsFrichesDepart: table.coupsFrichesDepart,
      excedentRecu: table.excedentDeFriches,
      coupsDeLaSuivante: table.nombreCoups ?? COUPS_PAR_NOMBRE_DE_JOUEURS[table.capacite] ?? 0,
    });
    creee = await manager.creerTable(
      { id: createur.id, pseudo: createur.nom },
      {
        capacite: table.capacite,
        gestionDeconnexion: table.gestionDeconnexion,
        delais: table.delais,
        coupsFrichesDepart: report.coupsFrichesDepart,
        coupsFrichesConfigures: table.coupsFrichesConfigures,
        excedentDeFriches: report.excedent,
        nombreCoups: table.nombreCoups,
        valeurPoint: table.valeurPoint,
        alea: table.alea,
      },
    );
  }
  // La dernière place prise démarre la partie, comme dans un salon ordinaire.
  for (const joueur of table.joueurs) {
    if (joueur.id === createur.id) continue;
    await manager.rejoindreParCode(creee.codeInvitation, { id: joueur.id, pseudo: joueur.nom });
  }

  table.relanceeVers = creee.tableId;
  const description = decrireTablePublique(manager.table(creee.tableId));
  const annoncer = (): void => {
    for (const joueur of table.joueurs) {
      const socketId = manager.socketDe(table, joueur.id);
      if (socketId !== null) io.to(socketId).emit('nouvelle-table', { ancienneTableId: table.id, table: description });
    }
  };
  // Après l'acquittement de la dernière confirmation : l'app ferme la connexion
  // de l'ancienne table dès qu'elle reçoit l'annonce, et un acquittement parti
  // derrière elle serait perdu — « le serveur n'a pas répondu ».
  setImmediate(annoncer);
};

/**
 * Abandonne le tour d'un joueur parti en cours de route : une carte du talon
 * part à la défausse et la main passe au suivant, sans rien poser — le
 * brouillon de tour, s'il y en avait un, est jeté.
 *
 * Le même geste couvre les trois situations possibles :
 * - le joueur avait pioché au talon : la pioche n'ayant pas été entamée, c'est
 *   exactement la carte qu'il tenait qui part à la défausse ;
 * - il avait pris la défausse : cette carte-là ne peut pas être défaussée telle
 *   quelle, les règles imposant de l'utiliser immédiatement dans une
 *   combinaison ; on lui sert donc une carte du talon qu'il rejette aussitôt ;
 * - il n'avait encore rien fait : on pioche pour lui, et on défausse.
 */
const abandonnerTour = (table: Table, joueurId: JoueurId): Coup | null => {
  const coup = table.coup;
  if (coup === null || coup.phase !== 'jeu') return null;
  if (coup.joueurActifId !== joueurId) return null;
  if (table.tourEnCours !== null && table.tourEnCours.joueurId !== joueurId) return null;

  const talon = reformerTalon(coup.pioche, coup.defausse, table.alea);
  coup.pioche = talon.pioche;
  coup.defausse = talon.defausse;

  const piochee = coup.pioche[0];
  if (piochee === undefined) return null;
  // Un joker ne se défausse jamais (§ « Déroulement d'un tour de jeu ») : si le
  // talon en sert un, il reste en main et c'est une carte ordinaire qui part.
  const aDefausser = [piochee, ...(coup.mains[joueurId] ?? [])].find((carte) => !estJoker(carte));
  if (aDefausser === undefined) return null;

  const { coup: apres } = jouerTour(
    coup,
    joueurId,
    { source: 'pioche', carteDefausseeId: aDefausser.id },
    table.alea,
  );

  const suite = apresTour(apres, joueurId);
  table.coup = suite;
  table.tourEnCours = null;
  return suite;
};

/**
 * Ce que devient le tour d'un joueur absent quand son délai expire : un
 * « friche » pendant les annonces, l'abandon de son tour pendant le jeu.
 */
const expirerTour = async (
  manager: GameRoomManager,
  table: Table,
  joueurId: JoueurId,
): Promise<void> => {
  const coup = table.coup;
  if (coup === null || joueurAttendu(coup) !== joueurId) return;

  if (coup.phase === 'annonces') {
    // Le silence vaut friche : la parole passe au joueur suivant, exactement
    // comme si le joueur avait annoncé lui-même.
    appliquerAnnonce(table, joueurId, 'friche');
    return;
  }
  const apres = abandonnerTour(table, joueurId);
  if (apres !== null && apres.gagnantId !== null) await cloturerCoup(manager, table, apres);
};

/**
 * Arme, désarme ou réarme le minuteur d'absence selon qui la table attend.
 *
 * Le sursis suit le joueur attendu : il tombe dès que ce n'est plus lui, et il
 * s'arme dès que le joueur attendu est absent, quelle que soit la raison — une
 * déconnexion, ou simplement son tour qui arrive alors qu'il est déjà parti.
 * Sans ce dernier cas, la table se rebloquerait sur le joueur suivant si deux
 * joueurs manquaient à la fois.
 */
const reevaluerSursis = (io: Server, manager: GameRoomManager, table: Table): void => {
  if (table.gestionDeconnexion.type !== 'delai') return;

  const coup = table.coup;
  const attendu = coup === null ? null : joueurAttendu(coup);

  if (table.joueurEnSursis !== null && table.joueurEnSursis !== attendu) {
    table.annulerMinuteur?.();
    table.annulerMinuteur = null;
    table.joueurEnSursis = null;
  }

  if (attendu === null) return;
  if (manager.socketDe(table, attendu) !== null) return;
  if (table.joueurEnSursis === attendu) return;

  const dureeMs = table.gestionDeconnexion.dureeMs;
  table.joueurEnSursis = attendu;
  table.annulerMinuteur = manager.minuteur.programmer(() => {
    table.annulerMinuteur = null;
    table.joueurEnSursis = null;
    expirerTour(manager, table, attendu)
      .then(() => {
        publier(io, manager, table);
      })
      .catch(() => {
        // Une expiration impossible ne doit pas faire tomber le serveur : la
        // table reste en l'état et le joueur peut encore revenir.
      });
  }, dureeMs);
};

/**
 * Arme, garde ou désarme le délai de jeu du joueur attendu.
 *
 * Contrairement au sursis, il court pour un joueur présent : c'est la table qui
 * l'a voulu à sa création. Un même moment d'attente — même coup, même phase,
 * même joueur, même tour — garde son minuteur d'une publication à l'autre :
 * piocher ne le relance pas, le délai de jeu couvrant tout le tour. Tout
 * changement d'attente le réarme à neuf.
 */
const reevaluerDelaiDeJeu = (io: Server, manager: GameRoomManager, table: Table): void => {
  const coup = table.coup;
  const attendu = coup === null || table.resultatCoup !== null ? null : joueurAttendu(coup);
  const dureeMs =
    coup === null || attendu === null
      ? null
      : coup.phase === 'annonces'
        ? table.delais.annonceMs
        : table.delais.jeuMs;
  const cle =
    coup === null || attendu === null || dureeMs === null
      ? null
      : [
          coup.numero,
          coup.phase,
          attendu,
          coup.numeroTour,
          Object.keys(coup.annonces).length,
          (coup.enAttente ?? []).length,
        ].join(':');

  if (table.attenteDeJeu !== null && table.attenteDeJeu.cle !== cle) {
    table.attenteDeJeu.annuler();
    table.attenteDeJeu = null;
  }
  if (cle === null || attendu === null || dureeMs === null || table.attenteDeJeu !== null) return;

  const expirer = (): void => {
    const attente: AttenteDeJeu | null = table.attenteDeJeu;
    if (attente === null || attente.cle !== cle) return;

    // Qui a commencé à composer une pose reçoit, une fois, le temps en plus
    // prévu par la table. Illimitée, la prolongation lève l'échéance du tour.
    const prolongationMs = table.delais.prolongationMs;
    if (attente.composition && !attente.prolongee && prolongationMs !== 0) {
      attente.prolongee = true;
      attente.nature = 'prolongation';
      attente.dureeMs = prolongationMs;
      attente.finLe = prolongationMs === null ? null : Date.now() + prolongationMs;
      attente.annuler =
        prolongationMs === null ? () => undefined : manager.minuteur.programmer(expirer, prolongationMs);
      // Sans nouvel état, le compte à rebours de chacun s'arrêterait à zéro.
      diffuserEtat(io, manager, table);
      return;
    }

    table.attenteDeJeu = null;
    // Même issue qu'une absence prolongée : friche pendant les annonces, pioche
    // et défausse d'office pendant le jeu.
    expirerTour(manager, table, attendu)
      .then(() => {
        publier(io, manager, table);
      })
      .catch(() => {
        // Comme pour le sursis : une expiration impossible laisse la table en l'état.
      });
  };

  table.attenteDeJeu = {
    cle,
    annuler: manager.minuteur.programmer(expirer, dureeMs),
    composition: false,
    prolongee: false,
    nature: coup?.phase === 'annonces' ? 'annonce' : 'jeu',
    finLe: Date.now() + dureeMs,
    dureeMs,
  };
};

/** Délai entre deux gestes d'un joueur automatique : le temps de les voir venir. */
export const DELAI_BOT_MS = 1_200;

/**
 * Le joueur automatique que la table attend, s'il y en a un.
 *
 * Pendant le jeu, celui dont c'est le tour ; pendant l'entracte, le premier qui
 * n'a pas encore demandé la suite. Au dernier coup, rien : « Terminer la
 * Boule » appartient aux joueurs humains, et un robot ne la clôt pas pour eux.
 */
const botAttendu = (table: Table): JoueurId | null => {
  if (table.bots.size === 0) return null;

  const resultat = table.resultatCoup;
  if (resultat !== null) {
    if (resultat.derniereCoup) return null;
    return table.joueurs
      .map((joueur) => joueur.id)
      .find((joueurId) => table.bots.has(joueurId) && !resultat.prets.includes(joueurId)) ?? null;
  }

  const coup = table.coup;
  if (coup === null) return null;
  const attendu = joueurAttendu(coup);
  return attendu !== null && table.bots.has(attendu) ? attendu : null;
};

/**
 * Arme, garde ou désarme le geste du joueur automatique attendu.
 *
 * Même principe que le délai de jeu : un même moment d'attente garde son
 * minuteur d'une publication à l'autre, et tout changement le réarme.
 */
const reevaluerLesBots = (io: Server, manager: GameRoomManager, table: Table): void => {
  const bot = botAttendu(table);
  const coup = table.coup;
  const cle =
    bot === null
      ? null
      : [
          bot,
          table.resultatCoup === null ? 'jeu' : 'entracte',
          coup?.numero ?? 0,
          coup?.phase ?? '-',
          coup?.numeroTour ?? 0,
          Object.keys(coup?.annonces ?? {}).length,
          (coup?.enAttente ?? []).length,
        ].join(':');

  if (table.actionBot !== null && table.actionBot.cle !== cle) {
    table.actionBot.annuler();
    table.actionBot = null;
  }
  if (cle === null || bot === null || table.actionBot !== null) return;

  table.actionBot = {
    cle,
    annuler: manager.minuteur.programmer(() => {
      table.actionBot = null;
      jouerPourLeBot(io, manager, table, bot).catch(() => {
        // Un geste impossible ne doit pas faire tomber le serveur : la table
        // reste en l'état, et la publication suivante réarmera le robot.
      });
    }, DELAI_BOT_MS),
  };
};

/**
 * Ce que fait un joueur automatique : le strict nécessaire pour que la partie
 * avance sous les yeux d'un joueur humain.
 *
 * Il annonce « je joue » chaque fois qu'il a la parole, pioche au talon et défausse à son
 * tour — le même geste que le serveur joue déjà pour un joueur parti —, et
 * demande la suite pendant l'entracte. Il ne pose jamais : rien ne l'y oblige,
 * et cela suffit à faire tourner la table.
 */
const jouerPourLeBot = async (
  io: Server,
  manager: GameRoomManager,
  table: Table,
  botId: JoueurId,
): Promise<void> => {
  const resultat = table.resultatCoup;
  if (resultat !== null) {
    if (!resultat.prets.includes(botId)) resultat.prets = [...resultat.prets, botId];
    if (table.joueurs.every((joueur) => resultat.prets.includes(joueur.id))) {
      await enchainer(io, manager, table);
    }
    publier(io, manager, table);
    return;
  }

  const coup = table.coup;
  if (coup === null || joueurAttendu(coup) !== botId) return;

  if (coup.phase === 'annonces') {
    appliquerAnnonce(table, botId, 'je-joue');
    publier(io, manager, table);
    return;
  }

  const apres = abandonnerTour(table, botId);
  if (apres !== null && apres.gagnantId !== null) await cloturerCoup(manager, table, apres);
  publier(io, manager, table);
};

/**
 * Publie le nouvel état : chacun reçoit sa vue, après réévaluation du sursis.
 * Toute action qui modifie la table passe par ici.
 */
/**
 * Crédite le temps écoulé au joueur que la table attendait, s'il a changé.
 * Voir `temps-de-jeu.ts`.
 */
const mesurerLeTempsDeJeu = (table: Table): void => {
  const coup = table.coup;
  const attendu = coup === null || table.resultatCoup !== null ? null : joueurAttendu(coup);
  const { boule, chronometre } = avancerLeChronometre(table.boule, table.chronometre ?? null, attendu, Date.now());
  table.boule = boule;
  table.chronometre = chronometre;
};

const publier = (io: Server, manager: GameRoomManager, table: Table): void => {
  mesurerLeTempsDeJeu(table);
  reevaluerSursis(io, manager, table);
  reevaluerDelaiDeJeu(io, manager, table);
  reevaluerLesBots(io, manager, table);
  diffuserEtat(io, manager, table);
};

const repondre = (ack: unknown, action: () => void | Promise<void>): void => {
  const acquitter = typeof ack === 'function' ? (ack as Acquittement) : null;
  const echouer = (erreur: unknown): void => {
    acquitter?.({
      ok: false,
      erreur: erreur instanceof Error ? erreur.message : 'Erreur inconnue',
      // Un code stable quand l'app doit réagir, pas seulement afficher.
      ...(erreur instanceof ErreurNonRattachee ? { code: erreur.code } : {}),
    });
  };

  try {
    const resultat = action();
    if (resultat instanceof Promise) {
      resultat.then(() => acquitter?.({ ok: true })).catch(echouer);
      return;
    }
    acquitter?.({ ok: true });
  } catch (erreur) {
    echouer(erreur);
  }
};

export const enregistrerHandlers = (
  io: Server,
  manager: GameRoomManager,
  session: ConfigSession,
): void => {
  io.on('connection', (socket: Socket) => {
    socket.on('rejoindre-table', (payload: { jeton?: string; tableId?: string }, ack: unknown) => {
      repondre(ack, async () => {
        if (typeof payload?.jeton !== 'string') throw new Error('Jeton de session manquant');
        if (typeof payload.tableId !== 'string') throw new Error('Table non precisee');

        // L'identité vient du jeton de session, jamais du client lui-même.
        const { joueurId } = await verifierJetonSession(payload.jeton, session);
        // Un compte supprimé n'ouvre plus rien, même avec un jeton encore signé.
        if (await manager.compteSupprime(joueurId)) throw new Error('Compte supprime');
        // Pour couper toutes ses connexions si le compte est supprimé.
        socket.data.joueurId = joueurId;
        const quittee = manager.tableDeLaSocket(socket.id);
        const table = manager.attacherSocket(payload.tableId, joueurId, socket.id);
        // La table que cette connexion suivait vient de la perdre : ses
        // joueurs doivent voir ce joueur absent, et son sursis s'armer.
        if (quittee !== null && quittee !== table) publier(io, manager, quittee);

          // Le premier coup part dès que la partie a démarré et que tout le
        // monde est connecté.
        if (table.coup === null && table.statut === 'en-cours' && manager.tousConnectes(table)) {
          demarrerCoup(table);
        }
        publier(io, manager, table);
      });
    });

    socket.on('annoncer', (payload: { annonce?: string }, ack: unknown) => {
      repondre(ack, () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const coup = coupEnCours(table);

        if (coup.phase !== 'annonces') throw new Error("Ce n'est pas le moment d'annoncer");
        if (payload?.annonce !== 'friche' && payload?.annonce !== 'je-joue') {
          throw new Error('Annonce invalide : « friche » ou « je-joue » attendus');
        }
        if (joueurQuiParle(coup) !== joueurId) {
          throw new Error(`Ce n'est pas a ${joueurId} de parler`);
        }

        appliquerAnnonce(table, joueurId, payload.annonce);
        publier(io, manager, table);
      });
    });

    socket.on('piocher', (payload: { source?: string }, ack: unknown) => {
      repondre(ack, () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        let coup = coupEnCours(table);

        // Réf. docs/REGLES.md § « Phase Friche / Je joue » : toucher la pioche
        // ou la défausse quand on doit à la fois parler et jouer vaut « je joue ».
        if (coup.phase === 'annonces' && joueurQuiParle(coup) === joueurId && coup.joueurActifId === joueurId) {
          if (payload?.source !== 'pioche' && payload?.source !== 'defausse') {
            throw new Error('Source invalide : « pioche » ou « defausse » attendus');
          }
          if (payload.source === 'defausse' && coup.defausse.length === 0) {
            throw new Error('Defausse vide : le premier joueur du coup doit piocher au talon');
          }
          appliquerAnnonce(table, joueurId, 'je-joue');
          coup = coupEnCours(table);
        }

        if (coup.phase !== 'jeu') throw new Error("Le coup n'est pas en phase de jeu");
        if (coup.joueurActifId !== joueurId) throw new Error(`Ce n'est pas au tour de ${joueurId}`);
        if (table.tourEnCours !== null) throw new Error('Vous avez deja pioche ce tour-ci');
        // Réf. docs/REGLES.md § « Règle spéciale : piocher la carte de la
        // défausse » : qui a déjà posé et ne tient plus qu'une carte pioche au talon.
        const aDejaPose = (coup.recapitulatifs[joueurId]?.toursAvecPose.length ?? 0) > 0;
        if (payload?.source === 'defausse' && aDejaPose && (coup.mains[joueurId] ?? []).length === 1) {
          throw new Error('Une seule carte en main apres avoir pose : la defausse ne se prend pas, piochez au talon');
        }
        if (payload?.source !== 'pioche' && payload?.source !== 'defausse') {
          throw new Error('Source invalide : « pioche » ou « defausse » attendus');
        }

        let cartePiochee: Carte | undefined;
        if (payload.source === 'pioche') {
          // Reformer le talon si besoin, avec la meme regle que le moteur.
          const talon = reformerTalon(coup.pioche, coup.defausse, table.alea);
          coup.pioche = talon.pioche;
          coup.defausse = talon.defausse;
          cartePiochee = coup.pioche[0];
        } else {
          cartePiochee = coup.defausse.at(-1);
          if (cartePiochee === undefined) {
            throw new Error('Defausse vide : le premier joueur du coup doit piocher au talon');
          }
        }
        if (cartePiochee === undefined) throw new Error('Aucune carte a piocher');

        // La source est verrouillee : on ne peut pas regarder le talon puis se
        // raviser pour la defausse.
        table.tourEnCours = {
          joueurId,
          source: payload.source,
          cartePiochee,
          poses: [],
          ajouts: [],
          echangesJoker: [],
        };
        publier(io, manager, table);
      });
    });

    socket.on(
      'poser',
      (
        payload: {
          poses?: readonly CombinaisonProposee[];
          ajouts?: readonly { combinaisonId?: string; cartes?: readonly CartePoseeProposee[] }[];
        },
        ack: unknown,
      ) => {
        repondre(ack, () => {
          const { table, joueurId } = manager.placeDeLaSocket(socket.id);
          const coup = coupEnCours(table);
          const tour = table.tourEnCours;

          if (tour === null || tour.joueurId !== joueurId) {
            throw new Error('Il faut piocher avant de poser');
          }

          const disponibles = cartesDuJoueur(table, joueurId);
          const poses = (payload?.poses ?? []).map((proposee) =>
            construireCombinaison(proposee, disponibles, joueurId, coup.numeroTour),
          );
          const ajouts = (payload?.ajouts ?? []).map((ajout) => {
            if (typeof ajout.combinaisonId !== 'string') {
              throw new Error('Combinaison cible manquante');
            }
            if (!coup.combinaisons.some((comb) => comb.id === ajout.combinaisonId)) {
              throw new Error(`Combinaison ${ajout.combinaisonId} introuvable sur la table`);
            }
            return {
              combinaisonId: ajout.combinaisonId,
              cartes: (ajout.cartes ?? []).map((carte) =>
                construireCartePosee(disponibles, carte),
              ),
            };
          });

          // Le tour n'est qu'un brouillon : la validation complete (51 points,
          // tierce franche, carte collante...) revient a `jouerTour`, au moment de
          // defausser, quand l'action est complete et donc verifiable.
          tour.poses = [...tour.poses, ...poses];
          tour.ajouts = [...tour.ajouts, ...ajouts];
          publier(io, manager, table);
        });
      },
    );

    /**
     * Rend une carte prise dans la défausse, et rouvre le choix de la pioche.
     *
     * Réf. docs/REGLES.md § « Règle spéciale : piocher la carte de la
     * défausse » : la carte prise doit servir immédiatement. Un joueur qui n'y
     * parvient pas ne peut plus clore son tour — aucune défausse n'est
     * acceptée — et attendait jusqu'ici l'expiration du délai de déconnexion.
     *
     * Seule une prise en défausse se rend. Le sommet de la défausse est
     * public : le rendre n'apprend rien à personne. Rendre une carte du talon
     * reviendrait à la regarder puis à la remettre, ce qui n'est pas la même
     * chose.
     *
     * La carte n'a jamais quitté la défausse — `piocher` l'y lit sans l'en
     * retirer, c'est le moteur qui la déplace en jouant le tour — il n'y a donc
     * rien à remettre en place.
     */
    socket.on('annuler-pioche', (_payload: unknown, ack: unknown) => {
      repondre(ack, () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const tour = table.tourEnCours;

        if (tour === null) throw new Error('Aucune pioche a annuler');
        if (tour.joueurId !== joueurId) throw new Error(`Ce n'est pas au tour de ${joueurId}`);
        if (tour.source !== 'defausse') {
          throw new Error(
            'Seule une prise en defausse se rend : une carte du talon a ete vue, la rendre ne l effacerait pas',
          );
        }
        if (tour.poses.length > 0 || tour.ajouts.length > 0) {
          throw new Error('Reprenez d abord vos poses avant de rendre la carte');
        }

        table.tourEnCours = null;
        publier(io, manager, table);
      });
    });

    /**
     * Retire le brouillon du tour en cours, sans faire sortir le joueur de son
     * tour.
     *
     * `poser` ne juge rien : le moteur ne tranche qu'à la défausse. Sans cet
     * événement, une pose qu'il refuse resterait dans le tour, qu'aucune
     * défausse ne pourrait plus clore — le joueur serait bloqué jusqu'à
     * l'expiration du délai de déconnexion. Annuler lui rend ce qu'il avait
     * engagé et le laisse recomposer.
     *
     * Rien d'autre ne bouge : ni la carte piochée, ni sa source, ni le talon,
     * ni la défausse, ni le jeu des autres. Les cartes engagées n'ont d'ailleurs
     * jamais quitté la main — `coup.mains` n'est mis à jour qu'à la défausse —
     * elles redeviennent donc simplement libres de servir autrement.
     */
    socket.on('annuler-pose', (_payload: unknown, ack: unknown) => {
      repondre(ack, () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const tour = table.tourEnCours;

        if (tour === null) throw new Error('Aucun tour en cours : rien a annuler');
        if (tour.joueurId !== joueurId) throw new Error(`Ce n'est pas au tour de ${joueurId}`);
        if (tour.poses.length === 0 && tour.ajouts.length === 0) {
          throw new Error('Aucune pose a annuler dans ce tour');
        }

        tour.poses = [];
        tour.ajouts = [];
        publier(io, manager, table);
      });
    });

    socket.on('defausser', (payload: { carteId?: string }, ack: unknown) => {
      repondre(ack, async () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const coup = coupEnCours(table);
        const tour = table.tourEnCours;

        if (tour === null || tour.joueurId !== joueurId) {
          throw new Error('Il faut piocher avant de defausser');
        }
        if (typeof payload?.carteId !== 'string') throw new Error('Carte a defausser manquante');

        // Les echanges de joker du tour deviennent reels ici, avec le reste :
        // jusque-la, seul le joueur les voyait.
        const { coup: avecEchanges, jokers } = appliquerEchanges(coup, tour);

        // Le moteur refuse tout joker a la defausse ; celui-ci vient d'etre
        // repris, et c'est sa reprise qui oblige a le replacer : autant le dire.
        if (jokers.some((joker) => joker.id === payload.carteId)) {
          throw new Error('Le joker recupere doit etre replace dans une combinaison avant de defausser');
        }

        // Le moteur tranche : tant qu'il n'a pas rendu un nouvel etat, la table
        // reste exactement dans l'etat ou elle etait.
        const { coup: apres } = jouerTour(
          avecEchanges,
          joueurId,
          {
            source: tour.source,
            poses: tour.poses,
            ajouts: tour.ajouts,
            carteDefausseeId: payload.carteId,
            jokersRecuperes: jokers.map((joker) => joker.id),
          },
          table.alea,
        );

        // Réf. docs/REGLES.md § « Récupération d'un joker posé » : un joker
        // repris doit etre replace au meme tour. Ni garde en main, ni jete.
        const mainApres = apres.mains[joueurId] ?? [];
        for (const joker of jokers) {
          if (payload.carteId === joker.id || mainApres.some((carte) => carte.id === joker.id)) {
            throw new Error('Le joker recupere doit etre replace dans une combinaison avant de defausser');
          }
        }

        // Après un tour sans pose, le suivant doit d'abord parler : la parole
        // tourne tant que personne n'a posé.
        table.coup = apresTour(apres, joueurId);
        table.tourEnCours = null;
        if (apres.gagnantId !== null) {
          // Ce que le gagnant vient d'engager pour finir : c'est ce que chacun
          // verra mis en évidence avant les scores.
          const poseFinale = [
            ...tour.poses.flatMap((pose) => pose.cartes.map((cp) => cp.carte.id)),
            ...tour.ajouts.flatMap((ajout) => ajout.cartes.map((cp) => cp.carte.id)),
            ...tour.echangesJoker.map((echange) => echange.carteReelleId),
          ];
          await cloturerCoup(manager, table, apres, poseFinale);
        }

        publier(io, manager, table);
      });
    });

    /**
     * Reprend un joker posé en lui substituant la vraie carte.
     *
     * Réf. docs/REGLES.md § « Récupération d'un joker posé ». L'échange entre
     * dans le brouillon du tour : le joueur le voit aussitôt — la vraie carte
     * sur la table, le joker à part —, les autres ne le voient qu'à la
     * défausse. Le joker se replace ensuite comme on l'entend : nouvelle pose
     * ou ajout, n'importe où. La défausse refuse tant qu'il ne l'est pas.
     */
    socket.on(
      'recuperer-joker',
      (
        payload: { carteReelleId?: string; combinaisonId?: string; carteJokerId?: string },
        ack: unknown,
      ) => {
        repondre(ack, () => {
          const { table, joueurId } = manager.placeDeLaSocket(socket.id);
          const coup = coupEnCours(table);
          const tour = table.tourEnCours;

          if (tour === null || tour.joueurId !== joueurId) {
            throw new Error('Il faut piocher avant de recuperer un joker');
          }
          if (
            typeof payload?.combinaisonId !== 'string' ||
            typeof payload.carteJokerId !== 'string' ||
            typeof payload.carteReelleId !== 'string'
          ) {
            throw new Error('Joker cible ou carte reelle manquant');
          }
          const carteReelleId = payload.carteReelleId;
          const engageeAilleurs =
            tour.poses.some((pose) => pose.cartes.some((cp) => cp.carte.id === carteReelleId)) ||
            tour.ajouts.some((ajout) => ajout.cartes.some((cp) => cp.carte.id === carteReelleId));
          if (engageeAilleurs) {
            throw new Error('Reprenez d abord la pose qui utilise cette carte');
          }

          const echange = {
            combinaisonId: payload.combinaisonId,
            carteJokerId: payload.carteJokerId,
            carteReelleId,
          };
          // Tout se vérifie avant d'écrire : un échange refusé ne laisse rien
          // derrière lui, ni dans le brouillon ni chez les autres.
          appliquerEchanges(coup, { ...tour, echangesJoker: [...tour.echangesJoker, echange] });

          tour.echangesJoker = [...tour.echangesJoker, echange];
          publier(io, manager, table);
        });
      },
    );

    /**
     * Annule un échange de joker : le joker retrouve sa place sur la table, la
     * vraie carte revient au joueur.
     *
     * L'échange n'ayant jamais quitté le brouillon du tour, les autres joueurs
     * n'en ont rien vu et n'en verront rien. Refusé tant que le joker est
     * engagé dans une pose ou un ajout en préparation : il faut la reprendre
     * d'abord.
     */
    socket.on('annuler-echange-joker', (payload: { carteJokerId?: string }, ack: unknown) => {
      repondre(ack, () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const tour = table.tourEnCours;

        if (tour === null || tour.joueurId !== joueurId) {
          throw new Error('Aucun echange de joker a annuler');
        }
        if (tour.echangesJoker.length === 0) {
          throw new Error('Aucun joker recupere ce tour-ci');
        }

        const visee = payload?.carteJokerId ?? tour.echangesJoker.at(-1)?.carteJokerId;
        if (!tour.echangesJoker.some((echange) => echange.carteJokerId === visee)) {
          throw new Error('Ce joker n a pas ete recupere ce tour-ci');
        }
        if (visee !== undefined && jokerEngage(tour, visee)) {
          throw new Error('Reprenez d abord la pose qui utilise ce joker');
        }

        tour.echangesJoker = tour.echangesJoker.filter((echange) => echange.carteJokerId !== visee);
        publier(io, manager, table);
      });
    });

    /**
     * « Je compose une pose. »
     *
     * Le brouillon reste dans l'app jusqu'à la défausse ; ce signal dit
     * seulement au serveur que le joueur y travaille, pour qu'il reçoive, une
     * fois, la prolongation prévue par la table.
     */
    socket.on('composition-commencee', (_payload: unknown, ack: unknown) => {
      repondre(ack, () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const coup = coupEnCours(table);
        if (coup.phase !== 'jeu' || coup.joueurActifId !== joueurId) {
          throw new Error("Ce n'est pas a vous de jouer");
        }
        if (table.attenteDeJeu !== null) table.attenteDeJeu.composition = true;
      });
    });

    /**
     * Retourne une carte de l'étalage du tirage d'ouverture.
     *
     * Les cartes ont été tirées au démarrage ; chaque joueur retourne la sienne
     * lui-même, et les autres ne la voient qu'à cet instant.
     */
    socket.on('retourner-carte-tirage', (payload: { place?: unknown }, ack: unknown) => {
      repondre(ack, () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const tirage = table.tirageOuverture;
        if (tirage === null || table.coup?.numero !== 1) {
          throw new Error("Aucun tirage d'ouverture en cours");
        }
        table.retournementsTirage = retournerCarte(tirage, table.retournementsTirage, joueurId, payload?.place);
        publier(io, manager, table);
      });
    });

    /**
     * « Je suis prêt pour le coup suivant. »
     *
     * Le coup suivant n'est distribué que lorsque tous les joueurs assis l'ont
     * dit : chacun lit le décompte à son rythme, et personne ne se voit
     * redistribuer une main sous les yeux.
     */
    socket.on('pret-pour-suivant', (payload: { numero?: unknown } | undefined, ack: unknown) => {
      repondre(ack, async () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const resultat = table.resultatCoup;
        const numero = typeof payload?.numero === 'number' ? payload.numero : null;

        if (resultat === null) {
          // Une confirmation en double — second appui, renvoi après une
          // coupure — peut arriver après le départ du coup suivant : elle est
          // sans objet, pas en faute. Le client dit pour quel coup il confirme.
          const dejaJoues =
            table.variante === 'panier' ? (table.panier?.historique.length ?? 0) : (table.boule?.historique.length ?? 0);
          if (numero !== null && dejaJoues >= numero) return;
          throw new Error('Aucun coup termine a enchainer');
        }
        // Une confirmation pour un coup déjà passé ne vaut rien pour celui-ci.
        if (numero !== null && numero !== resultat.numero) return;
        // Au dernier coup, c'est « Terminer la Boule » : un geste personnel,
        // qui n'attend personne. Le décompte est déjà fait ; la Boule se clôt
        // aussitôt, et le groupe n'étant plus au complet, nul ne la rejoue —
        // même après l'avoir voulu. Les autres gardent leur écran de fin.
        if (resultat.derniereCoup) {
          if (resultat.rejouerAnnulePar === null) resultat.rejouerAnnulePar = joueurId;
          if (!resultat.prets.includes(joueurId)) resultat.prets = [...resultat.prets, joueurId];
          await enchainer(io, manager, table);
          publier(io, manager, table);
          return;
        }
        // Déjà prêt : la seconde confirmation est simplement acquittée.
        if (resultat.prets.includes(joueurId)) return;
        resultat.prets = [...resultat.prets, joueurId];

        const attendus = table.joueurs.map((joueur) => joueur.id);
        if (attendus.every((id) => resultat.prets.includes(id))) {
          await enchainer(io, manager, table);
        }
        publier(io, manager, table);
      });
    });

    /**
     * Rejouer une Boule avec le même groupe, une fois la sienne terminée.
     *
     * Chacun confirme depuis la fin de Boule ; tant que tous ne l'ont pas
     * fait, rien ne se passe, et l'état dit qui a confirmé. Un seul « Terminer
     * la Boule » y renonce pour tous. Confirmer vaut aussi « prêt » : la Boule
     * se clôt dès que chacun a répondu, par une nouvelle table si tous veulent
     * rejouer, sinon comme d'habitude.
     */
    socket.on('rejouer', (payload: { numero?: unknown } | undefined, ack: unknown) => {
      repondre(ack, async () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const resultat = table.resultatCoup;
        const numero = typeof payload?.numero === 'number' ? payload.numero : null;

        if (resultat === null) {
          // Un doublon arrivé après la relance : sans objet, pas en faute.
          if (table.relanceeVers !== undefined) return;
          // Close sans relance : quelqu'un a terminé la Boule.
          if (table.statut === 'terminee') throw new Error('Pas de nouvelle partie : la Boule est close');
          throw new Error('Aucune Boule terminee a rejouer');
        }
        if (numero !== null && numero !== resultat.numero) return;
        if (!resultat.derniereCoup) throw new Error("La Boule n'est pas terminee");
        if (resultat.rejouerAnnulePar !== null) {
          const nom = table.joueurs.find((joueur) => joueur.id === resultat.rejouerAnnulePar)?.nom;
          throw new Error(`Pas de nouvelle partie : ${nom ?? resultat.rejouerAnnulePar} a choisi de terminer`);
        }
        if (!resultat.rejouer.includes(joueurId)) resultat.rejouer = [...resultat.rejouer, joueurId];
        if (!resultat.prets.includes(joueurId)) resultat.prets = [...resultat.prets, joueurId];

        const attendus = table.joueurs.map((joueur) => joueur.id);
        if (attendus.every((id) => resultat.prets.includes(id))) {
          await enchainer(io, manager, table);
        }
        publier(io, manager, table);
      });
    });

    socket.on('disconnect', () => {
      const place = manager.detacherSocket(socket.id);
      if (place === null) return;

      // La place est conservee : le joueur peut revenir avec son jeton. Si la
      // table l'attendait, son absence est mise sous minuteur.
      publier(io, manager, place.table);
    });
  });
};

/** Publie l'état d'une table depuis l'extérieur des handlers (endpoints HTTP). */
export const publierTable = (io: Server, manager: GameRoomManager, table: Table): void => {
  publier(io, manager, table);
};
