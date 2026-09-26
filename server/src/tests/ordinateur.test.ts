import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { creerServeur, type Serveur } from '../server/index.js';
import { secretDepuisTexte, signerJetonSession } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { GameRoomManager, type Minuteur } from '../server/game-room-manager.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';
import type { Coup } from '../models/index.js';

/**
 * Réf. docs/REGLES.md § « Le panier ». Une partie contre l'ordinateur : le
 * joueur la crée seul, l'ordinateur s'assied aussitôt, et le serveur joue pour
 * lui — la stratégie du panier, par le même mécanisme que les robots de la
 * démonstration.
 */

const SESSION = { secret: secretDepuisTexte('secret-de-test-de-l-ordinateur') };

/** Un minuteur qu'on déclenche à la main : les gestes de l'ordinateur, un à un. */
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

describe("le panier contre l'ordinateur", () => {
  let serveur: Serveur;
  let depot: DepotMemoire;
  let port: number;
  let horloge: ReturnType<typeof minuteurFactice>;
  let socket: ClientSocket | null;

  beforeEach(async () => {
    horloge = minuteurFactice();
    depot = new DepotMemoire();
    serveur = creerServeur({
      minuteur: horloge.minuteur,
      session: SESSION,
      apple: { clientId: 'fr.tb-formations.laboule' },
      depot,
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

  /**
   * Des délais courts, et le sursis d'absence par défaut : le minuteur factice
   * déclenche tout ce qui attend. L'ordinateur ne doit jamais s'y voir jouer
   * d'office, comme un absent — il joue lui-même.
   */
  const DELAIS_COURTS = { annonceMs: 30_000, jeuMs: 60_000, prolongationMs: 0 };

  const creer = async (corps: Record<string, unknown>) => {
    depot.inscrire('p-ana', 'Ana');
    const jeton = await signerJetonSession('p-ana', SESSION);
    const reponse = await fetch(`http://localhost:${String(port)}/tables`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jeton}`, 'content-type': 'application/json' },
      body: JSON.stringify({ delais: DELAIS_COURTS, ...corps }),
    });
    return { jeton, statut: reponse.status, corps: (await reponse.json()) as Record<string, unknown> };
  };

  const emettre = async (evenement: string, charge: unknown) =>
    new Promise<{ ok: boolean; erreur?: string }>((resolve) => {
      (socket as ClientSocket).emit(evenement, charge, resolve);
    });

  it("crée la table avec l'ordinateur déjà assis, tenu par le serveur, et le retient", async () => {
    const { statut, corps } = await creer({ variante: 'panier', adversaire: 'ordinateur', manchesAGagner: 2 });
    expect(statut).toBe(201);
    expect(corps['statut']).toBe('en-cours');

    const table = serveur.manager.table(corps['tableId'] as string);
    expect(table.joueurs.map((joueur) => joueur.nom).sort()).toEqual(['Ana', 'Ordinateur']);
    const ordinateur = table.joueurs.find((joueur) => joueur.nom === 'Ordinateur');
    expect(ordinateur !== undefined && table.bots.has(ordinateur.id)).toBe(true);
    expect(table.bots.has('p-ana')).toBe(false);

    // Un redémarrage du serveur ne le fait pas oublier : il reprend sa place.
    const apresRedemarrage = new GameRoomManager({ depot });
    await apresRedemarrage.recharger();
    const rechargee = apresRedemarrage.table(table.id);
    expect([...rechargee.bots]).toEqual([...table.bots]);
  });

  it("refuse un adversaire inconnu, et reste une table à deux joueurs humains sans l'option", async () => {
    expect((await creer({ variante: 'panier', adversaire: 'martien' })).statut).toBe(400);
    const { corps } = await creer({ variante: 'panier' });
    expect(corps['statut']).toBe('salon');
    expect(serveur.manager.table(corps['tableId'] as string).bots.size).toBe(0);
  });

  it("l'ordinateur retourne sa carte, parle, joue ses tours et finit par gagner la manche", async () => {
    const { jeton, corps } = await creer({ variante: 'panier', adversaire: 'ordinateur', manchesAGagner: 2 });
    const tableId = corps['tableId'] as string;
    const etats: EtatCoupFiltre[] = [];
    socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    socket.on('etat', (etat: EtatCoupFiltre) => etats.push(etat));
    await new Promise<void>((resolve) => {
      (socket as ClientSocket).on('connect', () => {
        resolve();
      });
    });
    expect((await emettre('rejoindre-table', { jeton, tableId })).ok).toBe(true);
    await patienter(20);

    const table = serveur.manager.table(tableId);
    const coup = (): Coup => {
      if (table.coup === null) throw new Error('coup absent');
      return table.coup;
    };

    // Le tirage d'ouverture : l'ordinateur retourne sa carte de lui-même.
    horloge.declencher();
    await patienter(20);
    const ordinateurId = [...table.bots][0] as string;
    expect(table.retournementsTirage.get(ordinateurId)?.length ?? 0).toBeGreaterThan(0);

    // Ana joue le plus simplement du monde : « je joue », talon, et elle jette
    // la carte qu'elle vient de prendre. L'ordinateur, lui, joue pour gagner.
    for (let geste = 0; geste < 600 && table.resultatCoup === null; geste += 1) {
      const attendu = coup().phase === 'annonces' ? (coup().aParler ?? coup().joueurActifId) : coup().joueurActifId;
      if (attendu === 'p-ana') {
        if (coup().phase === 'annonces') {
          await emettre('annoncer', { annonce: 'je-joue' });
        } else {
          await emettre('piocher', { source: 'pioche' });
          const piochee = table.tourEnCours?.cartePiochee;
          const aJeter =
            piochee?.type === 'normale'
              ? piochee
              : (coup().mains['p-ana'] ?? []).find((carte) => carte.type === 'normale');
          expect((await emettre('defausser', { carteId: aJeter?.id })).ok).toBe(true);
        }
      } else {
        horloge.declencher();
      }
      await patienter(2);
    }

    // La manche est gagnée par l'ordinateur : ses 14 cartes posées, sa 15e jetée.
    expect(table.resultatCoup?.score.gagnantId).toBe(ordinateurId);
    // Son temps ne se compte pas : il ne réfléchit pas, il attend son minuteur.
    expect(table.panier?.tempsDeJeu?.[ordinateurId]).toBeUndefined();
    expect(table.panier?.manchesGagnees[ordinateurId]).toBe(1);
    const posees = coup().combinaisons.flatMap((combinaison) => combinaison.cartes);
    expect(posees).toHaveLength(14);

    // L'entracte : l'ordinateur demande la suite de lui-même, Ana aussi, et la
    // manche suivante est distribuée.
    expect((await emettre('pret-pour-suivant', { numero: 1 })).ok).toBe(true);
    horloge.declencher();
    await patienter(20);
    expect(table.resultatCoup).toBeNull();
    expect(coup().numero).toBe(2);
  }, 30_000);

  it("en fin de match, qu'Ana veuille rejouer, et l'ordinateur la suit : nouvelle table, lui toujours robot", async () => {
    const { jeton, corps } = await creer({ variante: 'panier', adversaire: 'ordinateur', manchesAGagner: 1 });
    const tableId = corps['tableId'] as string;
    socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => {
      (socket as ClientSocket).on('connect', () => {
        resolve();
      });
    });
    expect((await emettre('rejoindre-table', { jeton, tableId })).ok).toBe(true);
    await patienter(20);
    const table = serveur.manager.table(tableId);
    const ordinateurId = [...table.bots][0] as string;

    // Le match se joue jusqu'au bout : Ana pioche et jette, l'ordinateur joue.
    for (let geste = 0; geste < 800 && table.resultatCoup === null; geste += 1) {
      const coup = table.coup as Coup;
      const attendu = coup.phase === 'annonces' ? (coup.aParler ?? coup.joueurActifId) : coup.joueurActifId;
      if (attendu === 'p-ana') {
        if (coup.phase === 'annonces') {
          await emettre('annoncer', { annonce: 'je-joue' });
        } else {
          await emettre('piocher', { source: 'pioche' });
          const piochee = table.tourEnCours?.cartePiochee;
          const aJeter =
            piochee?.type === 'normale' ? piochee : (coup.mains['p-ana'] ?? []).find((carte) => carte.type === 'normale');
          await emettre('defausser', { carteId: aJeter?.id });
        }
      } else {
        horloge.declencher();
      }
      await patienter(2);
    }
    expect(table.resultatCoup?.derniereCoup).toBe(true);

    // Sans vote d'Ana, l'ordinateur ne fait rien : « Terminer » lui appartient.
    horloge.declencher();
    await patienter(10);
    expect(table.resultatCoup?.rejouer).toEqual([]);

    // Ana veut rejouer : l'ordinateur suit, et une nouvelle table naît avec lui.
    expect((await emettre('rejouer', { numero: table.resultatCoup?.numero })).ok).toBe(true);
    horloge.declencher();
    await patienter(20);
    expect(table.relanceeVers).toBeDefined();
    const suivante = serveur.manager.table(table.relanceeVers as string);
    expect([...suivante.bots]).toEqual([ordinateurId]);
    expect(suivante.variante).toBe('panier');
  }, 30_000);
});
