import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { signerJetonSession } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { creerServeur, type Serveur } from '../server/index.js';

/**
 * Démarrage sans configuration Apple.
 *
 * Tant qu'aucun identifiant de service Apple n'existe, le serveur doit tourner
 * quand même : seule la route d'authentification Apple est hors service, tout
 * le reste — routes HTTP et WebSocket — fonctionne.
 */

describe('démarrage sans les variables Apple', () => {
  let serveur: Serveur;
  let depot: DepotMemoire;
  let base: string;
  let sockets: ClientSocket[];
  let avertissements: string[];
  const environnementInitial = { ...process.env };

  beforeEach(async () => {
    delete process.env['APPLE_CLIENT_ID'];
    delete process.env['JWT_SECRET'];
    delete process.env['NODE_ENV'];

    avertissements = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      avertissements.push(args.map(String).join(' '));
    });

    depot = new DepotMemoire();
    // Aucune configuration passée : tout doit venir de l'environnement, vide.
    serveur = creerServeur({ depot });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    base = `http://localhost:${String((serveur.httpServer.address() as AddressInfo).port)}`;
    sockets = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets) socket.disconnect();
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
    process.env = { ...environnementInitial };
  });

  const appeler = async (methode: string, chemin: string, options: { jeton?: string; corps?: unknown } = {}) => {
    const reponse = await fetch(`${base}${chemin}`, {
      method: methode,
      headers: {
        'content-type': 'application/json',
        ...(options.jeton === undefined ? {} : { authorization: `Bearer ${options.jeton}` }),
      },
      ...(options.corps === undefined ? {} : { body: JSON.stringify(options.corps) }),
    });
    return { statut: reponse.status, corps: (await reponse.json()) as Record<string, unknown> };
  };

  it('demarre sans lever d erreur', () => {
    expect(serveur.httpServer.listening).toBe(true);
    expect(serveur.apple).toBeNull();
  });

  it('avertit clairement que l authentification Apple est desactivee', () => {
    expect(avertissements.some((ligne) => /Apple non configuree/i.test(ligne))).toBe(true);
    expect(avertissements.some((ligne) => /endpoint desactive/i.test(ligne))).toBe(true);
  });

  it('previent aussi que le secret de session est ephemere', () => {
    expect(avertissements.some((ligne) => /JWT_SECRET absent/i.test(ligne))).toBe(true);
  });

  it('exige JWT_SECRET en production, ou rien ne serait verifiable d un deploiement a l autre', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => creerServeur({ depot })).toThrow(/JWT_SECRET/);
    delete process.env['NODE_ENV'];
  });

  it('repond a la sonde de sante', async () => {
    expect(await appeler('GET', '/sante')).toEqual({ statut: 200, corps: { ok: true } });
  });

  it('refuse l authentification Apple avec une erreur explicite, sans planter', async () => {
    const { statut, corps } = await appeler('POST', '/auth/apple', {
      corps: { jetonIdentite: 'peu-importe', pseudo: 'Ana' },
    });

    expect(statut).toBe(503);
    expect(corps['erreur']).toMatch(/APPLE_CLIENT_ID/);
    // Le serveur est toujours debout apres l'appel.
    expect((await appeler('GET', '/sante')).statut).toBe(200);
  });

  it('laisse les autres routes fonctionner normalement', async () => {
    const ana = depot.inscrire('p-ana', 'Ana');
    const jeton = await signerJetonSession(ana.id, serveur.session);

    // Creation de salon, invitation, situation du joueur : tout repond.
    const creation = await appeler('POST', '/tables', { jeton, corps: { nombreJoueurs: 3 } });
    expect(creation.statut).toBe(201);

    const situation = await appeler('GET', '/tables/moi', { jeton });
    expect(situation.corps['statut']).toBe('salon');

    const pseudo = await appeler('PATCH', '/joueur/pseudo', { jeton, corps: { pseudo: 'Anais' } });
    expect(pseudo.statut).toBe(200);

    // Et l'authentification reste exigee la ou elle doit l'etre.
    expect((await appeler('GET', '/tables/moi')).statut).toBe(401);
  });

  it('renouvelle un jeton de session sans Apple', async () => {
    const ana = depot.inscrire('p-ana', 'Ana');
    const jeton = await signerJetonSession(ana.id, serveur.session);

    const { statut, corps } = await appeler('POST', '/auth/renouveler', { corps: { jeton } });
    expect(statut).toBe(200);
    expect(typeof corps['jetonSession']).toBe('string');
  });

  it('laisse le WebSocket fonctionner', async () => {
    const joueurs = ['p-ana', 'p-bo', 'p-cy'].map((id, index) =>
      depot.inscrire(id, ['Ana', 'Bo', 'Cy'][index] as string),
    );
    const jetons = await Promise.all(
      joueurs.map(async (inscrit) => signerJetonSession(inscrit.id, serveur.session)),
    );

    const { corps: salon } = await appeler('POST', '/tables', {
      jeton: jetons[0] as string,
      corps: { nombreJoueurs: 3 },
    });
    const tableId = salon['tableId'] as string;
    for (const jeton of jetons.slice(1)) {
      await appeler('POST', '/tables/rejoindre', {
        jeton,
        corps: { code: salon['codeInvitation'] },
      });
    }

    const etats: unknown[] = [];
    for (const jeton of jetons) {
      const socket = clientIo(base, { transports: ['websocket'] });
      socket.on('etat', (etat: unknown) => etats.push(etat));
      await new Promise<void>((resolve) => {
        socket.on('connect', () => {
          resolve();
        });
      });
      const reponse = await new Promise<{ ok: boolean }>((resolve) => {
        socket.emit('rejoindre-table', { jeton, tableId }, resolve);
      });
      expect(reponse.ok).toBe(true);
      sockets.push(socket);
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
    // La donne a bien eu lieu : le jeu tourne sans Apple.
    expect(etats.length).toBeGreaterThanOrEqual(3);
    expect(serveur.manager.table(tableId).coup).not.toBeNull();
  });
});
