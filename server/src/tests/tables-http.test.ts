import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { EMETTEUR_APPLE } from '../auth/apple.js';
import { secretDepuisTexte } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { ALPHABET_CODE, LONGUEUR_CODE } from '../server/game-room-manager.js';
import { creerServeur, type Serveur } from '../server/index.js';

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

    it('refuse un nombre de joueurs hors des regles', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      expect(
        (await appeler('POST', '/tables', { compte: ana, corps: { nombreJoueurs: 2 } })).statut,
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

    it('refuse d ouvrir un second salon a un joueur deja engage', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      await appeler('POST', '/tables', { compte: ana });

      const { statut, corps } = await appeler('POST', '/tables', { compte: ana });
      expect(statut).toBe(400);
      expect(corps['erreur']).toMatch(/deja engage/i);
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

    it('refuse un joueur engage sur une autre table', async () => {
      const ana = await ouvrirCompte('001.ana', 'Ana');
      const bo = await ouvrirCompte('001.bo', 'Bo');
      const { code } = await ouvrirSalon(ana);
      await appeler('POST', '/tables', { compte: bo });

      const { statut, corps } = await appeler('POST', '/tables/rejoindre', {
        compte: bo,
        corps: { code },
      });
      expect(statut).toBe(400);
      expect(corps['erreur']).toMatch(/deja engage/i);
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
