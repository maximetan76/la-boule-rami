import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { creerServeur, type Serveur } from '../server/index.js';
import { secretDepuisTexte, signerJetonSession } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';
import type { Carte } from '../models/index.js';
import { c } from './fixtures.js';

/**
 * Le bouton « Passer » du tirage d'ouverture : le serveur retourne au hasard la
 * carte du joueur qui passe — à la vue de tous, comme s'il l'avait choisie —, et
 * ses retirages aussi. Personne n'attend un joueur qui ne touche à rien.
 *
 * Deux joueurs de panier, un tirage forcé : Ana tire un 5 puis un 9, Bo tire un
 * 5 puis un 10. Égalité 5-5, retirage : Ana serait donneuse.
 */

const SESSION = { secret: secretDepuisTexte('secret-de-test-du-passer') };

const patienter = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Attend qu'une condition soit vraie, au plus trois secondes : les états d'un autre joueur arrivent quand ils arrivent. */
const jusqua = async (condition: () => boolean) => {
  for (let essai = 0; essai < 150 && !condition(); essai += 1) await patienter(20);
};

describe('passer au tirage d’ouverture', () => {
  let serveur: Serveur;
  let port: number;
  let sockets: ClientSocket[];

  beforeEach(async () => {
    const depot = new DepotMemoire();
    depot.inscrire('p-ana', 'Ana');
    depot.inscrire('p-bo', 'Bo');
    serveur = creerServeur({ session: SESSION, apple: { clientId: 'fr.tb-formations.laboule' }, depot });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    port = (serveur.httpServer.address() as AddressInfo).port;
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.disconnect();
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
  });

  const emettre = async (socket: ClientSocket, evenement: string, charge: unknown) =>
    new Promise<{ ok: boolean; erreur?: string }>((resolve) => {
      socket.emit(evenement, charge, resolve);
    });

  /** Une table de panier à deux, tirage forcé, et ce que voit chacun. */
  const tirageForce = async () => {
    const poster = async (jeton: string, chemin: string, corps: unknown) =>
      (await (
        await fetch(`http://localhost:${String(port)}${chemin}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jeton}`, 'content-type': 'application/json' },
          body: JSON.stringify(corps),
        })
      ).json()) as Record<string, unknown>;
    const jetonAna = await signerJetonSession('p-ana', SESSION);
    const jetonBo = await signerJetonSession('p-bo', SESSION);
    const creee = await poster(jetonAna, '/tables', { variante: 'panier' });
    await poster(jetonBo, '/tables/rejoindre', { code: creee['codeInvitation'] });

    const vues: Record<string, EtatCoupFiltre | null> = { 'p-ana': null, 'p-bo': null };
    const relier = async (joueurId: string, jeton: string) => {
      const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
      sockets.push(socket);
      socket.on('etat', (etat: EtatCoupFiltre) => {
        vues[joueurId] = etat;
      });
      await new Promise<void>((resolve) => {
        socket.on('connect', () => {
          resolve();
        });
      });
      expect((await emettre(socket, 'rejoindre-table', { jeton, tableId: creee['tableId'] })).ok).toBe(true);
      return socket;
    };
    const ana = await relier('p-ana', jetonAna);
    const bo = await relier('p-bo', jetonBo);
    await jusqua(() => vues['p-ana'] !== null && vues['p-bo'] !== null);

    const table = serveur.manager.table(creee['tableId'] as string);
    const tirees: [string, Carte[]][] = [
      ['p-ana', [c('pique', 5), c('coeur', 9)]],
      ['p-bo', [c('coeur', 5), c('trefle', 10)]],
    ];
    table.tirageOuverture = {
      ordreTable: ['p-ana', 'p-bo'],
      donneurInitial: 'p-ana',
      cartesConserveesParJoueur: new Map(),
      cartesTirees: new Map(tirees),
    };
    table.retournementsTirage = new Map();

    /** Ce que voit Bo du tirage : les valeurs retournées par joueur, et qui doit encore toucher. */
    const vueDeBo = () => {
      const tirage = vues['p-bo']?.tirageOuverture;
      return {
        complet: tirage?.complet,
        aRetourner: tirage?.aRetourner,
        valeurs: Object.fromEntries(
          Object.entries(tirage?.retournees ?? {}).map(([joueurId, retournees]) => [
            joueurId,
            retournees.map((retournee) => (retournee.carte.type === 'normale' ? retournee.carte.valeur : '?')),
          ]),
        ),
      };
    };
    /** La première place de l'étalage encore face cachée : celle qu'un joueur touche, sans tomber sur une carte déjà retournée. */
    const libre = (): number => {
      const prises = new Set([...table.retournementsTirage.values()].flat());
      let place = 0;
      while (prises.has(place)) place += 1;
      return place;
    };
    return { ana, bo, table, vueDeBo, vues, libre };
  };

  it('égalité 5-5, retirage : Bo tire un 10, Ana passe — sa carte est retournée, personne n attend', async () => {
    const { ana, bo, vueDeBo } = await tirageForce();

    expect((await emettre(ana, 'retourner-carte-tirage', { place: 4 })).ok).toBe(true);
    expect((await emettre(bo, 'retourner-carte-tirage', { place: 20 })).ok).toBe(true);
    // Égalité : les deux doivent toucher une nouvelle carte.
    expect(vueDeBo().aRetourner).toEqual(expect.arrayContaining(['p-ana', 'p-bo']));

    expect((await emettre(bo, 'retourner-carte-tirage', { place: 30 })).ok).toBe(true);
    expect(vueDeBo()).toMatchObject({ complet: false, aRetourner: ['p-ana'] });

    // Ana appuie sur « Passer ».
    expect(await emettre(ana, 'passer-tirage', {})).toEqual({ ok: true });
    await jusqua(() => vueDeBo().complet === true);

    // Sa carte est retournée pour tous, comme si elle l'avait choisie : le tirage est fini.
    expect(vueDeBo()).toMatchObject({
      complet: true,
      aRetourner: [],
      valeurs: { 'p-ana': [5, 9], 'p-bo': [5, 10] },
    });
  });

  it('passer avant que l égalité ne se voie : le retirage d Ana est retourné pour elle', async () => {
    const { ana, bo, vueDeBo, libre } = await tirageForce();

    // Ana passe d'emblée : sa première carte part, au hasard, à la vue de tous.
    expect(await emettre(ana, 'passer-tirage', {})).toEqual({ ok: true });
    await jusqua(() => vueDeBo().valeurs['p-ana']?.length === 1);
    expect(vueDeBo()).toMatchObject({ complet: false, aRetourner: ['p-bo'], valeurs: { 'p-ana': [5], 'p-bo': [] } });

    // Bo retourne son 5 : égalité, retirage — Ana n'a rien à toucher, le serveur le fait.
    expect((await emettre(bo, 'retourner-carte-tirage', { place: libre() })).ok).toBe(true);
    await jusqua(() => vueDeBo().valeurs['p-ana']?.length === 2);
    expect(vueDeBo()).toMatchObject({ complet: false, aRetourner: ['p-bo'], valeurs: { 'p-ana': [5, 9], 'p-bo': [5] } });

    // Il ne reste que Bo : le tirage se termine dès qu'il a touché sa carte.
    expect((await emettre(bo, 'retourner-carte-tirage', { place: libre() })).ok).toBe(true);
    await jusqua(() => vueDeBo().complet === true);
    expect(vueDeBo()).toMatchObject({ complet: true, aRetourner: [], valeurs: { 'p-ana': [5, 9], 'p-bo': [5, 10] } });
  });

  it('passer après avoir retourné sa carte : le retirage à venir sera retourné pour lui', async () => {
    const { ana, bo, vueDeBo, libre } = await tirageForce();

    expect((await emettre(ana, 'retourner-carte-tirage', { place: 4 })).ok).toBe(true);
    // Ana attend Bo, et passe sans plus attendre : rien à retourner pour l'instant.
    expect(await emettre(ana, 'passer-tirage', {})).toEqual({ ok: true });
    await jusqua(() => vueDeBo().valeurs['p-ana']?.length === 1);
    expect(vueDeBo().valeurs).toEqual({ 'p-ana': [5], 'p-bo': [] });

    expect((await emettre(bo, 'retourner-carte-tirage', { place: libre() })).ok).toBe(true);
    await jusqua(() => vueDeBo().valeurs['p-ana']?.length === 2);
    expect(vueDeBo().valeurs).toEqual({ 'p-ana': [5, 9], 'p-bo': [5] });
    expect((await emettre(bo, 'retourner-carte-tirage', { place: libre() })).ok).toBe(true);
    await jusqua(() => vueDeBo().complet === true);
    expect(vueDeBo().complet).toBe(true);
  });

  it('ne dévoile rien de plus que ce que le joueur aurait retourné, et jamais deux fois la même place', async () => {
    const { ana, bo, table, libre } = await tirageForce();
    await emettre(ana, 'passer-tirage', {});
    expect((await emettre(bo, 'retourner-carte-tirage', { place: libre() })).ok).toBe(true);
    expect((await emettre(bo, 'retourner-carte-tirage', { place: libre() })).ok).toBe(true);
    const places = [...table.retournementsTirage.values()].flat();
    expect(places).toHaveLength(4);
    expect(new Set(places).size).toBe(4);
    expect(places.every((place) => Number.isInteger(place) && place >= 0 && place < 109)).toBe(true);
  });

  it('passer quand tout le monde a passé et que le tirage est fini est sans conséquence', async () => {
    const { ana, table } = await tirageForce();
    await emettre(ana, 'passer-tirage', {});
    const bo = sockets[1] as ClientSocket;
    await emettre(bo, 'passer-tirage', {});
    expect([...table.retournementsTirage.values()].flat()).toHaveLength(4);
    // Le tirage est complet : repasser ne change rien et ne fait pas d'erreur.
    const avant = JSON.stringify([...table.retournementsTirage]);
    expect(await emettre(ana, 'passer-tirage', {})).toEqual({ ok: true });
    expect(JSON.stringify([...table.retournementsTirage])).toBe(avant);
  });
});
