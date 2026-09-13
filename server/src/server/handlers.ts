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
  Valeur,
} from '../models/index.js';
import {
  calculerScoreCoup,
  detecterDoubleOuTriple,
  enregistrerResultatCoup,
  estBouleTerminee,
  jouerTour,
  echangerJoker,
  reformerTalon,
} from '../game-engine/index.js';
import { verifierJetonSession, type ConfigSession } from '../auth/session.js';
import { filtrerEtatPourJoueur } from './etat-filtre.js';
import type { ResultatCoupFiltre, VueEchanges } from './etat-filtre.js';
import type { TourEnCours } from './game-room-manager.js';
import {
  bouleEnCours,
  demarrerCoup,
  GameRoomManager,
  redistribuerCoup,
  type Table,
} from './game-room-manager.js';

/** Réponse d'acquittement renvoyée à l'émetteur de chaque action. */
export type Acquittement = (reponse: { ok: true } | { ok: false; erreur: string }) => void;

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

/** Le joueur dont c'est le tour de parole, ou `null` si tout le monde a parlé. */
const prochainAParler = (coup: Coup): JoueurId | null =>
  coup.ordreJoueurs.find((joueurId) => coup.annonces[joueurId] === undefined) ?? null;

/**
 * Le joueur que la table attend, selon la phase : celui qui doit parler pendant
 * les annonces, celui qui doit jouer ensuite. `null` si rien n'est attendu.
 */
const joueurAttendu = (coup: Coup): JoueurId | null => {
  if (coup.phase === 'annonces') return prochainAParler(coup);
  if (coup.phase === 'jeu') return coup.joueurActifId;
  return null;
};

/**
 * Enregistre une annonce et fait avancer le coup.
 *
 * § « Dès qu'un joueur annonce "Je joue" : c'est systématiquement le joueur
 * situé à la gauche du DONNEUR qui commence à jouer en premier. » Si tous
 * frichent, le coup est rejoué à la même place, avec le même donneur.
 */
const appliquerAnnonce = (table: Table, joueurId: JoueurId, annonce: Annonce): void => {
  const coup = table.coup;
  if (coup === null) return;

  coup.annonces = { ...coup.annonces, [joueurId]: annonce };

  if (annonce === 'je-joue') {
    coup.phase = 'jeu';
    coup.joueurActifId = coup.ordreJoueurs[0] as JoueurId;
    return;
  }
  if (prochainAParler(coup) === null) {
    table.boule = enregistrerResultatCoup(bouleEnCours(table), coup.numero, {
      toutLeMondeAFriche: true,
    });
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

  for (const joueurId of connectes) {
    const socketId = manager.socketDe(table, joueurId);
    if (socketId === null) continue;

    io.to(socketId).emit(
      'etat',
      filtrerEtatPourJoueur(coup, bouleEnCours(table), joueurId, {
        tableId: table.id,
        connectes,
        tourEnAttente: table.tourEnCours,
        resultat: resultatFiltre(table),
        echangesDuTour: echanges,
      }),
    );
  }
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
    mainsRevelees: Object.fromEntries(
      Object.entries(resultat.mains).map(([joueurId, cartes]) => [joueurId, [...cartes]]),
    ),
    prets: [...resultat.prets],
    derniereCoup: resultat.derniereCoup,
  };
};

/**
 * Clôt le coup : score, cumul dans la Boule, coup suivant s'il y a lieu.
 *
 * C'est l'un des deux moments où l'état part en base — l'autre étant la fin de
 * Boule. Entre deux, tout vit en mémoire : un redémarrage ne coûte que le coup
 * en cours, qui sera redistribué.
 */
const cloturerCoup = async (
  manager: GameRoomManager,
  table: Table,
  coup: Coup,
): Promise<void> => {
  const gagnantId = coup.gagnantId;
  if (gagnantId === null) return;

  const typeVictoire = detecterDoubleOuTriple(coup, gagnantId);
  const scoreCoup = calculerScoreCoup(coup, gagnantId, typeVictoire, coup.estFriche);
  table.boule = enregistrerResultatCoup(bouleEnCours(table), coup.numero, scoreCoup, {
    combinaisons: coup.combinaisons,
    mainsRevelees: coup.mains,
  });

  await manager.persister(table);

  // Le coup suivant n'est pas distribué ici : la donne effacerait le décompte
  // avant que personne ait pu le lire. La table entre en entracte, et n'en
  // sort que lorsque tous les joueurs ont demandé la suite.
  table.resultatCoup = {
    numero: coup.numero,
    score: scoreCoup,
    mains: Object.fromEntries(
      Object.entries(coup.mains).map(([joueurId, cartes]) => [joueurId, [...cartes]]),
    ),
    prets: [],
    derniereCoup: estBouleTerminee(bouleEnCours(table)),
  };
};

/**
 * Sort de l'entracte : distribue le coup suivant, ou clôt la partie.
 *
 * N'est appelée qu'une fois tous les joueurs prêts — c'est le sens même de
 * l'entracte.
 */
const enchainer = async (manager: GameRoomManager, table: Table): Promise<void> => {
  const derniere = table.resultatCoup?.derniereCoup ?? false;
  table.resultatCoup = null;

  if (derniere) {
    await manager.cloreLaPartie(table);
    return;
  }
  demarrerCoup(table);
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

  const aDefausser = coup.pioche[0];
  if (aDefausser === undefined) return null;

  const { coup: apres } = jouerTour(
    coup,
    joueurId,
    { source: 'pioche', carteDefausseeId: aDefausser.id },
    table.alea,
  );

  table.coup = apres;
  table.tourEnCours = null;
  return apres;
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
 * Publie le nouvel état : chacun reçoit sa vue, après réévaluation du sursis.
 * Toute action qui modifie la table passe par ici.
 */
const publier = (io: Server, manager: GameRoomManager, table: Table): void => {
  reevaluerSursis(io, manager, table);
  diffuserEtat(io, manager, table);
};

const repondre = (ack: unknown, action: () => void | Promise<void>): void => {
  const acquitter = typeof ack === 'function' ? (ack as Acquittement) : null;
  const echouer = (erreur: unknown): void => {
    acquitter?.({
      ok: false,
      erreur: erreur instanceof Error ? erreur.message : 'Erreur inconnue',
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
        const table = manager.attacherSocket(payload.tableId, joueurId, socket.id);

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

        if (coup.phase !== 'annonces') throw new Error("La phase d'annonces est close");
        if (payload?.annonce !== 'friche' && payload?.annonce !== 'je-joue') {
          throw new Error('Annonce invalide : « friche » ou « je-joue » attendus');
        }
        if (prochainAParler(coup) !== joueurId) {
          throw new Error(`Ce n'est pas a ${joueurId} de parler`);
        }

        appliquerAnnonce(table, joueurId, payload.annonce);
        publier(io, manager, table);
      });
    });

    socket.on('piocher', (payload: { source?: string }, ack: unknown) => {
      repondre(ack, () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const coup = coupEnCours(table);

        if (coup.phase !== 'jeu') throw new Error("Le coup n'est pas en phase de jeu");
        if (coup.joueurActifId !== joueurId) throw new Error(`Ce n'est pas au tour de ${joueurId}`);
        if (table.tourEnCours !== null) throw new Error('Vous avez deja pioche ce tour-ci');
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
          // tierce pure, carte collante...) revient a `jouerTour`, au moment de
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

        table.coup = apres;
        table.tourEnCours = null;
        if (apres.gagnantId !== null) await cloturerCoup(manager, table, apres);

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
     * « Je suis prêt pour le coup suivant. »
     *
     * Le coup suivant n'est distribué que lorsque tous les joueurs assis l'ont
     * dit : chacun lit le décompte à son rythme, et personne ne se voit
     * redistribuer une main sous les yeux.
     */
    socket.on('pret-pour-suivant', (_payload: unknown, ack: unknown) => {
      repondre(ack, async () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const resultat = table.resultatCoup;

        if (resultat === null) throw new Error('Aucun coup termine a enchainer');
        if (!resultat.prets.includes(joueurId)) resultat.prets = [...resultat.prets, joueurId];

        const attendus = table.joueurs.map((joueur) => joueur.id);
        if (attendus.every((id) => resultat.prets.includes(id))) {
          await enchainer(manager, table);
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
