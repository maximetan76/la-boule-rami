import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { creerServeur, type Serveur } from '../server/index.js';
import { secretDepuisTexte, signerJetonSession } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { DELAI_CONFIRMATION_MS } from '../server/handlers.js';
import type { Minuteur } from '../server/game-room-manager.js';
import { ouvrirTablePleine } from './aide-table.js';
import { c, recap, tierce } from './fixtures.js';
import type { JoueurId } from '../models/index.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';

/**
 * Le délai collectif de l'entracte. « Continuer » entre deux coups, « Rejouer
 * avec ce groupe » en fin de Boule : le premier clic humain lance 2 minutes,
 * que les clics suivants ne relancent pas ; passé ce délai, les clics humains
 * tombent et tout repart du prochain clic.
 */

const SESSION = { secret: secretDepuisTexte('secret-de-test-de-la-confirmation') };
const APPLE = { clientId: 'fr.tb-formations.laboule' };
const JOUEURS = [
  { id: 'p-ana', pseudo: 'Ana' },
  { id: 'p-bo', pseudo: 'Bo' },
  { id: 'p-cy', pseudo: 'Cy' },
];

interface Espion {
  readonly socket: ClientSocket;
  readonly joueurId: JoueurId;
  dernierEtat: EtatCoupFiltre | null;
  etatsRecus: number;
}

const emettre = async (socket: ClientSocket, evenement: string, payload: unknown) =>
  new Promise<{ ok: boolean; erreur?: string }>((resolve) => {
    socket.emit(evenement, payload, resolve);
  });

const patienter = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Des minuteurs qui n'avancent que sur ordre : le temps réel n'y est pour rien. */
const horlogeVirtuelle = () => {
  let ecoule = 0;
  const programmes: { callback: () => void; delaiMs: number; echeance: number; annule: boolean }[] = [];
  const minuteur: Minuteur = {
    programmer(callback, delaiMs) {
      const entree = { callback, delaiMs, echeance: ecoule + delaiMs, annule: false };
      programmes.push(entree);
      return () => {
        entree.annule = true;
      };
    },
  };
  const avancer = async (ms: number) => {
    const cible = ecoule + ms;
    for (;;) {
      const prochain = programmes
        .filter((entree) => !entree.annule && entree.echeance <= cible)
        .sort((a, b) => a.echeance - b.echeance)[0];
      if (prochain === undefined) break;
      ecoule = Math.max(ecoule, prochain.echeance);
      prochain.annule = true;
      prochain.callback();
      await patienter(10);
    }
    ecoule = cible;
  };
  const actifs = () => programmes.filter((entree) => !entree.annule).map((entree) => entree.delaiMs);
  return { minuteur, avancer, actifs };
};

describe("la confirmation collective de l'entracte", () => {
  let serveur: Serveur;
  let port: number;
  let espions: Espion[];
  let horloge: ReturnType<typeof horlogeVirtuelle>;

  beforeEach(async () => {
    horloge = horlogeVirtuelle();
    serveur = creerServeur({
      minuteur: horloge.minuteur,
      session: SESSION,
      apple: APPLE,
      depot: new DepotMemoire(),
    });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    port = (serveur.httpServer.address() as AddressInfo).port;
    espions = [];
  });

  afterEach(async () => {
    for (const espion of espions) espion.socket.disconnect();
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
  });

  const connecter = async (tableId: string, joueurId: JoueurId): Promise<Espion> => {
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    const espion: Espion = { socket, joueurId, dernierEtat: null, etatsRecus: 0 };
    socket.on('etat', (etat: EtatCoupFiltre) => {
      espion.dernierEtat = etat;
      espion.etatsRecus += 1;
    });
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });
    const jeton = await signerJetonSession(joueurId, SESSION);
    expect((await emettre(socket, 'rejoindre-table', { jeton, tableId })).ok).toBe(true);
    espions.push(espion);
    return espion;
  };

  const agir = async (espion: Espion, evenement: string, payload: unknown) => {
    const avant = espions.map((autre) => autre.etatsRecus);
    const reponse = await emettre(espion.socket, evenement, payload);
    if (!reponse.ok) return reponse;
    for (let essai = 0; essai < 100; essai += 1) {
      if (espions.every((autre, index) => autre.etatsRecus > (avant[index] as number))) break;
      await patienter(5);
    }
    return reponse;
  };

  /** Trois joueurs, un coup gagné : la table est en entracte (coup 1 sur plusieurs, ou le dernier). */
  const entracte = async (options: { derniereCoup?: boolean } = {}) => {
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS, {});
    for (const joueur of JOUEURS) await connecter(tableId, joueur.id);
    for (let essai = 0; essai < 200 && !espions.every((e) => e.etatsRecus > 0); essai += 1) await patienter(5);
    const table = serveur.manager.table(tableId);
    if (table.coup === null || table.boule === null) throw new Error('coup absent');
    if (options.derniereCoup === true) table.boule = { ...table.boule, nombreCoupsTotal: 1 };
    const [premier, second] = table.coup.ordreJoueurs as [JoueurId, JoueurId, JoueurId];
    const suite = tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)], second);
    const dix = c('coeur', 10);
    const aJeter = c('pique', 2);
    table.coup.combinaisons = [suite];
    table.coup.mains[premier] = [dix];
    table.coup.pioche.unshift(aJeter);
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });
    const gagnant = espion(premier);
    await agir(gagnant, 'annoncer', { annonce: 'je-joue' });
    await agir(gagnant, 'piocher', { source: 'pioche' });
    await emettre(gagnant.socket, 'poser', { ajouts: [{ combinaisonId: suite.id, cartes: [{ carteId: dix.id }] }] });
    await agir(gagnant, 'defausser', { carteId: aJeter.id });
    expect(table.resultatCoup?.derniereCoup).toBe(options.derniereCoup ?? false);
    const numero = table.resultatCoup?.numero as number;
    // La fin du coup se publie après une écriture asynchrone : chacun doit avoir
    // reçu le décompte avant le premier clic, sans quoi cet état tardif passerait
    // pour la réponse au clic.
    for (let essai = 0; essai < 400 && espions.some((e) => (e.dernierEtat?.resultat ?? null) === null); essai += 1) {
      await patienter(5);
    }
    const [ana, bo, cy] = JOUEURS.map((joueur) => espion(joueur.id)) as [Espion, Espion, Espion];
    return { table, numero, ana, bo, cy };
  };
  const espion = (joueurId: JoueurId) => espions.find((autre) => autre.joueurId === joueurId) as Espion;

  const confirmer = async (joueur: Espion, numero: number, evenement = 'pret-pour-suivant') =>
    agir(joueur, evenement, { numero });
  const deLaConfirmation = () => horloge.actifs().filter((delai) => delai === DELAI_CONFIRMATION_MS);

  it('le premier clic lance 2 minutes, et l état dit ce qu il en reste', async () => {
    const { table, numero, ana, bo } = await entracte();
    expect(deLaConfirmation()).toEqual([]);
    expect(bo.dernierEtat?.resultat?.echeance).toBeNull();

    expect((await confirmer(ana, numero)).ok).toBe(true);
    expect(deLaConfirmation()).toEqual([DELAI_CONFIRMATION_MS]);
    expect(table.resultatCoup?.prets).toEqual(['p-ana']);
    // Chacun le voit, pas seulement celui qui a cliqué.
    const echeance = bo.dernierEtat?.resultat?.echeance;
    expect(echeance?.dureeMs).toBe(DELAI_CONFIRMATION_MS);
    expect(echeance?.restantMs).toBeGreaterThan(DELAI_CONFIRMATION_MS - 5_000);
    expect(echeance?.restantMs).toBeLessThanOrEqual(DELAI_CONFIRMATION_MS);
  });

  it('un second clic ne relance rien : le délai reste fixé sur le premier', async () => {
    const { table, numero, ana, bo, cy } = await entracte();
    await confirmer(ana, numero);
    const fin = table.attenteDeSuite?.finLe;
    await horloge.avancer(60_000);
    await confirmer(bo, numero);

    // Toujours un seul délai, fixé sur le premier clic : l'échéance n'a pas bougé.
    expect(deLaConfirmation()).toEqual([DELAI_CONFIRMATION_MS]);
    expect(table.attenteDeSuite?.finLe).toBe(fin);
    expect(cy.dernierEtat?.resultat?.echeance).not.toBeNull();
  });

  it('un double clic du même joueur ne change rien au délai', async () => {
    const { table, numero, ana } = await entracte();
    await confirmer(ana, numero);
    const fin = table.attenteDeSuite?.finLe;
    await horloge.avancer(30_000);
    await confirmer(ana, numero);
    expect(table.resultatCoup?.prets).toEqual(['p-ana']);
    expect(deLaConfirmation()).toEqual([DELAI_CONFIRMATION_MS]);
    expect(table.attenteDeSuite?.finLe).toBe(fin);
  });

  it('2 minutes après le premier clic, tous les clics tombent — même celui donné à 1 min 59', async () => {
    const { table, numero, ana, bo, cy } = await entracte();
    await confirmer(ana, numero);
    await horloge.avancer(DELAI_CONFIRMATION_MS - 1_000);
    await confirmer(bo, numero);
    expect(table.resultatCoup?.prets).toEqual(['p-ana', 'p-bo']);

    await horloge.avancer(1_000);
    expect(table.resultatCoup?.prets).toEqual([]);
    expect(table.coup?.numero).toBe(1);
    expect(table.resultatCoup).not.toBeNull();
    // Chacun l'apprend : le décompte est sans clic, sans délai, avec qui a expiré.
    expect(cy.dernierEtat?.resultat?.prets).toEqual([]);
    expect(cy.dernierEtat?.resultat?.echeance).toBeNull();
    expect(cy.dernierEtat?.resultat?.expirees).toEqual(['p-ana', 'p-bo']);
    expect(deLaConfirmation()).toEqual([]);
  });

  it('re-cliquer après l expiration relance 2 minutes, comptées depuis ce clic', async () => {
    const { table, numero, ana, bo } = await entracte();
    await confirmer(ana, numero);
    await confirmer(bo, numero);
    await horloge.avancer(DELAI_CONFIRMATION_MS);
    expect(table.resultatCoup?.prets).toEqual([]);

    await horloge.avancer(45_000);
    await confirmer(ana, numero);
    expect(deLaConfirmation()).toEqual([DELAI_CONFIRMATION_MS]);
    expect(espion('p-cy').dernierEtat?.resultat?.echeance).not.toBeNull();
    // Ana n'est plus dans les expirés ; Bo, qui n'a pas reconfirmé, y reste.
    expect(espion('p-cy').dernierEtat?.resultat?.expirees).toEqual(['p-bo']);

    // Et ce nouveau délai expire à son tour, 2 minutes après son clic à lui.
    await horloge.avancer(DELAI_CONFIRMATION_MS - 1);
    expect(table.resultatCoup?.prets).toEqual(['p-ana']);
    await horloge.avancer(1);
    expect(table.resultatCoup?.prets).toEqual([]);
  });

  it('tous confirment dans le délai : le coup suivant démarre, plus aucun délai ne court', async () => {
    const { table, numero, ana, bo, cy } = await entracte();
    await confirmer(ana, numero);
    await horloge.avancer(DELAI_CONFIRMATION_MS - 1_000);
    await confirmer(bo, numero);
    await confirmer(cy, numero);
    await patienter(20);

    expect(table.resultatCoup).toBeNull();
    expect(table.coup?.numero).toBe(2);
    expect(deLaConfirmation()).toEqual([]);

    // L'échéance, passée, ne défait rien du coup suivant.
    await horloge.avancer(10 * DELAI_CONFIRMATION_MS);
    expect(table.coup?.numero).toBe(2);
    expect(table.resultatCoup).toBeNull();
  });

  it('les robots ne lancent pas le délai, et ne sont jamais effacés', async () => {
    const { table, numero, ana, bo, cy } = await entracte();
    // Cy est joué par le serveur : il a déjà confirmé, personne d'autre.
    table.bots.add('p-cy');
    if (table.resultatCoup === null) throw new Error('entracte absent');
    table.resultatCoup.prets = ['p-cy'];
    await confirmer(ana, numero);
    // Le délai part du clic d'Ana, pas de celui du robot — qui, lui, l'avait précédé.
    expect(deLaConfirmation()).toEqual([DELAI_CONFIRMATION_MS]);

    await horloge.avancer(DELAI_CONFIRMATION_MS);
    expect(table.resultatCoup?.prets).toEqual(['p-cy']);
    expect(bo.dernierEtat?.resultat?.expirees).toEqual(['p-ana']);
    expect(cy.dernierEtat?.resultat?.expirees).toEqual(['p-ana']);
    expect(deLaConfirmation()).toEqual([]);
  });

  it('sans humain ayant confirmé, aucun délai : un robot seul n en lance pas', async () => {
    const { table, numero, ana } = await entracte();
    table.bots.add('p-cy');
    if (table.resultatCoup === null) throw new Error('entracte absent');
    table.resultatCoup.prets = ['p-cy'];
    // Un clic humain d'un autre coup est sans objet : rien ne bouge.
    await emettre(ana.socket, 'pret-pour-suivant', { numero: numero + 5 });
    expect(deLaConfirmation()).toEqual([]);
  });

  describe('fin de Boule', () => {
    it('« Rejouer » suit la même limite de 2 minutes, et expire avec les clics de « prêt »', async () => {
      const { table, numero, ana, bo } = await entracte({ derniereCoup: true });
      await confirmer(ana, numero, 'rejouer');
      expect(deLaConfirmation()).toEqual([DELAI_CONFIRMATION_MS]);
      await horloge.avancer(60_000);
      await confirmer(bo, numero, 'rejouer');
      expect(table.resultatCoup?.rejouer).toEqual(['p-ana', 'p-bo']);
      expect(deLaConfirmation()).toEqual([DELAI_CONFIRMATION_MS]);

      await horloge.avancer(60_000);
      expect(table.resultatCoup?.rejouer).toEqual([]);
      expect(table.resultatCoup?.prets).toEqual([]);
      expect(table.statut).not.toBe('terminee');

      // Re-voter relance un délai neuf.
      await confirmer(ana, numero, 'rejouer');
      expect(table.resultatCoup?.rejouer).toEqual(['p-ana']);
      expect(deLaConfirmation()).toEqual([DELAI_CONFIRMATION_MS]);
    });

    it('tous veulent rejouer dans le délai : la nouvelle table naît', async () => {
      const { table, numero, ana, bo, cy } = await entracte({ derniereCoup: true });
      await confirmer(ana, numero, 'rejouer');
      await horloge.avancer(DELAI_CONFIRMATION_MS - 1_000);
      await confirmer(bo, numero, 'rejouer');
      await confirmer(cy, numero, 'rejouer');
      await patienter(30);
      expect(table.relanceeVers).toBeDefined();
      expect(deLaConfirmation()).toEqual([]);
    });

    it('« Terminer la Boule » reste immédiat, sans attendre le délai ni le laisser courir', async () => {
      const { table, numero, ana, bo } = await entracte({ derniereCoup: true });
      await confirmer(ana, numero, 'rejouer');
      expect(deLaConfirmation()).toEqual([DELAI_CONFIRMATION_MS]);

      expect((await confirmer(bo, numero)).ok).toBe(true);
      expect(table.statut).toBe('terminee');
      expect(table.resultatCoup).toBeNull();
      expect(deLaConfirmation()).toEqual([]);
    });
  });
});
