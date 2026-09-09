import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { creerServeur, type Serveur } from '../server/index.js';
import type { GestionDeconnexion, Minuteur } from '../server/game-room-manager.js';
import { DELAI_DECONNEXION_PAR_DEFAUT_MS } from '../server/game-room-manager.js';
import type { Carte, JoueurId } from '../models/index.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';

/**
 * Test d'intégration : trois joueurs sur une même table, tous les messages
 * reçus par chacun sont interceptés et fouillés. Aucun ne doit jamais contenir
 * une carte de la main d'un autre joueur ni du talon de pioche.
 */

/** Aléa déterministe, pour que la partie soit rejouable à l'identique. */
const aleaFixe = (): (() => number) => {
  let graine = 20240909;
  return () => {
    graine = (graine * 1103515245 + 12345) % 2147483648;
    return graine / 2147483648;
  };
};

interface Espion {
  readonly socket: ClientSocket;
  readonly joueurId: JoueurId;
  /** Tout ce que la socket a reçu, tel quel. */
  readonly recus: unknown[];
  dernierEtat: EtatCoupFiltre | null;
  /** Nombre d'états reçus, pour attendre la diffusion complète d'une action. */
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

const identifiantsDans = (valeur: unknown): Set<string> =>
  new Set(
    (JSON.stringify(valeur).match(/"id":"([^"]+)"/g) ?? []).map((brut) =>
      brut.slice('"id":"'.length, -1),
    ),
  );

/** Horloge factice : rien ne s'écoule tant que le test ne le décide pas. */
const minuteurFactice = () => {
  const programmes: { callback: () => void; delaiMs: number; annule: boolean }[] = [];
  const minuteur: Minuteur = {
    programmer(callback, delaiMs) {
      const entree = { callback, delaiMs, annule: false };
      programmes.push(entree);
      return () => {
        entree.annule = true;
      };
    },
  };
  const declencher = () => {
    for (const entree of programmes) {
      if (!entree.annule) {
        entree.annule = true;
        entree.callback();
      }
    }
  };
  return { minuteur, programmes, declencher };
};

describe('serveur socket.io', () => {
  let serveur: Serveur;
  let port: number;
  let espions: Espion[];
  let horloge: ReturnType<typeof minuteurFactice>;

  beforeEach(async () => {
    horloge = minuteurFactice();
    serveur = creerServeur({ minuteur: horloge.minuteur });
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

  const connecter = async (jeton: string, joueurId: JoueurId): Promise<Espion> => {
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    const espion: Espion = { socket, joueurId, recus: [], dernierEtat: null, etatsRecus: 0 };

    socket.onAny((_evenement: string, ...args: unknown[]) => {
      espion.recus.push(...args);
    });
    socket.on('etat', (etat: EtatCoupFiltre) => {
      espion.dernierEtat = etat;
      espion.etatsRecus += 1;
    });

    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });
    const reponse = await emettre(socket, 'rejoindre-table', { jeton });
    expect(reponse.ok).toBe(true);

    espions.push(espion);
    return espion;
  };

  /**
   * Émet une action puis attend que TOUS les clients aient reçu leur état.
   * L'acquittement revient à l'émetteur sans garantir que la diffusion vers les
   * autres sockets soit déjà arrivée.
   */
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

  const ouvrirTable = async (gestionDeconnexion?: GestionDeconnexion) => {
    const { tableId, places } = serveur.manager.creerTable(['Ana', 'Bo', 'Cy'], {
      alea: aleaFixe(),
      ...(gestionDeconnexion === undefined ? {} : { gestionDeconnexion }),
    });
    for (const place of places) await connecter(place.jeton, place.joueurId);
    return { tableId, places };
  };

  it('distribue un coup des que tous les joueurs ont rejoint la table', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);

    expect(table.coup).not.toBeNull();
    expect(table.coup?.phase).toBe('annonces');
    for (const espion of espions) {
      expect(espion.dernierEtat?.moi.main).toHaveLength(14);
      expect(espion.dernierEtat?.adversaires).toHaveLength(2);
    }
  });

  it('ne laisse jamais fuir la main d un autre joueur ni le talon, sur toute une partie', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    const ordre = table.coup?.ordreJoueurs ?? [];

    // Le premier a parler joue : la phase de jeu s ouvre.
    const premier = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    expect((await agir(premier, 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);

    // Plusieurs tours de table : chacun pioche et defausse.
    for (let tour = 0; tour < 9; tour += 1) {
      const actifId = serveur.manager.table(tableId).coup?.joueurActifId;
      const actif = espions.find((espion) => espion.joueurId === actifId) as Espion;

      expect((await agir(actif, 'piocher', { source: 'pioche' })).ok).toBe(true);
      const aDefausser = actif.dernierEtat?.moi.main[0]?.id;
      expect((await agir(actif, 'defausser', { carteId: aDefausser })).ok).toBe(true);
    }

    // Fouille de tout ce qui a transité, par joueur.
    const coup = serveur.manager.table(tableId).coup;
    if (coup === null) throw new Error('coup absent');

    for (const espion of espions) {
      const vus = identifiantsDans(espion.recus);

      // Aucune carte du talon, a aucun moment.
      for (const carte of coup.pioche) {
        expect(vus.has(carte.id)).toBe(false);
      }
      // Aucune carte de la main d un autre joueur.
      for (const [joueurId, main] of Object.entries(coup.mains)) {
        if (joueurId === espion.joueurId) continue;
        for (const carte of main as Carte[]) {
          expect(vus.has(carte.id)).toBe(false);
        }
      }
      // Sa propre main, en revanche, lui est bien parvenue.
      const sienne = (coup.mains[espion.joueurId] ?? []) as Carte[];
      expect(sienne.some((carte) => vus.has(carte.id))).toBe(true);
    }
  });

  it('fait grandir la liste des cartes sorties sans jamais reveler qui les a jetees', async () => {
    const { tableId } = await ouvrirTable();
    const ordre = serveur.manager.table(tableId).coup?.ordreJoueurs ?? [];
    const premier = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    await agir(premier, 'annoncer', { annonce: 'je-joue' });

    const tailles: number[] = [];
    for (let tour = 0; tour < 6; tour += 1) {
      const actifId = serveur.manager.table(tableId).coup?.joueurActifId;
      const actif = espions.find((espion) => espion.joueurId === actifId) as Espion;

      await agir(actif, 'piocher', { source: 'pioche' });
      await agir(actif, 'defausser', { carteId: actif.dernierEtat?.moi.main[0]?.id });

      const vue = espions[0]?.dernierEtat?.defausse;
      tailles.push(vue?.cartesSorties.length ?? 0);
    }

    // La liste grandit d un cran a chaque defausse.
    expect(tailles).toEqual([1, 2, 3, 4, 5, 6]);

    for (const espion of espions) {
      const defausse = espion.dernierEtat?.defausse;
      expect(defausse?.derniereCarte).not.toBeNull();
      // Les cartes sorties ne portent qu une identite de carte, rien d autre.
      for (const carte of defausse?.cartesSorties ?? []) {
        expect(Object.keys(carte).sort()).not.toContain('joueurId');
        expect(Object.keys(carte).sort()).not.toContain('tour');
      }
      // Toutes les vues montrent le meme ensemble, dans le meme ordre canonique.
      expect(defausse?.cartesSorties.map((carte) => carte.id)).toEqual(
        espions[0]?.dernierEtat?.defausse.cartesSorties.map((carte) => carte.id),
      );
    }
  });

  it('rejette une action illegale sans modifier l etat', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    const ordre = table.coup?.ordreJoueurs ?? [];

    const premier = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    const second = espions.find((espion) => espion.joueurId === ordre[1]) as Espion;

    // Parler hors de son tour.
    const horsTour = await emettre(second.socket, 'annoncer', { annonce: 'je-joue' });
    expect(horsTour.ok).toBe(false);
    expect(horsTour.erreur).toMatch(/parler/i);

    await emettre(premier.socket, 'annoncer', { annonce: 'je-joue' });

    // Piocher la defausse alors qu elle est vide.
    const defausseVide = await emettre(premier.socket, 'piocher', { source: 'defausse' });
    expect(defausseVide.ok).toBe(false);
    expect(defausseVide.erreur).toMatch(/defausse/i);

    // L etat n a pas bouge : personne n a pioche.
    expect(serveur.manager.table(tableId).tourEnCours).toBeNull();
    expect(serveur.manager.table(tableId).coup?.mains[ordre[0] as string]).toHaveLength(14);

    // Defausser une carte qu on n a pas.
    await emettre(premier.socket, 'piocher', { source: 'pioche' });
    const carteInventee = await emettre(premier.socket, 'defausser', { carteId: 'carte-bidon' });
    expect(carteInventee.ok).toBe(false);
    expect(serveur.manager.table(tableId).coup?.defausse).toHaveLength(0);
  });

  it('rend sa place et son jeu a un joueur qui se reconnecte', async () => {
    const { tableId, places } = await ouvrirTable();
    const place = places[0] as { joueurId: JoueurId; jeton: string };
    const avant = espions.find((espion) => espion.joueurId === place.joueurId) as Espion;
    const mainAvant = avant.dernierEtat?.moi.main.map((carte) => carte.id);

    avant.socket.disconnect();
    await patienter(50);
    expect(serveur.manager.joueursConnectes(serveur.manager.table(tableId))).toHaveLength(2);

    const revenu = await connecter(place.jeton, place.joueurId);
    expect(revenu.dernierEtat?.moi.joueurId).toBe(place.joueurId);
    expect(revenu.dernierEtat?.moi.main.map((carte) => carte.id)).toEqual(mainAvant);
    expect(serveur.manager.joueursConnectes(serveur.manager.table(tableId))).toHaveLength(3);
  });

  it('refuse un jeton inconnu', async () => {
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });

    const reponse = await emettre(socket, 'rejoindre-table', { jeton: 'pas-un-jeton' });
    expect(reponse.ok).toBe(false);
    expect(reponse.erreur).toMatch(/jeton/i);
    socket.disconnect();
  });

  it('rejoue le coup a la meme place quand tout le monde friche', async () => {
    const { tableId } = await ouvrirTable();
    const ordre = serveur.manager.table(tableId).coup?.ordreJoueurs ?? [];
    const donneurAvant = serveur.manager.table(tableId).coup?.donneurId;

    for (const joueurId of ordre) {
      const espion = espions.find((e) => e.joueurId === joueurId) as Espion;
      expect((await agir(espion, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    }

    const table = serveur.manager.table(tableId);
    // Meme numero de coup, meme donneur, Boule pas allongee, un friche de plus.
    expect(table.coup?.numero).toBe(1);
    expect(table.coup?.donneurId).toBe(donneurAvant);
    expect(table.coup?.phase).toBe('annonces');
    expect(table.boule.nombreCoupsTotal).toBe(9);
    expect(table.boule.nombreCoupsFriches).toBe(3);
    for (const espion of espions) {
      expect(espion.dernierEtat?.moi.main).toHaveLength(14);
    }
  });
});

describe('gestion des deconnexions', () => {
  let serveur: Serveur;
  let port: number;
  let espions: Espion[];
  let horloge: ReturnType<typeof minuteurFactice>;

  beforeEach(async () => {
    horloge = minuteurFactice();
    serveur = creerServeur({ minuteur: horloge.minuteur });
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

  const connecter = async (jeton: string, joueurId: JoueurId): Promise<Espion> => {
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    const espion: Espion = { socket, joueurId, recus: [], dernierEtat: null, etatsRecus: 0 };
    socket.on('etat', (etat: EtatCoupFiltre) => {
      espion.dernierEtat = etat;
      espion.etatsRecus += 1;
    });
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });
    expect((await emettre(socket, 'rejoindre-table', { jeton })).ok).toBe(true);
    espions.push(espion);
    return espion;
  };

  const preparerTourPioche = async (gestionDeconnexion?: GestionDeconnexion) => {
    const { tableId, places } = serveur.manager.creerTable(['Ana', 'Bo', 'Cy'], {
      alea: aleaFixe(),
      ...(gestionDeconnexion === undefined ? {} : { gestionDeconnexion }),
    });
    for (const place of places) await connecter(place.jeton, place.joueurId);

    const ordre = serveur.manager.table(tableId).coup?.ordreJoueurs ?? [];
    const actif = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    await emettre(actif.socket, 'annoncer', { annonce: 'je-joue' });
    await emettre(actif.socket, 'piocher', { source: 'pioche' });
    await patienter(20);

    const table = serveur.manager.table(tableId);
    return { tableId, places, ordre, actif, cartePiochee: table.tourEnCours?.cartePiochee };
  };

  /** Amène le joueur actif à son tour, sans qu'il ait encore pioché. */
  const preparerTourSansAction = async (gestionDeconnexion?: GestionDeconnexion) => {
    const { tableId, places } = serveur.manager.creerTable(['Ana', 'Bo', 'Cy'], {
      alea: aleaFixe(),
      ...(gestionDeconnexion === undefined ? {} : { gestionDeconnexion }),
    });
    for (const place of places) await connecter(place.jeton, place.joueurId);

    const ordre = serveur.manager.table(tableId).coup?.ordreJoueurs ?? [];
    const actif = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    await emettre(actif.socket, 'annoncer', { annonce: 'je-joue' });
    await patienter(20);

    const table = serveur.manager.table(tableId);
    return { tableId, places, ordre, actif, sommetDuTalon: table.coup?.pioche[0] };
  };

  it('applique un delai de 90 secondes par defaut', async () => {
    const { tableId } = await preparerTourPioche();
    expect(serveur.manager.table(tableId).gestionDeconnexion).toEqual({
      type: 'delai',
      dureeMs: DELAI_DECONNEXION_PAR_DEFAUT_MS,
    });
  });

  it('defausse la carte piochee et passe la main a l expiration du delai', async () => {
    const { tableId, ordre, actif, cartePiochee } = await preparerTourPioche({
      type: 'delai',
      dureeMs: 90000,
    });
    expect(serveur.manager.table(tableId).tourEnCours).not.toBeNull();

    actif.socket.disconnect();
    await patienter(50);

    // Le minuteur est arme, mais rien n a encore bouge.
    expect(horloge.programmes).toHaveLength(1);
    expect(horloge.programmes[0]?.delaiMs).toBe(90000);
    expect(serveur.manager.table(tableId).tourEnCours).not.toBeNull();
    expect(serveur.manager.table(tableId).coup?.joueurActifId).toBe(ordre[0]);

    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.tourEnCours).toBeNull();
    // La carte piochee avant la deconnexion est celle qui part a la defausse.
    expect(table.coup?.defausse.at(-1)?.id).toBe(cartePiochee?.id);
    expect(table.coup?.joueurActifId).toBe(ordre[1]);
    // Aucune pose n a ete faite en son nom.
    expect(table.coup?.combinaisons).toEqual([]);
    expect(table.coup?.mains[ordre[0] as string]).toHaveLength(14);
  });

  it('previent les joueurs restants du nouvel etat apres l abandon', async () => {
    const { ordre } = await preparerTourPioche({ type: 'delai', dureeMs: 90000 });
    const actif = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    const temoin = espions.find((espion) => espion.joueurId === ordre[1]) as Espion;

    actif.socket.disconnect();
    await patienter(50);
    horloge.declencher();
    await patienter(50);

    expect(temoin.dernierEtat?.coup.joueurActifId).toBe(ordre[1]);
    expect(temoin.dernierEtat?.defausse.cartesSorties).toHaveLength(1);
  });

  it('laisse le tour en attente indefiniment en mode illimite', async () => {
    const { tableId, ordre, actif } = await preparerTourPioche({ type: 'illimite' });

    actif.socket.disconnect();
    await patienter(50);

    // Aucun minuteur n est arme, et declencher ne change rien.
    expect(horloge.programmes).toHaveLength(0);
    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.tourEnCours).not.toBeNull();
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(table.coup?.defausse).toHaveLength(0);
  });

  it('desamorce le minuteur quand le joueur revient a temps', async () => {
    const { tableId, places, ordre, actif } = await preparerTourPioche({
      type: 'delai',
      dureeMs: 90000,
    });
    const jeton = (places.find((place) => place.joueurId === ordre[0]) as { jeton: string }).jeton;

    actif.socket.disconnect();
    await patienter(50);
    expect(horloge.programmes).toHaveLength(1);

    const revenu = await connecter(jeton, ordre[0] as JoueurId);
    expect(horloge.programmes[0]?.annule).toBe(true);

    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.tourEnCours).not.toBeNull();
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(table.coup?.defausse).toHaveLength(0);
    // Il retrouve sa carte piochee.
    expect(revenu.dernierEtat?.moi.carteEnAttente?.id).toBe(table.tourEnCours?.cartePiochee.id);
  });

  it('n arme aucun minuteur pour un joueur dont ce n est pas le tour', async () => {
    const { ordre } = await preparerTourPioche({ type: 'delai', dureeMs: 90000 });
    const inactif = espions.find((espion) => espion.joueurId === ordre[1]) as Espion;

    inactif.socket.disconnect();
    await patienter(50);

    expect(horloge.programmes).toHaveLength(0);
  });

  it('pioche et defausse pour le joueur parti avant meme d avoir pioche', async () => {
    const { tableId, ordre, actif, sommetDuTalon } = await preparerTourSansAction({
      type: 'delai',
      dureeMs: 90000,
    });
    // Aucun tour n est entame : il n a encore rien fait.
    expect(serveur.manager.table(tableId).tourEnCours).toBeNull();
    const tailleTalon = serveur.manager.table(tableId).coup?.pioche.length ?? 0;

    actif.socket.disconnect();
    await patienter(50);

    // Le minuteur s arme quand meme : c est son tour.
    expect(horloge.programmes).toHaveLength(1);
    expect(horloge.programmes[0]?.delaiMs).toBe(90000);
    expect(serveur.manager.table(tableId).coup?.defausse).toHaveLength(0);

    horloge.declencher();

    const table = serveur.manager.table(tableId);
    // Une carte a bien ete piochee au talon, puis defaussee aussitot.
    expect(table.coup?.pioche).toHaveLength(tailleTalon - 1);
    expect(table.coup?.defausse).toHaveLength(1);
    expect(table.coup?.defausse.at(-1)?.id).toBe(sommetDuTalon?.id);
    // Sa main est intacte et rien n a ete pose en son nom.
    expect(table.coup?.mains[ordre[0] as string]).toHaveLength(14);
    expect(table.coup?.combinaisons).toEqual([]);
    // La main passe au suivant.
    expect(table.coup?.joueurActifId).toBe(ordre[1]);
    expect(table.tourEnCours).toBeNull();
  });

  it('laisse le tour bloque en mode illimite, meme avant toute action', async () => {
    const { tableId, ordre, actif } = await preparerTourSansAction({ type: 'illimite' });
    const tailleTalon = serveur.manager.table(tableId).coup?.pioche.length ?? 0;

    actif.socket.disconnect();
    await patienter(50);

    expect(horloge.programmes).toHaveLength(0);
    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(table.coup?.defausse).toHaveLength(0);
    expect(table.coup?.pioche).toHaveLength(tailleTalon);
  });

  it('desamorce le minuteur si le joueur revient avant d avoir joue', async () => {
    const { tableId, places, ordre, actif } = await preparerTourSansAction({
      type: 'delai',
      dureeMs: 90000,
    });
    const jeton = (places.find((place) => place.joueurId === ordre[0]) as { jeton: string }).jeton;

    actif.socket.disconnect();
    await patienter(50);
    expect(horloge.programmes).toHaveLength(1);

    await connecter(jeton, ordre[0] as JoueurId);
    expect(horloge.programmes[0]?.annule).toBe(true);

    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(table.coup?.defausse).toHaveLength(0);
  });
});
