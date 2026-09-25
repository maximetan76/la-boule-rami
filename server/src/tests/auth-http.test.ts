import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { io as clientIo } from 'socket.io-client';
import { EMETTEUR_APPLE } from '../auth/apple.js';
import { secretDepuisTexte } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { creerServeur, type Serveur } from '../server/index.js';
import { ouvrirTablePleine } from './aide-table.js';

/**
 * Parcours complet : jeton Apple → session applicative → place à une table.
 * Apple est simulé par une paire de clés locale, aucun appel réseau.
 */

const CLIENT_ID = 'fr.tb-formations.laboule';
const SESSION = { secret: secretDepuisTexte('secret-de-test-du-serveur-de-la-boule') };

describe('authentification HTTP', () => {
  let serveur: Serveur;
  let depot: DepotMemoire;
  let base: string;
  let signerApple: (sujet: string, options?: { audience?: string }) => Promise<string>;

  beforeEach(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const cles: JWTVerifyGetKey = () => Promise.resolve(publicKey);
    signerApple = async (sujet, options = {}) =>
      new SignJWT({ email: `${sujet}@example.com`, email_verified: true })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(EMETTEUR_APPLE)
        .setAudience(options.audience ?? CLIENT_ID)
        .setSubject(sujet)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);

    depot = new DepotMemoire();
    serveur = creerServeur({ depot, session: SESSION, apple: { clientId: CLIENT_ID, cles } });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    base = `http://localhost:${String((serveur.httpServer.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
  });

  const poster = async (chemin: string, corps: unknown) => {
    const reponse = await fetch(`${base}${chemin}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corps),
    });
    return { statut: reponse.status, corps: (await reponse.json()) as Record<string, unknown> };
  };

  it('repond a la sonde de sante', async () => {
    const reponse = await fetch(`${base}/sante`);
    expect(reponse.status).toBe(200);
    expect(await reponse.json()).toEqual({ ok: true });
  });

  it('la sonde de sante dit le commit deploye quand la plateforme le donne', async () => {
    const avant = process.env['RENDER_GIT_COMMIT'];
    process.env['RENDER_GIT_COMMIT'] = 'a02b194f0e1d2c3b4a5968778695a4b3c2d1e0f9';
    try {
      const reponse = await fetch(`${base}/sante`);
      expect(await reponse.json()).toEqual({ ok: true, commit: 'a02b194' });
    } finally {
      if (avant === undefined) delete process.env['RENDER_GIT_COMMIT'];
      else process.env['RENDER_GIT_COMMIT'] = avant;
    }
  });

  it('ouvre une session a partir d un jeton Apple valide', async () => {
    const jetonIdentite = await signerApple('001.ana');
    const { statut, corps } = await poster('/auth/apple', { jetonIdentite, pseudo: 'Ana' });

    expect(statut).toBe(200);
    expect(typeof corps['jetonSession']).toBe('string');
    expect(corps['joueur']).toMatchObject({ pseudo: 'Ana' });
  });

  it('retrouve le meme joueur a la connexion suivante', async () => {
    const jetonIdentite = await signerApple('001.ana');
    const premiere = await poster('/auth/apple', { jetonIdentite, pseudo: 'Ana' });
    const seconde = await poster('/auth/apple', { jetonIdentite });

    const premierJoueur = premiere.corps['joueur'] as { id: string; pseudo: string };
    const secondJoueur = seconde.corps['joueur'] as { id: string; pseudo: string };
    expect(secondJoueur.id).toBe(premierJoueur.id);
    // Apple ne transmet le nom qu a la premiere connexion : le pseudo tient.
    expect(secondJoueur.pseudo).toBe('Ana');
  });

  it('un compte neuf n a pas encore choisi son pseudo ; le choisir leve le drapeau', async () => {
    const jetonIdentite = await signerApple('001.sans-nom');
    // Apple n'a pas transmis de nom : le serveur applique son défaut.
    const { corps } = await poster('/auth/apple', { jetonIdentite });
    const jeton = corps['jetonSession'] as string;
    expect(corps['joueur']).toMatchObject({ pseudo: 'Joueur', pseudoChoisi: false });

    const lire = async () => {
      const reponse = await fetch(`${base}/joueur/moi`, { headers: { authorization: `Bearer ${jeton}` } });
      expect(reponse.status).toBe(200);
      return ((await reponse.json()) as { joueur: Record<string, unknown> }).joueur;
    };
    // Relu à chaque lancement : tant qu'il n'a pas choisi, l'app le lui demande.
    expect(await lire()).toMatchObject({ pseudoChoisi: false });

    const renomme = await fetch(`${base}/joueur/pseudo`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` },
      body: JSON.stringify({ pseudo: 'Maxime' }),
    });
    expect(((await renomme.json()) as { joueur: Record<string, unknown> }).joueur).toMatchObject({
      pseudo: 'Maxime',
      pseudoChoisi: true,
    });
    expect(await lire()).toMatchObject({ pseudo: 'Maxime', pseudoChoisi: true });
  });

  it('un nom venu d Apple ne dispense pas du choix : il ne sert qu a pre-remplir', async () => {
    const { corps } = await poster('/auth/apple', { jetonIdentite: await signerApple('001.ana'), pseudo: 'Ana' });
    expect(corps['joueur']).toMatchObject({ pseudo: 'Ana', pseudoChoisi: false });
  });

  it('le compte de demonstration a son nom d office, sans rien a choisir', async () => {
    const { corps } = await poster('/auth/demo', {});
    expect(corps['joueur']).toMatchObject({ pseudoChoisi: true });
  });

  it('refuse un jeton Apple destine a une autre application', async () => {
    const jetonIdentite = await signerApple('001.ana', { audience: 'fr.autre.app' });
    const { statut, corps } = await poster('/auth/apple', { jetonIdentite, pseudo: 'Ana' });

    expect(statut).toBe(401);
    // Le detail de l echec ne fuit pas vers le client.
    expect(JSON.stringify(corps)).not.toMatch(/aud|jose|signature/i);
  });

  it('refuse une requete sans jeton', async () => {
    expect((await poster('/auth/apple', {})).statut).toBe(401);
  });

  it('renouvelle un jeton de session encore valide', async () => {
    const jetonIdentite = await signerApple('001.ana');
    const { corps } = await poster('/auth/apple', { jetonIdentite, pseudo: 'Ana' });

    const renouvelle = await poster('/auth/renouveler', { jeton: corps['jetonSession'] });
    expect(renouvelle.statut).toBe(200);
    expect(typeof renouvelle.corps['jetonSession']).toBe('string');

    expect((await poster('/auth/renouveler', { jeton: 'pas-un-jeton' })).statut).toBe(401);
  });

  it('ignore une ressource inconnue', async () => {
    const reponse = await fetch(`${base}/inconnu`);
    expect(reponse.status).toBe(404);
  });

  it('mene du jeton Apple jusqu a une place a la table', async () => {
    // Trois joueurs s'authentifient, puis s'assoient avec leur jeton de session.
    const sessions = await Promise.all(
      ['001.ana', '001.bo', '001.cy'].map(async (sujet, index) => {
        const jetonIdentite = await signerApple(sujet);
        const { corps } = await poster('/auth/apple', {
          jetonIdentite,
          pseudo: ['Ana', 'Bo', 'Cy'][index],
        });
        return {
          jeton: corps['jetonSession'] as string,
          joueur: corps['joueur'] as { id: string; pseudo: string },
        };
      }),
    );

    const { tableId } = await ouvrirTablePleine(
      serveur.manager,
      sessions.map((session) => ({ id: session.joueur.id, pseudo: session.joueur.pseudo })),
    );

    const etats: unknown[] = [];
    const sockets = await Promise.all(
      sessions.map(
        async (session) =>
          new Promise<ReturnType<typeof clientIo>>((resolve) => {
            const socket = clientIo(base, { transports: ['websocket'] });
            socket.on('etat', (etat: unknown) => etats.push(etat));
            socket.on('connect', () => {
              socket.emit('rejoindre-table', { jeton: session.jeton, tableId }, () => {
                resolve(socket);
              });
            });
          }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    // Chacun a recu au moins sa vue : le coup est distribue.
    expect(etats.length).toBeGreaterThanOrEqual(3);
    for (const socket of sockets) socket.disconnect();

    // La partie est bien inscrite en base sous ces trois joueurs.
    const actives = await depot.chargerPartiesActives();
    expect(actives[0]?.partie.joueursIds.sort()).toEqual(
      sessions.map((session) => session.joueur.id).sort(),
    );
  });
});
