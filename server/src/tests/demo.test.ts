import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { creerServeur, type Serveur } from '../server/index.js';
import { secretDepuisTexte } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import type { Minuteur } from '../server/game-room-manager.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';

/**
 * Le mode démonstration servi à la revue Apple : un compte ouvert sans Apple,
 * une table déjà démarrée, et deux joueurs tenus par le serveur qui jouent
 * leurs tours tout seuls.
 */

const SESSION = { secret: secretDepuisTexte('secret-de-test-de-la-demo') };

const minuteurFactice = () => {
  const programmes: { callback: () => void; annule: boolean }[] = [];
  const minuteur: Minuteur = {
    programmer(callback) {
      const entree = { callback, annule: false };
      programmes.push(entree);
      return () => {
        entree.annule = true;
      };
    },
  };
  /** Fait jouer les gestes en attente, pas ceux qu'ils arment à leur tour. */
  const declencher = () => {
    for (const entree of [...programmes]) {
      if (!entree.annule) {
        entree.annule = true;
        entree.callback();
      }
    }
  };
  return { minuteur, declencher };
};

const patienter = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('mode demonstration', () => {
  let serveur: Serveur;
  let port: number;
  let horloge: ReturnType<typeof minuteurFactice>;
  let socket: ClientSocket | null;

  beforeEach(async () => {
    horloge = minuteurFactice();
    serveur = creerServeur({
      minuteur: horloge.minuteur,
      session: SESSION,
      apple: { clientId: 'fr.tb-formations.laboule' },
      depot: new DepotMemoire(),
    });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    port = (serveur.httpServer.address() as AddressInfo).port;
    socket = null;
  });

  afterEach(async () => {
    socket?.disconnect();
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
  });

  const ouvrirLaDemo = async () => {
    const reponse = await fetch(`http://localhost:${String(port)}/auth/demo`, { method: 'POST' });
    expect(reponse.status).toBe(200);
    return (await reponse.json()) as {
      jetonSession: string;
      joueur: { id: string; pseudo: string };
      tableId: string;
      codeInvitation: string;
    };
  };

  const emettre = async (evenement: string, charge: unknown) =>
    new Promise<{ ok: boolean; erreur?: string }>((resolve) => {
      (socket as ClientSocket).emit(evenement, charge, resolve);
    });

  it('ouvre un compte Testeur et une table de trois joueurs, deux tenus par le serveur', async () => {
    const demo = await ouvrirLaDemo();

    expect(demo.joueur.pseudo).toBe('Testeur');
    expect(demo.jetonSession.length).toBeGreaterThan(20);

    const table = serveur.manager.table(demo.tableId);
    expect(table.statut).toBe('en-cours');
    expect(table.joueurs).toHaveLength(3);
    expect(table.bots.size).toBe(2);
    expect(table.joueurs.filter((joueur) => table.bots.has(joueur.id)).map((joueur) => joueur.nom))
      .toEqual(['Robot Bo', 'Robot Cy']);
    // Le compte du réviseur n'est pas un robot, et la table l'attend, lui seul.
    expect(table.bots.has(demo.joueur.id)).toBe(false);
  });

  it('distribue le coup des que le reviseur se connecte, sans attendre personne', async () => {
    const demo = await ouvrirLaDemo();
    const etats: EtatCoupFiltre[] = [];

    socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    socket.on('etat', (etat: EtatCoupFiltre) => etats.push(etat));
    await new Promise<void>((resolve) => {
      (socket as ClientSocket).on('connect', () => {
        resolve();
      });
    });
    expect((await emettre('rejoindre-table', { jeton: demo.jetonSession, tableId: demo.tableId })).ok).toBe(true);
    for (let essai = 0; essai < 100 && etats.length === 0; essai += 1) await patienter(5);

    const etat = etats.at(-1) as EtatCoupFiltre;
    expect(etat.coup.phase).toBe('annonces');
    expect(etat.moi.main).toHaveLength(14);
    expect(etat.adversaires).toHaveLength(2);
  });

  it('les robots annoncent puis jouent leur tour tout seuls, et la partie avance', async () => {
    const demo = await ouvrirLaDemo();
    socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => {
      (socket as ClientSocket).on('connect', () => {
        resolve();
      });
    });
    await emettre('rejoindre-table', { jeton: demo.jetonSession, tableId: demo.tableId });
    await patienter(20);

    const table = serveur.manager.table(demo.tableId);
    const coup = () => {
      if (table.coup === null) throw new Error('coup absent');
      return table.coup;
    };
    const parole = () => coup().ordreJoueurs.find((joueurId) => coup().annonces[joueurId] === undefined);

    // Les annonces : le réviseur dit « je joue » quand c'est à lui, les robots
    // parlent d'eux-mêmes quand leur minuteur tombe.
    for (let tour = 0; tour < 4 && coup().phase === 'annonces'; tour += 1) {
      if (parole() === demo.joueur.id) {
        await emettre('annoncer', { annonce: 'je-joue' });
      } else {
        horloge.declencher();
        await patienter(20);
      }
    }
    expect(coup().phase).toBe('jeu');

    // Le réviseur joue son tour : il pioche et défausse.
    const jouerPourLeReviseur = async () => {
      await emettre('piocher', { source: 'pioche' });
      const enMain = [...(coup().mains[demo.joueur.id] ?? []), table.tourEnCours?.cartePiochee]
        .filter((carte): carte is NonNullable<typeof carte> => carte !== undefined)
        .find((carte) => carte.type === 'normale');
      await emettre('defausser', { carteId: enMain?.id });
    };
    if (coup().joueurActifId === demo.joueur.id) await jouerPourLeReviseur();

    const defausseAvant = coup().defausse.length;
    const tourAvant = coup().numeroTour;
    for (let geste = 0; geste < 4; geste += 1) {
      horloge.declencher();
      await patienter(20);
    }

    // Les robots ont joué : la défausse a grossi, et la table est revenue au
    // réviseur sans que personne d'autre ait eu à intervenir.
    expect(coup().defausse.length).toBeGreaterThan(defausseAvant);
    expect(coup().joueurActifId).toBe(demo.joueur.id);
    expect(coup().numeroTour).toBeGreaterThanOrEqual(tourAvant);
  });
});
