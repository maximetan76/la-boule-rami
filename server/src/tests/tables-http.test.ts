import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { EMETTEUR_APPLE } from '../auth/apple.js';
import { secretDepuisTexte } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { ALPHABET_CODE, LONGUEUR_CODE } from '../server/game-room-manager.js';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { creerServeur, type Serveur } from '../server/index.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';
import { enregistrerResultatCoup } from '../game-engine/boule.js';

/** Salons, invitations, abandon et pseudo, vus depuis l'API HTTP. */

const CLIENT_ID = 'fr.tb-formations.laboule';
const SESSION = { secret: secretDepuisTexte('secret-de-test-des-salons') };

interface Compte {
  readonly id: string;
  readonly pseudo: string;
  readonly jeton: string;
}

describe('API des tables', () => {
  let serveur: Serveur;
  let depot: DepotMemoire;
  let base: string;
  let ouvrirCompte: (sujet: string, pseudo: string) => Promise<Compte>;

  beforeEach(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const cles: JWTVerifyGetKey = () => Promise.resolve(publicKey);

    depot = new DepotMemoire();
    serveur = creerServeur({ depot, session: SESSION, apple: { clientId: CLIENT_ID, cles } });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    base = `http://localhost:${String((serveur.httpServer.address() as AddressInfo).port)}`;

    ouvrirCompte = async (sujet, pseudo) => {
      const jetonIdentite = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(EMETTEUR_APPLE)
        .setAudience(CLIENT_ID)
        .setSubject(sujet)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);

      const reponse = await fetch(`${base}/auth/apple`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jetonIdentite, pseudo }),
      });
      const corps = (await reponse.json()) as {
        jetonSession: string;
        joueur: { id: string; pseudo: string };
      };
      return { id: corps.joueur.id, pseudo: corps.joueur.pseudo, jeton: corps.jetonSession };
    };
  });

  afterEach(async () => {
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
  });

  const appeler = async (
    methode: string,
    chemin: string,
    options: { compte?: Compte; corps?: unknown } = {},
  ) => {
    const reponse = await fetch(`${base}${chemin}`, {
      method: methode,
      headers: {
        'content-type': 'application/json',
        ...(options.compte === undefined
          ? {}
          : { authorization: `Bearer ${options.compte.jeton}` }),
      },
      ...(options.corps === undefined ? {} : { body: JSON.stringify(options.corps) }),
    });
    return { statut: reponse.status, corps: (await reponse.json()) as Record<string, unknown> };
  };

  describe('POST /tables', () => {
    it('ouvre un salon avec un code d invitation lisible', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { statut, corps } = await appeler('POST', '/tables', { compte: ana });

      expect(statut).toBe(201);
      const code = corps['codeInvitation'] as string;
      expect(code).toHaveLength(LONGUEUR_CODE);
      // Ni 0/O ni 1/I/L : un code doit pouvoir se dicter.
      expect([...code].every((caractere) => ALPHABET_CODE.includes(caractere))).toBe(true);
      expect(corps['statut']).toBe('salon');
      expect(corps['createurId']).toBe(ana.id);
      expect(corps['joueurs']).toEqual([{ joueurId: ana.id, pseudo: 'Ana' }]);
    });

    it('accepte le nombre de joueurs et la gestion de deconnexion', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { corps } = await appeler('POST', '/tables', {
        compte: ana,
        corps: { nombreJoueurs: 5, gestionDeconnexion: { type: 'illimite' } },
      });

      expect(corps['capacite']).toBe(5);
      const table = serveur.manager.table(corps['tableId'] as string);
      expect(table.gestionDeconnexion).toEqual({ type: 'illimite' });
    });

    it('accepte une table a 2 joueurs', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { statut, corps } = await appeler('POST', '/tables', {
        compte: ana,
        corps: { nombreJoueurs: 2 },
      });

      expect(statut).toBe(201);
      expect(corps['capacite']).toBe(2);
    });

    it('demarre une partie des que le second joueur s assied', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { corps: salon } = await appeler('POST', '/tables', {
        compte: ana,
        corps: { nombreJoueurs: 2 },
      });

      const { corps } = await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code: salon['codeInvitation'] },
      });

      expect(corps['statut']).toBe('en-cours');
      const table = serveur.manager.table(salon['tableId'] as string);
      // Meme longueur de Boule qu'a 4 joueurs, et personne sur le cote.
      expect(table.boule?.nombreCoupsTotal).toBe(8);
      expect(table.joueurs).toHaveLength(2);
    });

    it('refuse un nombre de joueurs hors des regles', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      expect(
        (await appeler('POST', '/tables', { compte: ana, corps: { nombreJoueurs: 1 } })).statut,
      ).toBe(400);
      expect(
        (await appeler('POST', '/tables', { compte: ana, corps: { nombreJoueurs: 7 } })).statut,
      ).toBe(400);
    });

    it('refuse un delai de deconnexion absurde', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { statut } = await appeler('POST', '/tables', {
        compte: ana,
        corps: { gestionDeconnexion: { type: 'delai', dureeMs: -1 } },
      });
      expect(statut).toBe(400);
    });

    it('exige un jeton de session', async () => {
      expect((await appeler('POST', '/tables')).statut).toBe(401);
    });

    it('laisse ouvrir un second salon a un joueur deja assis ailleurs', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const premier = await appeler('POST', '/tables', { compte: ana });

      const { statut, corps } = await appeler('POST', '/tables', { compte: ana });
      expect(statut).toBe(201);
      expect(corps['tableId']).not.toBe(premier.corps['tableId']);
    });
  });

  describe('POST /tables/rejoindre', () => {
    const ouvrirSalon = async (compte: Compte, nombreJoueurs = 3) => {
      const { corps } = await appeler('POST', '/tables', {
        compte,
        corps: { nombreJoueurs },
      });
      return { tableId: corps['tableId'] as string, code: corps['codeInvitation'] as string };
    };

    it('assied le joueur sur une place libre', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { code } = await ouvrirSalon(ana);

      const { statut, corps } = await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code },
      });

      expect(statut).toBe(200);
      expect(corps['statut']).toBe('salon');
      expect((corps['joueurs'] as unknown[]).length).toBe(2);
    });

    it('demarre la partie des que la derniere place est prise', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const cy = await ouvrirCompte('001.cy', 'Cy');
      const { tableId, code } = await ouvrirSalon(ana);

      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });
      const { corps } = await appeler('POST', '/tables/rejoindre', { compte: cy, corps: { code } });

      expect(corps['statut']).toBe('en-cours');
      const table = serveur.manager.table(tableId);
      expect(table.boule).not.toBeNull();
      expect(table.boule?.nombreCoupsTotal).toBe(9);
      // L'ordre des sieges vient du tirage d'ouverture, pas de l'ordre d'arrivee.
      expect(table.joueurs.map((joueur) => joueur.id).sort()).toEqual([ana.id, bo.id, cy.id].sort());
    });

    it('accepte un code en minuscules ou entoure d espaces', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { code } = await ouvrirSalon(ana);

      const { statut } = await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code: ` ${code.toLowerCase()} ` },
      });
      expect(statut).toBe(200);
    });

    it('refuse un code inconnu', async () => {
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { statut, corps } = await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code: 'ZZZZZZ' },
      });

      expect(statut).toBe(400);
      expect(corps['erreur']).toMatch(/code/i);
    });

    it('refuse de rejoindre une partie deja commencee', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const cy = await ouvrirCompte('001.cy', 'Cy');
      const dee = await ouvrirCompte('001.dee', 'Dee');
      const { code } = await ouvrirSalon(ana);

      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });
      await appeler('POST', '/tables/rejoindre', { compte: cy, corps: { code } });

      const { statut, corps } = await appeler('POST', '/tables/rejoindre', {
        compte: dee,
        corps: { code },
      });
      expect(statut).toBe(400);
      expect(corps['erreur']).toMatch(/deja commence/i);
    });

    it('refuse un joueur deja assis a la meme table', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { code } = await ouvrirSalon(ana);

      const { statut, corps } = await appeler('POST', '/tables/rejoindre', {
        compte: ana,
        corps: { code },
      });
      expect(statut).toBe(400);
      expect(corps['erreur']).toMatch(/deja/i);
    });

    it('laisse rejoindre un joueur deja assis a une autre table', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { code } = await ouvrirSalon(ana);
      await appeler('POST', '/tables', { compte: bo });

      const { statut, corps } = await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code },
      });
      expect(statut).toBe(200);
      expect(corps['joueurs']).toHaveLength(2);
    });
  });

  describe('POST /tables/:id/abandonner', () => {
    it('clot la partie et libere ses joueurs', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { corps: salon } = await appeler('POST', '/tables', {
        compte: ana,
        corps: { nombreJoueurs: 3 },
      });
      const tableId = salon['tableId'] as string;
      await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code: salon['codeInvitation'] },
      });

      const { statut, corps } = await appeler('POST', `/tables/${tableId}/abandonner`, {
        compte: bo,
      });
      expect(statut).toBe(200);
      expect(corps['statut']).toBe('terminee');

      // La partie est close en base.
      expect(await depot.chargerPartiesActives()).toEqual([]);
      // Et les deux joueurs peuvent repartir sur une nouvelle table.
      expect((await appeler('POST', '/tables', { compte: ana })).statut).toBe(201);
      expect((await appeler('POST', '/tables', { compte: bo })).statut).toBe(201);
    });

    it('refuse un joueur qui n est pas a cette table', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const intrus = await ouvrirCompte('001.zed', 'Zed');
      const { corps } = await appeler('POST', '/tables', { compte: ana });

      const { statut } = await appeler('POST', `/tables/${String(corps['tableId'])}/abandonner`, {
        compte: intrus,
      });
      expect(statut).toBe(403);
    });

    it('repond 404 pour une table inconnue', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { statut } = await appeler('POST', '/tables/inexistante/abandonner', { compte: ana });
      expect(statut).toBe(404);
    });
  });

  describe('GET /tables/:id/historique', () => {
    const tableDeDeux = async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { corps: salon } = await appeler('POST', '/tables', {
        compte: ana,
        corps: { nombreJoueurs: 2 },
      });
      const tableId = salon['tableId'] as string;
      await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code: salon['codeInvitation'] },
      });
      return { ana, bo, tableId };
    };

    it('ne liste rien tant qu aucun coup n est joue', async () => {
      const { ana, tableId } = await tableDeDeux();

      const { statut, corps } = await appeler('GET', `/tables/${tableId}/historique`, { compte: ana });

      expect(statut).toBe(200);
      expect(corps['coups']).toEqual([]);
    });

    it('rend qui a pose quoi et les mains restantes des coups deja joues', async () => {
      const { ana, bo, tableId } = await tableDeDeux();
      const table = serveur.manager.table(tableId);
      if (table.boule === null) throw new Error('boule absente apres le remplissage');

      table.boule = enregistrerResultatCoup(
        table.boule,
        1,
        {
          gagnantId: ana.id,
          typeVictoire: 'simple',
          estFriche: false,
          multiplicateur: 1,
          scores: { [ana.id]: -10, [bo.id]: 40 },
          croixGagnees: {},
          chocolatId: null,
        },
        {
          combinaisons: [
            {
              id: 'comb-histo',
              type: 'tierce',
              proprietaireId: ana.id,
              tourDePose: 2,
              couleur: 'coeur',
              pure: true,
              cartes: [
                { carte: { type: 'normale', id: 'coeur-7-1', couleur: 'coeur', valeur: 7 }, remplace: null },
                { carte: { type: 'normale', id: 'coeur-8-1', couleur: 'coeur', valeur: 8 }, remplace: null },
                { carte: { type: 'normale', id: 'coeur-9-1', couleur: 'coeur', valeur: 9 }, remplace: null },
              ],
            },
          ],
          mainsRevelees: {
            [ana.id]: [],
            [bo.id]: [{ type: 'normale', id: 'pique-R-2', couleur: 'pique', valeur: 'R' }],
          },
        },
      );

      // Consultable par n'importe quel joueur de la table, a tout moment.
      const { statut, corps } = await appeler('GET', `/tables/${tableId}/historique`, { compte: bo });

      expect(statut).toBe(200);
      const coups = corps['coups'] as {
        numero: number;
        combinaisons: { proprietaireId: string }[];
        mainsRevelees: Record<string, unknown[]>;
        scores: Record<string, number>;
      }[];
      expect(coups).toHaveLength(1);
      expect(coups[0]?.numero).toBe(1);
      expect(coups[0]?.combinaisons[0]?.proprietaireId).toBe(ana.id);
      expect(coups[0]?.mainsRevelees[bo.id]).toHaveLength(1);
      expect(coups[0]?.scores[bo.id]).toBe(40);
    });

    it('refuse un joueur qui n est pas a cette table', async () => {
      const { tableId } = await tableDeDeux();
      const intrus = await ouvrirCompte('001.zed', 'Zed');

      const { statut } = await appeler('GET', `/tables/${tableId}/historique`, { compte: intrus });

      expect(statut).toBe(403);
    });

    it('repond 404 pour une table inconnue', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');

      const { statut } = await appeler('GET', '/tables/inexistante/historique', { compte: ana });

      expect(statut).toBe(404);
    });
  });

  /** Connecte une socket à une table et enregistre ce qu'elle reçoit. */
  const connecterSocket = async (compte: Compte, tableId: string) => {
    const socket = clientIo(base, { transports: ['websocket'] });
    const recus: { evenement: string; charge: unknown }[] = [];
    socket.onAny((evenement: string, charge: unknown) => {
      recus.push({ evenement, charge });
    });

    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      socket.emit('rejoindre-table', { jeton: compte.jeton, tableId }, () => {
        resolve();
      });
    });
    return { socket, recus };
  };

  const patienter = async (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  describe('abandon poussé aux joueurs connectés', () => {
    it('previent immediatement les sockets encore ouvertes', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { corps: salon } = await appeler('POST', '/tables', {
        compte: ana,
        corps: { nombreJoueurs: 3 },
      });
      const tableId = salon['tableId'] as string;
      await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code: salon['codeInvitation'] },
      });

      const cliente = await connecterSocket(ana, tableId);
      await patienter(40);
      cliente.recus.length = 0;

      // Bo abandonne : Ana l'apprend sans avoir rien demande.
      await appeler('POST', `/tables/${tableId}/abandonner`, { compte: bo });
      await patienter(60);

      const annonce = cliente.recus.find((recu) => recu.evenement === 'partie-abandonnee');
      expect(annonce).toBeDefined();
      const charge = annonce?.charge as Record<string, unknown>;
      expect(charge['tableId']).toBe(tableId);
      expect(charge['motif']).toBe('abandon');
      expect(charge['parJoueurId']).toBe(bo.id);
      expect(typeof charge['termineeLe']).toBe('string');

      cliente.socket.disconnect();
    });

    it('previent aussi celui qui declenche l abandon', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { corps: salon } = await appeler('POST', '/tables', {
        compte: ana,
        corps: { nombreJoueurs: 3 },
      });
      const tableId = salon['tableId'] as string;
      await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code: salon['codeInvitation'] },
      });

      const cliente = await connecterSocket(bo, tableId);
      await patienter(40);

      await appeler('POST', `/tables/${tableId}/abandonner`, { compte: bo });
      await patienter(60);

      expect(cliente.recus.some((recu) => recu.evenement === 'partie-abandonnee')).toBe(true);
      cliente.socket.disconnect();
    });
  });

  describe('POST /tables/:id/quitter', () => {
    const ouvrirSalonA = async (compte: Compte, nombreJoueurs = 3) => {
      const { corps } = await appeler('POST', '/tables', { compte, corps: { nombreJoueurs } });
      return { tableId: corps['tableId'] as string, code: corps['codeInvitation'] as string };
    };

    it('libere la place, le salon continuant pour les autres', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { tableId, code } = await ouvrirSalonA(ana);
      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });

      const { statut, corps } = await appeler('POST', `/tables/${tableId}/quitter`, { compte: bo });

      expect(statut).toBe(200);
      expect(corps['statut']).toBe('salon');
      expect(corps['placesOccupees']).toBe(1);
      // Le salon existe toujours, avec la place vacante.
      const table = serveur.manager.table(tableId);
      expect(table.joueurs.map((joueur) => joueur.id)).toEqual([ana.id]);
      expect(table.statut).toBe('salon');
    });

    it('rend la place reprenable par le meme joueur', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { tableId, code } = await ouvrirSalonA(ana);
      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });
      await appeler('POST', `/tables/${tableId}/quitter`, { compte: bo });

      const { statut } = await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });
      expect(statut).toBe(200);
      expect(serveur.manager.table(tableId).joueurs).toHaveLength(2);
    });

    it('rend la place reprenable par quelqu un d autre', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const cy = await ouvrirCompte('001.cy', 'Cy');
      const { tableId, code } = await ouvrirSalonA(ana);
      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });
      await appeler('POST', `/tables/${tableId}/quitter`, { compte: bo });

      const { statut } = await appeler('POST', '/tables/rejoindre', { compte: cy, corps: { code } });
      expect(statut).toBe(200);
      expect(serveur.manager.table(tableId).joueurs.map((joueur) => joueur.id)).toEqual([
        ana.id,
        cy.id,
      ]);
    });

    it('libere le joueur, qui peut alors rejoindre une AUTRE table', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const cy = await ouvrirCompte('001.cy', 'Cy');

      const premier = await ouvrirSalonA(ana);
      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code: premier.code } });
      const second = await ouvrirSalonA(cy);

      await appeler('POST', `/tables/${premier.tableId}/quitter`, { compte: bo });

      const { statut } = await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code: second.code },
      });
      expect(statut).toBe(200);
      expect(serveur.manager.table(second.tableId).joueurs).toHaveLength(2);
      // Et il peut aussi ouvrir sa propre table apres etre reparti.
      expect((await appeler('GET', '/tables/moi', { compte: bo })).corps['statut']).toBe('salon');
    });

    it('clot le salon quand le dernier joueur s en va', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { tableId } = await ouvrirSalonA(ana);

      await appeler('POST', `/tables/${tableId}/quitter`, { compte: ana });

      expect(await depot.chargerPartiesActives()).toEqual([]);
      expect((await appeler('GET', '/tables/moi', { compte: ana })).corps['statut']).toBe('aucune');
    });

    it('refuse de quitter une partie deja commencee', async () => {
      const comptes = await Promise.all([
        ouvrirCompte('001.ana', 'Ana'),
        ouvrirCompte('001.bo', 'Bo'),
        ouvrirCompte('001.cy', 'Cy'),
      ]);
      const { tableId, code } = await ouvrirSalonA(comptes[0] as Compte);
      for (const compte of comptes.slice(1)) {
        await appeler('POST', '/tables/rejoindre', { compte, corps: { code } });
      }

      const { statut, corps } = await appeler('POST', `/tables/${tableId}/quitter`, {
        compte: comptes[1] as Compte,
      });
      expect(statut).toBe(400);
      expect(corps['erreur']).toMatch(/abandon/i);
    });

    it('refuse de quitter une partie terminee', async () => {
      const comptes = await Promise.all([
        ouvrirCompte('001.ana', 'Ana'),
        ouvrirCompte('001.bo', 'Bo'),
        ouvrirCompte('001.cy', 'Cy'),
      ]);
      const { tableId, code } = await ouvrirSalonA(comptes[0] as Compte);
      for (const compte of comptes.slice(1)) {
        await appeler('POST', '/tables/rejoindre', { compte, corps: { code } });
      }
      await serveur.manager.cloreLaPartie(serveur.manager.table(tableId));

      const { statut, corps } = await appeler('POST', `/tables/${tableId}/quitter`, {
        compte: comptes[1] as Compte,
      });
      expect(statut).toBe(400);
      expect(corps['erreur']).toMatch(/terminee/i);
    });

    it('refuse un joueur qui n est pas a cette table', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const intrus = await ouvrirCompte('001.zed', 'Zed');
      const { tableId } = await ouvrirSalonA(ana);

      expect(
        (await appeler('POST', `/tables/${tableId}/quitter`, { compte: intrus })).statut,
      ).toBe(403);
    });

    it('repond 404 pour une table inconnue, et 401 sans jeton', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      expect(
        (await appeler('POST', '/tables/inexistante/quitter', { compte: ana })).statut,
      ).toBe(404);
      expect((await appeler('POST', '/tables/peu-importe/quitter')).statut).toBe(401);
    });
  });

  describe('GET /tables/moi', () => {
    const ouvrirSalon = async (compte: Compte, nombreJoueurs = 3) => {
      const { corps } = await appeler('POST', '/tables', { compte, corps: { nombreJoueurs } });
      return { tableId: corps['tableId'] as string, code: corps['codeInvitation'] as string };
    };

    it('dit clairement qu un joueur n est sur aucune table', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { statut, corps } = await appeler('GET', '/tables/moi', { compte: ana });

      expect(statut).toBe(200);
      expect(corps).toEqual({ statut: 'aucune' });
    });

    it('retrouve le salon en attente', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { tableId, code } = await ouvrirSalon(ana);
      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });

      const { corps } = await appeler('GET', '/tables/moi', { compte: bo });
      expect(corps['statut']).toBe('salon');
      expect((corps['table'] as Record<string, unknown>)['tableId']).toBe(tableId);
      expect((corps['table'] as Record<string, unknown>)['codeInvitation']).toBe(code);
    });

    it('retrouve la partie en cours, sans etat tant que la donne n a pas eu lieu', async () => {
      const comptes = await Promise.all([
        ouvrirCompte('001.ana', 'Ana'),
        ouvrirCompte('001.bo', 'Bo'),
        ouvrirCompte('001.cy', 'Cy'),
      ]);
      const { code } = await ouvrirSalon(comptes[0] as Compte);
      for (const compte of comptes.slice(1)) {
        await appeler('POST', '/tables/rejoindre', { compte, corps: { code } });
      }

      const { corps } = await appeler('GET', '/tables/moi', { compte: comptes[0] as Compte });
      expect(corps['statut']).toBe('en-cours');
      // Personne n'est connecte en socket : aucun coup n'est distribue.
      expect(corps['etat']).toBeNull();
      expect((corps['boule'] as Record<string, unknown>)['coupsJoues']).toBe(0);
      expect((corps['boule'] as Record<string, unknown>)['nombreCoupsTotal']).toBe(9);
    });

    it('rend l etat filtre du joueur une fois la donne faite', async () => {
      const comptes = await Promise.all([
        ouvrirCompte('001.ana', 'Ana'),
        ouvrirCompte('001.bo', 'Bo'),
        ouvrirCompte('001.cy', 'Cy'),
      ]);
      const { tableId, code } = await ouvrirSalon(comptes[0] as Compte);
      for (const compte of comptes.slice(1)) {
        await appeler('POST', '/tables/rejoindre', { compte, corps: { code } });
      }

      const sockets: ClientSocket[] = [];
      for (const compte of comptes) {
        const socket = clientIo(base, { transports: ['websocket'] });
        await new Promise<void>((resolve) => {
          socket.on('connect', () => {
            resolve();
          });
        });
        await new Promise<void>((resolve) => {
          socket.emit('rejoindre-table', { jeton: compte.jeton, tableId }, () => {
            resolve();
          });
        });
        sockets.push(socket);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));

      const ana = comptes[0] as Compte;
      const { corps } = await appeler('GET', '/tables/moi', { compte: ana });
      const etat = corps['etat'] as EtatCoupFiltre;

      expect(etat.moi.joueurId).toBe(ana.id);
      expect(etat.moi.main).toHaveLength(14);
      // Le filtrage vaut aussi par ce chemin : rien des mains adverses.
      const rendu = JSON.stringify(etat);
      const coup = serveur.manager.table(tableId).coup;
      for (const [joueurId, main] of Object.entries(coup?.mains ?? {})) {
        if (joueurId === ana.id) continue;
        for (const carte of main) expect(rendu).not.toContain(carte.id);
      }
      for (const carte of coup?.pioche ?? []) expect(rendu).not.toContain(carte.id);

      for (const socket of sockets) socket.disconnect();
    });

    it('retrouve la table apres un redemarrage du serveur', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { tableId, code } = await ouvrirSalon(ana);
      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });

      // Un second serveur sur le meme depot : le premier n'existe plus pour lui.
      const repris = creerServeur({ depot, session: SESSION, apple: { clientId: CLIENT_ID } });
      await repris.manager.recharger();
      await new Promise<void>((resolve) => {
        repris.httpServer.listen(0, resolve);
      });
      const baseReprise = `http://localhost:${String(
        (repris.httpServer.address() as { port: number }).port,
      )}`;

      const reponse = await fetch(`${baseReprise}/tables/moi`, {
        headers: { authorization: `Bearer ${ana.jeton}` },
      });
      const corps = (await reponse.json()) as Record<string, unknown>;

      expect(corps['statut']).toBe('salon');
      expect((corps['table'] as Record<string, unknown>)['tableId']).toBe(tableId);

      repris.io.close();
      await new Promise<void>((resolve) => {
        repris.httpServer.close(() => {
          resolve();
        });
      });
    });

    it('signale une partie abandonnee par un autre en son absence', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { tableId, code } = await ouvrirSalon(ana);
      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });

      // Bo abandonne pendant qu'Ana n'est pas connectee.
      await appeler('POST', `/tables/${tableId}/abandonner`, { compte: bo });

      const { corps } = await appeler('GET', '/tables/moi', { compte: ana });
      expect(corps['statut']).toBe('abandonnee');
      expect(corps['tableId']).toBe(tableId);
      expect(corps['codeInvitation']).toBe(code);
      expect(typeof corps['termineeLe']).toBe('string');
    });

    it('cesse de signaler l abandon des que le joueur repart sur une table', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { tableId, code } = await ouvrirSalon(ana);
      await appeler('POST', '/tables/rejoindre', { compte: bo, corps: { code } });
      await appeler('POST', `/tables/${tableId}/abandonner`, { compte: bo });

      expect((await appeler('GET', '/tables/moi', { compte: ana })).corps['statut']).toBe(
        'abandonnee',
      );

      await appeler('POST', '/tables', { compte: ana });
      expect((await appeler('GET', '/tables/moi', { compte: ana })).corps['statut']).toBe('salon');
    });

    it('ne signale rien apres une partie achevee normalement', async () => {
      const comptes = await Promise.all([
        ouvrirCompte('001.ana', 'Ana'),
        ouvrirCompte('001.bo', 'Bo'),
        ouvrirCompte('001.cy', 'Cy'),
      ]);
      const { tableId, code } = await ouvrirSalon(comptes[0] as Compte);
      for (const compte of comptes.slice(1)) {
        await appeler('POST', '/tables/rejoindre', { compte, corps: { code } });
      }

      // La Boule va jusqu'a son terme : rien d'anormal a signaler.
      await serveur.manager.cloreLaPartie(serveur.manager.table(tableId));

      const { corps } = await appeler('GET', '/tables/moi', { compte: comptes[0] as Compte });
      expect(corps).toEqual({ statut: 'aucune' });
    });

    it('exige un jeton de session', async () => {
      expect((await appeler('GET', '/tables/moi')).statut).toBe(401);
    });
  });

  describe('PATCH /joueur/pseudo', () => {
    it('change le pseudo en base et dans les tables en cours', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { corps: salon } = await appeler('POST', '/tables', { compte: ana });
      const tableId = salon['tableId'] as string;

      const { statut, corps } = await appeler('PATCH', '/joueur/pseudo', {
        compte: ana,
        corps: { pseudo: 'Anaïs' },
      });

      expect(statut).toBe(200);
      expect(corps['joueur']).toEqual({ id: ana.id, pseudo: 'Anaïs' });
      // La table deja en memoire porte le nouveau pseudo.
      expect(serveur.manager.table(tableId).joueurs[0]?.nom).toBe('Anaïs');
      // Et la base aussi.
      expect((await depot.trouverJoueur(ana.id))?.pseudo).toBe('Anaïs');
    });

    it('rogne les espaces autour du pseudo', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const { corps } = await appeler('PATCH', '/joueur/pseudo', {
        compte: ana,
        corps: { pseudo: '  Bea  ' },
      });
      expect((corps['joueur'] as { pseudo: string }).pseudo).toBe('Bea');
    });

    it('refuse un pseudo vide, trop court ou trop long', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      for (const pseudo of ['', '   ', 'A', 'x'.repeat(25)]) {
        const { statut } = await appeler('PATCH', '/joueur/pseudo', {
          compte: ana,
          corps: { pseudo },
        });
        expect(statut).toBe(400);
      }
    });

    it('exige un jeton de session', async () => {
      expect((await appeler('PATCH', '/joueur/pseudo', { corps: { pseudo: 'Bea' } })).statut).toBe(
        401,
      );
    });
  });
});
