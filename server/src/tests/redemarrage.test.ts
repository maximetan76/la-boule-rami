import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { secretDepuisTexte, signerJetonSession } from '../auth/session.js';
import { creerServeur, type Serveur } from '../server/index.js';
import { ouvrirTablePleine } from './aide-table.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { EtatIllisibleError, lireEnCours, serialiserBoule } from '../persistence/serialisation.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';
import type { Table } from '../server/game-room-manager.js';
import type { Carte, Variante } from '../models/index.js';

/**
 * Un redémarrage du serveur en pleine partie — un redéploiement — reprend
 * chaque table au dernier tour joué : mains, annonces, combinaisons posées,
 * entracte. Seul le brouillon d'un tour entamé se perd, et son joueur le
 * rejoue. Comme en production : deux serveurs successifs sur le même dépôt, les
 * joueurs se reconnectant par socket au second.
 */

const SESSION = { secret: secretDepuisTexte('secret-de-test-du-redemarrage') };
const JOUEURS = [
  { id: 'p-ana', pseudo: 'Ana' },
  { id: 'p-bo', pseudo: 'Bo' },
  { id: 'p-cy', pseudo: 'Cy' },
];

const patienter = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const emettre = async (socket: ClientSocket, evenement: string, charge: unknown) =>
  new Promise<{ ok: boolean; erreur?: string }>((resolve) => {
    socket.emit(evenement, charge, resolve);
  });

/** Ce qu'un redémarrage doit rendre à l'identique. */
const instantane = (table: Table) =>
  structuredClone({
    coup: table.coup,
    resultat: table.resultatCoup,
    jokersGardes: Object.fromEntries(table.jokersGardes),
  });

/** Toutes les cartes d'un coup, où qu'elles soient. */
const toutesLesCartes = (table: Table): Carte[] => {
  const coup = table.coup;
  if (coup === null) return [];
  return [
    ...Object.values(coup.mains).flat(),
    ...coup.pioche,
    ...coup.defausse,
    ...coup.combinaisons.flatMap((combinaison) => combinaison.cartes.map((posee) => posee.carte)),
  ];
};

describe('redemarrage du serveur en pleine partie', () => {
  const serveurs: Serveur[] = [];
  const sockets: ClientSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    for (const serveur of serveurs.splice(0)) {
      serveur.io.close();
      await new Promise<void>((resolve) => {
        serveur.httpServer.close(() => {
          resolve();
        });
      });
    }
  });

  /** Un serveur sur le dépôt, qui reprend ses parties comme au vrai démarrage. */
  const demarrer = async (depot: DepotMemoire) => {
    const serveur = creerServeur({ depot, session: SESSION, apple: { clientId: 'test' } });
    serveurs.push(serveur);
    await serveur.manager.recharger();
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    const base = `http://localhost:${String((serveur.httpServer.address() as AddressInfo).port)}`;
    return { serveur, base };
  };

  /**
   * Ce que fait un redéploiement à l'ancien serveur : il écrit ce qui est en
   * vol, puis coupe ses connexions.
   */
  const arreter = async (serveur: Serveur) => {
    await serveur.manager.attendreLesEcritures();
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
    serveurs.splice(serveurs.indexOf(serveur), 1);
  };

  /** Chaque joueur se connecte et rejoint la table ; son dernier état est gardé. */
  const connecterTous = async (base: string, tableId: string, joueurs = JOUEURS) => {
    const etats = new Map<string, EtatCoupFiltre>();
    const parJoueur = new Map<string, ClientSocket>();
    for (const inscrit of joueurs) {
      const socket = clientIo(base, { transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      socket.on('etat', (etat: EtatCoupFiltre) => etats.set(inscrit.id, etat));
      await new Promise<void>((resolve) => {
        socket.on('connect', () => {
          resolve();
        });
      });
      const jeton = await signerJetonSession(inscrit.id, SESSION);
      expect((await emettre(socket, 'rejoindre-table', { jeton, tableId })).ok).toBe(true);
      parJoueur.set(inscrit.id, socket);
    }
    await patienter(60);
    return { etats, socketDe: (joueurId: string) => parJoueur.get(joueurId) as ClientSocket };
  };

  /** Une partie ouverte, tout le monde assis et connecté : la donne est faite. */
  const partieEnCours = async (options: { variante?: Variante; joueurs?: typeof JOUEURS } = {}) => {
    const joueurs = options.joueurs ?? JOUEURS;
    const depot = new DepotMemoire();
    for (const inscrit of joueurs) depot.inscrire(inscrit.id, inscrit.pseudo);
    const premier = await demarrer(depot);
    const { tableId } = await ouvrirTablePleine(premier.serveur.manager, joueurs, {
      ...(options.variante === undefined ? {} : { variante: options.variante }),
    });
    const connexions = await connecterTous(premier.base, tableId, joueurs);
    const table = () => premier.serveur.manager.table(tableId);
    return { depot, premier, tableId, table, joueurs, ...connexions };
  };

  /** « Je joue » de chacun à qui revient la parole, jusqu'au jeu. */
  const ouvrirLeJeu = async (table: () => Table, socketDe: (id: string) => ClientSocket) => {
    for (let essai = 0; essai < 6 && table().coup?.phase === 'annonces'; essai += 1) {
      const aParler = table().coup?.aParler as string;
      expect((await emettre(socketDe(aParler), 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
    }
    expect(table().coup?.phase).toBe('jeu');
  };

  /** Un tour ordinaire : pioche au talon, défausse de la première carte ordinaire. */
  const jouerUnTour = async (table: () => Table, socketDe: (id: string) => ClientSocket) => {
    const actif = table().coup?.joueurActifId as string;
    expect((await emettre(socketDe(actif), 'piocher', { source: 'pioche' })).ok).toBe(true);
    const aJeter = (table().coup?.mains[actif] ?? []).find((carte) => carte.type === 'normale');
    expect((await emettre(socketDe(actif), 'defausser', { carteId: aJeter?.id })).ok).toBe(true);
  };

  it('La Boule : mains, annonces et combinaisons posees reviennent a l identique', async () => {
    const { depot, premier, tableId, table, socketDe } = await partieEnCours();
    await ouvrirLeJeu(table, socketDe);
    await jouerUnTour(table, socketDe);
    await jouerUnTour(table, socketDe);

    // Le joueur actif ouvre : trois combinaisons, 64 points et deux tierces franches.
    const actif = table().coup?.joueurActifId as string;
    const carte = (couleur: string, valeur: number | string): Carte =>
      ({ type: 'normale', id: `pose-${couleur}-${String(valeur)}`, couleur, valeur }) as Carte;
    const coeur = [carte('coeur', 'D'), carte('coeur', 'R'), carte('coeur', 'A')];
    const pique = [carte('pique', 7), carte('pique', 8), carte('pique', 9)];
    const trois = [carte('pique', 3), carte('carreau', 3), carte('trefle', 3)];
    const coup = table().coup;
    if (coup === null) throw new Error('coup absent');
    coup.mains[actif] = [...coeur, ...pique, ...trois, ...(coup.mains[actif] ?? [])];

    expect((await emettre(socketDe(actif), 'piocher', { source: 'pioche' })).ok).toBe(true);
    const ids = (cartes: Carte[]) => cartes.map((c) => ({ carteId: c.id }));
    expect(
      (
        await emettre(socketDe(actif), 'poser', {
          poses: [
            { type: 'tierce', couleur: 'coeur', cartes: ids(coeur) },
            { type: 'tierce', couleur: 'pique', cartes: ids(pique) },
            { type: 'ensemble', valeur: 3, cartes: ids(trois) },
          ],
        })
      ).ok,
    ).toBe(true);
    const aJeter = (table().coup?.mains[actif] ?? []).find(
      (c) => c.type === 'normale' && !c.id.startsWith('pose-'),
    );
    expect((await emettre(socketDe(actif), 'defausser', { carteId: aJeter?.id })).ok).toBe(true);
    await jouerUnTour(table, socketDe);

    const avant = instantane(table());
    expect(avant.coup?.combinaisons).toHaveLength(3);

    // Redéploiement : l'ancien serveur s'arrête, le nouveau reprend la base.
    await arreter(premier.serveur);
    const second = await demarrer(depot);
    const { etats, socketDe: socketDuSecond } = await connecterTous(second.base, tableId);
    const reprise = second.serveur.manager.table(tableId);

    expect(instantane(reprise)).toEqual(avant);
    // Et chacun le voit : sa main exacte, les trois combinaisons sur la table.
    for (const inscrit of JOUEURS) {
      expect(etats.get(inscrit.id)?.moi.main).toEqual(avant.coup?.mains[inscrit.id]);
      expect(etats.get(inscrit.id)?.combinaisons).toHaveLength(3);
      expect(etats.get(inscrit.id)?.coup.joueurActifId).toBe(avant.coup?.joueurActifId);
    }
    // La partie continue normalement sur le nouveau serveur.
    await jouerUnTour(() => second.serveur.manager.table(tableId), socketDuSecond);
    expect(second.serveur.manager.table(tableId).coup?.numeroTour).toBeGreaterThanOrEqual(avant.coup?.numeroTour ?? 0);
  }, 20_000);

  it('une annonce faite, aucun tour joue : elle n est pas oubliee', async () => {
    const { depot, premier, tableId, table, socketDe } = await partieEnCours();
    const aParler = table().coup?.aParler as string;
    expect((await emettre(socketDe(aParler), 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
    const avant = instantane(table());
    expect(avant.coup?.annonces[aParler]).toBe('je-joue');

    await arreter(premier.serveur);
    const second = await demarrer(depot);
    await connecterTous(second.base, tableId);

    const reprise = second.serveur.manager.table(tableId);
    expect(instantane(reprise)).toEqual(avant);
    expect(reprise.coup?.annonces[aParler]).toBe('je-joue');
  }, 20_000);

  it('un tour entame et non defausse : reprise au dernier tour complet, sans carte perdue ni doublee', async () => {
    const { depot, premier, tableId, table, socketDe } = await partieEnCours();
    await ouvrirLeJeu(table, socketDe);
    await jouerUnTour(table, socketDe);
    const avant = instantane(table());

    // Le joueur actif pioche, puis le serveur s'arrête avant sa défausse.
    const actif = table().coup?.joueurActifId as string;
    expect((await emettre(socketDe(actif), 'piocher', { source: 'pioche' })).ok).toBe(true);
    expect(table().tourEnCours).not.toBeNull();

    await arreter(premier.serveur);
    const second = await demarrer(depot);
    const { socketDe: socketDuSecond } = await connecterTous(second.base, tableId);
    const reprise = () => second.serveur.manager.table(tableId);

    // Le coup est celui d'avant la pioche : sa carte est encore au talon.
    expect(instantane(reprise())).toEqual(avant);
    expect(reprise().tourEnCours).toBeNull();
    const cartes = toutesLesCartes(reprise());
    expect(cartes).toHaveLength(109);
    expect(new Set(cartes.map((c) => c.id)).size).toBe(109);

    // Le même joueur rejoue son tour, normalement.
    expect(reprise().coup?.joueurActifId).toBe(actif);
    await jouerUnTour(reprise, socketDuSecond);
    expect(reprise().coup?.joueurActifId).not.toBe(actif);
    expect(new Set(toutesLesCartes(reprise()).map((c) => c.id)).size).toBe(109);
  }, 20_000);

  it('le panier : la manche en cours revient a l identique', async () => {
    const joueurs = JOUEURS.slice(0, 2);
    const { depot, premier, tableId, table, socketDe } = await partieEnCours({ variante: 'panier', joueurs });
    await ouvrirLeJeu(table, socketDe);
    await jouerUnTour(table, socketDe);
    await jouerUnTour(table, socketDe);
    await jouerUnTour(table, socketDe);
    const avant = instantane(table());
    expect(avant.coup?.defausse.length).toBeGreaterThan(0);

    await arreter(premier.serveur);
    const second = await demarrer(depot);
    const { etats } = await connecterTous(second.base, tableId, joueurs);

    expect(instantane(second.serveur.manager.table(tableId))).toEqual(avant);
    for (const inscrit of joueurs) expect(etats.get(inscrit.id)?.moi.main).toEqual(avant.coup?.mains[inscrit.id]);
  }, 20_000);

  it('l entracte : le decompte et les joueurs deja prets reviennent, et la suite se distribue', async () => {
    const { depot, premier, tableId, table, socketDe } = await partieEnCours();
    await ouvrirLeJeu(table, socketDe);

    // Le joueur actif n'a plus rien en main : sa pioche le fait gagner.
    const actif = table().coup?.joueurActifId as string;
    const coup = table().coup;
    if (coup === null) throw new Error('coup absent');
    coup.mains[actif] = [];
    // Une carte ordinaire au-dessus du talon : un joker, lui, ne se défausse pas.
    const ordinaire = coup.pioche.findIndex((carte) => carte.type === 'normale');
    coup.pioche.unshift(...coup.pioche.splice(ordinaire, 1));
    expect((await emettre(socketDe(actif), 'piocher', { source: 'pioche' })).ok).toBe(true);
    const piochee = table().tourEnCours?.cartePiochee;
    expect((await emettre(socketDe(actif), 'defausser', { carteId: piochee?.id })).ok).toBe(true);
    expect(table().resultatCoup?.numero).toBe(1);

    // Ana a lu le décompte et demande la suite ; les autres pas encore.
    expect((await emettre(socketDe('p-ana'), 'pret-pour-suivant', { numero: 1 })).ok).toBe(true);
    const avant = instantane(table());
    expect(avant.resultat?.prets).toEqual(['p-ana']);

    await arreter(premier.serveur);
    const second = await demarrer(depot);
    const { etats, socketDe: socketDuSecond } = await connecterTous(second.base, tableId);
    const reprise = () => second.serveur.manager.table(tableId);

    expect(instantane(reprise())).toEqual(avant);
    // Chacun retrouve l'écran du décompte, pas une donne neuve.
    for (const inscrit of JOUEURS) expect(etats.get(inscrit.id)?.resultat?.numero).toBe(1);

    // Les deux autres demandent la suite : le coup 2 est distribué.
    for (const id of ['p-bo', 'p-cy']) {
      expect((await emettre(socketDuSecond(id), 'pret-pour-suivant', { numero: 1 })).ok).toBe(true);
    }
    await patienter(20);
    expect(reprise().resultatCoup).toBeNull();
    expect(reprise().coup?.numero).toBe(2);
  }, 20_000);

  it('pendant un redeploiement, l ancien serveur joue encore : le nouveau relit la base a l arrivee des joueurs', async () => {
    const { depot, premier, tableId, table, socketDe } = await partieEnCours();
    await ouvrirLeJeu(table, socketDe);
    const lueAuDemarrage = instantane(table());

    // Le nouveau serveur démarre et lit la base maintenant…
    const second = await demarrer(depot);
    expect(instantane(second.serveur.manager.table(tableId))).toEqual(lueAuDemarrage);

    // … mais l'ancien fait encore jouer deux tours avant de s'arrêter.
    await jouerUnTour(table, socketDe);
    await jouerUnTour(table, socketDe);
    const dernier = instantane(table());
    expect(dernier).not.toEqual(lueAuDemarrage);
    await arreter(premier.serveur);

    // Les joueurs arrivent sur le nouveau : ils retrouvent les deux tours joués.
    const { etats } = await connecterTous(second.base, tableId);
    expect(instantane(second.serveur.manager.table(tableId))).toEqual(dernier);
    expect(etats.get('p-ana')?.moi.main).toEqual(dernier.coup?.mains['p-ana']);
  }, 20_000);

  it('un coup en cours illisible en base : la partie se recharge quand meme, et le coup est redistribue', async () => {
    const { depot, premier, tableId, table, socketDe } = await partieEnCours();
    await ouvrirLeJeu(table, socketDe);
    await arreter(premier.serveur);

    // Une donnée abîmée : une phase qui n'existe pas.
    const boule = table().boule;
    if (boule === null) throw new Error('boule absente');
    const etat = serialiserBoule(boule, {
      coup: { ...(table().coup as NonNullable<Table['coup']>), phase: 'n-importe' as 'jeu' },
      resultat: null,
      jokersGardes: {},
    });
    await depot.enregistrerBoule(tableId, etat);

    const second = await demarrer(depot);
    expect(second.serveur.manager.table(tableId).coup).toBeNull();
    const { etats } = await connecterTous(second.base, tableId);
    // Comme avant : le coup repart d'une donne neuve, la partie n'est pas perdue.
    expect(second.serveur.manager.table(tableId).coup?.phase).toBe('annonces');
    expect(etats.get('p-ana')?.moi.main).toHaveLength(14);
  }, 20_000);
});

describe('lecture de ce qui se jouait', () => {
  it('rien d ecrit : null, comme un etat d avant', () => {
    expect(lireEnCours({ version: 1, historique: [] })).toBeNull();
  });

  it('refuse une donnee abimee plutot que de la jouer', () => {
    const coupValide = {
      numero: 1,
      donneurId: 'b',
      ordreJoueurs: ['a', 'b'],
      joueursSurLeCote: [],
      phase: 'jeu',
      annonces: { a: 'je-joue' },
      mains: { a: [{ type: 'normale', id: 'x', couleur: 'coeur', valeur: 7 }], b: [] },
      pioche: [],
      defausse: [],
      combinaisons: [],
      joueurActifId: 'a',
      numeroTour: 1,
      estFriche: false,
      recapitulatifs: { a: { toursAvecPose: [], aAjouteSurCombinaisonAutrui: false } },
      gagnantId: null,
    };
    const lire = (coup: unknown) => () => lireEnCours({ enCours: { coup, resultat: null, jokersGardes: {} } });

    expect(lire(coupValide)()?.coup).toEqual(coupValide);
    expect(lire({ ...coupValide, phase: 'sieste' })).toThrow(EtatIllisibleError);
    expect(lire({ ...coupValide, mains: { a: [] } })).toThrow(/mains\.b absente/);
    expect(lire({ ...coupValide, joueurActifId: 'z' })).toThrow(/pas assis/);
    expect(lire({ ...coupValide, annonces: { a: 'peut-etre' } })).toThrow(EtatIllisibleError);
    expect(lire({ ...coupValide, pioche: [{ type: 'dragon', id: 'y' }] })).toThrow(/type inconnu/);
  });
});
