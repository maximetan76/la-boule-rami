import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { io as clientIo } from 'socket.io-client';
import { EMETTEUR_APPLE } from '../auth/apple.js';
import { secretDepuisTexte } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { PSEUDO_COMPTE_SUPPRIME } from '../persistence/depot.js';
import { creerServeur, type Serveur } from '../server/index.js';
import { ouvrirTablePleine } from './aide-table.js';

/**
 * Suppression de compte par anonymisation : le compte perd son identifiant
 * Apple et son pseudo, ses sessions ne valent plus rien, sa partie en cours est
 * abandonnée, et les parties partagées restent lisibles par les autres.
 * Apple est simulé par une paire de clés locale, aucun appel réseau.
 */

const CLIENT_ID = 'fr.tb-formations.laboule';
const SESSION = { secret: secretDepuisTexte('secret-de-test-du-serveur-de-la-boule') };

interface PartieListee {
  tableId: string;
  statut: string;
  abandonneParId: string | null;
  joueurs: { joueurId: string; pseudo: string }[];
}

describe('suppression de compte', () => {
  let serveur: Serveur;
  let depot: DepotMemoire;
  let base: string;
  let signerApple: (sujet: string) => Promise<string>;

  beforeEach(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const cles: JWTVerifyGetKey = () => Promise.resolve(publicKey);
    signerApple = async (sujet) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(EMETTEUR_APPLE)
        .setAudience(CLIENT_ID)
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

  const requete = async (
    methode: string,
    chemin: string,
    options: { jeton?: string; corps?: unknown } = {},
  ): Promise<{ statut: number; corps: Record<string, unknown> }> => {
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

  const connecter = async (sujet: string, pseudo: string) => {
    const { corps } = await requete('POST', '/auth/apple', {
      corps: { jetonIdentite: await signerApple(sujet), pseudo },
    });
    return { jeton: corps['jetonSession'] as string, joueur: corps['joueur'] as { id: string; pseudo: string } };
  };

  const rejoindre = async (jeton: string, tableId: string) => {
    const socket = clientIo(base, { transports: ['websocket'] });
    const reponse = await new Promise<{ ok: boolean; erreur?: string }>((resolve) => {
      socket.on('connect', () => {
        socket.emit('rejoindre-table', { jeton, tableId }, resolve);
      });
    });
    return { socket, reponse };
  };

  it('anonymise le compte, et le même identifiant Apple ouvre ensuite un compte neuf', async () => {
    const ana = await connecter('001.ana', 'Ana');

    expect((await requete('DELETE', '/joueur/compte', { jeton: ana.jeton })).statut).toBe(200);

    const anonyme = await depot.trouverJoueur(ana.joueur.id);
    expect(anonyme?.pseudo).toBe(PSEUDO_COMPTE_SUPPRIME);
    expect(anonyme?.identifiantApple).not.toBe('001.ana');
    expect(anonyme?.supprimeLe).toBeInstanceOf(Date);

    // Reconnexion avec le même compte Apple : un compte distinct, qui ne
    // retrouve rien de l'ancien.
    const retour = await connecter('001.ana', 'Ana revenue');
    expect(retour.joueur.id).not.toBe(ana.joueur.id);
    expect(retour.joueur.pseudo).toBe('Ana revenue');
    const parties = (await requete('GET', '/tables', { jeton: retour.jeton })).corps['parties'];
    expect(parties).toEqual([]);
  });

  it('invalide aussitôt toutes les sessions du joueur', async () => {
    const ana = await connecter('001.ana', 'Ana');
    const bo = await connecter('001.bo', 'Bo');
    const { tableId } = await ouvrirTablePleine(serveur.manager, [
      { id: ana.joueur.id, pseudo: 'Ana' },
      { id: bo.joueur.id, pseudo: 'Bo' },
    ]);
    // Ana est connectée à sa table au moment de la suppression.
    const { socket: connexionAna, reponse } = await rejoindre(ana.jeton, tableId);
    expect(reponse.ok).toBe(true);
    const coupee = new Promise<void>((resolve) => {
      connexionAna.on('disconnect', () => {
        resolve();
      });
    });

    expect((await requete('DELETE', '/joueur/compte', { jeton: ana.jeton })).statut).toBe(200);
    await coupee;

    // Le même jeton, encore bien signé, n'ouvre plus rien.
    expect((await requete('GET', '/tables/moi', { jeton: ana.jeton })).statut).toBe(401);
    expect((await requete('PATCH', '/joueur/pseudo', { jeton: ana.jeton, corps: { pseudo: 'Ana' } })).statut).toBe(401);
    expect((await requete('POST', '/auth/renouveler', { corps: { jeton: ana.jeton } })).statut).toBe(401);
    expect((await requete('DELETE', '/joueur/compte', { jeton: ana.jeton })).statut).toBe(401);

    const { socket, reponse: refus } = await rejoindre(ana.jeton, tableId);
    socket.disconnect();
    expect(refus.ok).toBe(false);
    expect(refus.erreur).toMatch(/supprime/i);

    // Bo, lui, n'est pas touché.
    expect((await requete('GET', '/tables', { jeton: bo.jeton })).statut).toBe(200);
  });

  it('abandonne la partie en cours, et les parties partagées restent lisibles sous « Joueur supprimé »', async () => {
    const ana = await connecter('001.ana', 'Ana');
    const bo = await connecter('001.bo', 'Bo');
    const places = [
      { id: ana.joueur.id, pseudo: 'Ana' },
      { id: bo.joueur.id, pseudo: 'Bo' },
    ];
    // Une partie déjà close entre Ana et Bo, puis une autre en cours.
    const close = await ouvrirTablePleine(serveur.manager, places);
    await serveur.manager.abandonner(close.tableId, bo.joueur.id);
    const enCours = await ouvrirTablePleine(serveur.manager, places);
    expect(serveur.manager.tableVivante(enCours.tableId)?.statut).toBe('en-cours');

    expect((await requete('DELETE', '/joueur/compte', { jeton: ana.jeton })).statut).toBe(200);

    // La partie en cours n'attend plus personne : abandonnée au nom d'Ana.
    expect(serveur.manager.tableVivante(enCours.tableId)).toBeNull();

    const parties = (await requete('GET', '/tables', { jeton: bo.jeton })).corps['parties'] as PartieListee[];
    expect(parties.map((partie) => partie.tableId).sort()).toEqual([close.tableId, enCours.tableId].sort());
    const abandonnee = parties.find((partie) => partie.tableId === enCours.tableId);
    expect(abandonnee?.statut).toBe('abandonnee');
    expect(abandonnee?.abandonneParId).toBe(ana.joueur.id);

    for (const partie of parties) {
      // Ana garde sa place dans l'archive, sous son pseudo anonymisé.
      expect(partie.joueurs.find((joueur) => joueur.joueurId === ana.joueur.id)?.pseudo).toBe(PSEUDO_COMPTE_SUPPRIME);
      expect(partie.joueurs.find((joueur) => joueur.joueurId === bo.joueur.id)?.pseudo).toBe('Bo');
      const historique = await requete('GET', `/tables/${partie.tableId}/historique`, { jeton: bo.jeton });
      expect(historique.statut).toBe(200);
    }
  });
});
