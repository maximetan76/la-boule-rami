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
  numeroCoupCourant,
  recupererJoker,
  reformerTalon,
} from '../game-engine/index.js';
import { filtrerEtatPourJoueur } from './etat-filtre.js';
import { demarrerCoup, GameRoomManager, redistribuerCoup, type Table } from './game-room-manager.js';

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
  for (const carte of coup?.mains[joueurId] ?? []) disponibles.set(carte.id, carte);

  const tour = table.tourEnCours;
  if (tour !== null && tour.joueurId === joueurId) {
    disponibles.set(tour.cartePiochee.id, tour.cartePiochee);
  }
  return disponibles;
};

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
    table.boule = enregistrerResultatCoup(table.boule, coup.numero, {
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
  const coup = table.coup;
  if (coup === null) return;

  const connectes = manager.joueursConnectes(table);
  for (const joueurId of connectes) {
    const socketId = manager.socketDe(table, joueurId);
    if (socketId === null) continue;

    io.to(socketId).emit(
      'etat',
      filtrerEtatPourJoueur(coup, table.boule, joueurId, {
        tableId: table.id,
        connectes,
        tourEnAttente: table.tourEnCours,
      }),
    );
  }
};

/** Clôt le coup : score, cumul dans la Boule, et coup suivant s'il y a lieu. */
const cloturerCoup = (table: Table, coup: Coup): void => {
  const gagnantId = coup.gagnantId;
  if (gagnantId === null) return;

  const typeVictoire = detecterDoubleOuTriple(coup, gagnantId);
  const scoreCoup = calculerScoreCoup(coup, gagnantId, typeVictoire, coup.estFriche);
  table.boule = enregistrerResultatCoup(table.boule, coup.numero, scoreCoup);

  if (!estBouleTerminee(table.boule)) demarrerCoup(table);
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
const abandonnerTour = (table: Table, joueurId: JoueurId): void => {
  const coup = table.coup;
  if (coup === null || coup.phase !== 'jeu') return;
  if (coup.joueurActifId !== joueurId) return;
  if (table.tourEnCours !== null && table.tourEnCours.joueurId !== joueurId) return;

  const talon = reformerTalon(coup.pioche, coup.defausse, table.alea);
  coup.pioche = talon.pioche;
  coup.defausse = talon.defausse;

  const aDefausser = coup.pioche[0];
  if (aDefausser === undefined) return;

  const { coup: apres } = jouerTour(
    coup,
    joueurId,
    { source: 'pioche', carteDefausseeId: aDefausser.id },
    table.alea,
  );

  table.coup = apres;
  table.tourEnCours = null;
  if (apres.gagnantId !== null) cloturerCoup(table, apres);
};

/**
 * Ce que devient le tour d'un joueur absent quand son délai expire : un
 * « friche » pendant les annonces, l'abandon de son tour pendant le jeu.
 */
const expirerTour = (table: Table, joueurId: JoueurId): void => {
  const coup = table.coup;
  if (coup === null || joueurAttendu(coup) !== joueurId) return;

  if (coup.phase === 'annonces') {
    // Le silence vaut friche : la parole passe au joueur suivant, exactement
    // comme si le joueur avait annoncé lui-même.
    appliquerAnnonce(table, joueurId, 'friche');
    return;
  }
  abandonnerTour(table, joueurId);
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
    try {
      expirerTour(table, attendu);
    } catch {
      // Une expiration impossible ne doit pas faire tomber le serveur : la
      // table reste en l'état et le joueur peut encore revenir.
      return;
    }
    publier(io, manager, table);
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

const repondre = (ack: unknown, action: () => void): void => {
  const acquitter = typeof ack === 'function' ? (ack as Acquittement) : null;
  try {
    action();
    acquitter?.({ ok: true });
  } catch (erreur) {
    acquitter?.({
      ok: false,
      erreur: erreur instanceof Error ? erreur.message : 'Erreur inconnue',
    });
  }
};

export const enregistrerHandlers = (io: Server, manager: GameRoomManager): void => {
  io.on('connection', (socket: Socket) => {
    socket.on('rejoindre-table', (payload: { jeton?: string }, ack: unknown) => {
      repondre(ack, () => {
        if (typeof payload?.jeton !== 'string') throw new Error('Jeton manquant');
        const { table } = manager.attacherSocket(payload.jeton, socket.id);

        // Le premier coup part dès que tout le monde est là.
        if (table.coup === null && manager.tousConnectes(table)) demarrerCoup(table);
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

    socket.on('defausser', (payload: { carteId?: string }, ack: unknown) => {
      repondre(ack, () => {
        const { table, joueurId } = manager.placeDeLaSocket(socket.id);
        const coup = coupEnCours(table);
        const tour = table.tourEnCours;

        if (tour === null || tour.joueurId !== joueurId) {
          throw new Error('Il faut piocher avant de defausser');
        }
        if (typeof payload?.carteId !== 'string') throw new Error('Carte a defausser manquante');

        // Le moteur tranche : tant qu'il n'a pas rendu un nouvel etat, la table
        // reste exactement dans l'etat ou elle etait.
        const { coup: apres } = jouerTour(
          coup,
          joueurId,
          {
            source: tour.source,
            poses: tour.poses,
            ajouts: tour.ajouts,
            carteDefausseeId: payload.carteId,
          },
          table.alea,
        );

        table.coup = apres;
        table.tourEnCours = null;
        if (apres.gagnantId !== null) cloturerCoup(table, apres);

        publier(io, manager, table);
      });
    });

    socket.on(
      'recuperer-joker',
      (
        payload: {
          carteReelleId?: string;
          combinaisonId?: string;
          carteJokerId?: string;
          replacement?: CombinaisonProposee;
        },
        ack: unknown,
      ) => {
        repondre(ack, () => {
          const { table, joueurId } = manager.placeDeLaSocket(socket.id);
          const coup = coupEnCours(table);

          if (typeof payload?.combinaisonId !== 'string' || typeof payload.carteJokerId !== 'string') {
            throw new Error('Joker cible manquant');
          }
          if (payload.replacement === undefined) {
            throw new Error('Le joker recupere doit etre immediatement replace dans une combinaison');
          }

          const disponibles = cartesDuJoueur(table, joueurId);
          const carteReelle = resoudreCarte(disponibles, payload.carteReelleId);

          // Le joker vise est sur la table : on le relit depuis l'etat serveur.
          const cible = coup.combinaisons.find((comb) => comb.id === payload.combinaisonId);
          const jokerPose = cible?.cartes.find((cp) => cp.carte.id === payload.carteJokerId);
          if (jokerPose === undefined) throw new Error('Joker introuvable sur la table');
          disponibles.set(jokerPose.carte.id, jokerPose.carte);

          const replacement = construireCombinaison(
            payload.replacement,
            disponibles,
            joueurId,
            coup.numeroTour,
          );

          const { coup: apres } = recupererJoker(
            coup,
            joueurId,
            carteReelle,
            { combinaisonId: payload.combinaisonId, carteJokerId: payload.carteJokerId },
            replacement,
          );

          table.coup = apres;
          publier(io, manager, table);
        });
      },
    );

    socket.on('disconnect', () => {
      const place = manager.detacherSocket(socket.id);
      if (place === null) return;

      // La place est conservee : le joueur peut revenir avec son jeton. Si la
      // table l'attendait, son absence est mise sous minuteur.
      publier(io, manager, place.table);
    });
  });
};

/** Exposé pour les tests : numéro du coup attendu sur une table. */
export const numeroCoupAttendu = (table: Table): number => numeroCoupCourant(table.boule);
