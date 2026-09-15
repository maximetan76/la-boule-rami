import { describe, expect, it } from 'vitest';
import { enregistrerResultatCoup } from '../game-engine/boule.js';
import type { ScoreCoup } from '../models/index.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import {
  bouleEnCours,
  DELAI_INACTIVITE_MS,
  demarrerCoup,
  GameRoomManager,
} from '../server/game-room-manager.js';
import { ouvrirTablePleine } from './aide-table.js';
import { c } from './fixtures.js';

/**
 * Suppression réelle des tables où rien ne s'est joué depuis trois heures : un
 * salon jamais démarré, une partie démarrée sans aucune action de jeu. Une
 * table où un coup s'est joué n'est jamais concernée.
 */

const JOUEURS = [
  { id: 'p-ana', pseudo: 'Ana' },
  { id: 'p-bo', pseudo: 'Bo' },
];

const dans = (ms: number): Date => new Date(Date.now() + ms);
const PLUS_DE_TROIS_HEURES = DELAI_INACTIVITE_MS + 60_000;
const MOINS_DE_TROIS_HEURES = DELAI_INACTIVITE_MS - 60_000;

const coupGagne: ScoreCoup = {
  gagnantId: 'p-ana',
  typeVictoire: 'simple',
  estFriche: false,
  multiplicateur: 1,
  scores: {},
  croixGagnees: {},
  chocolatId: null,
};

const preparer = () => {
  const depot = new DepotMemoire();
  return { depot, manager: new GameRoomManager({ depot }) };
};

describe('nettoyage des tables inactives', () => {
  it('supprime un salon jamais demarre ouvert depuis plus de 3h, en memoire comme en base', async () => {
    const { depot, manager } = preparer();
    const { tableId, codeInvitation } = await manager.creerTable(JOUEURS[0] as (typeof JOUEURS)[0], { capacite: 3 });
    await manager.rejoindreParCode(codeInvitation, JOUEURS[1] as (typeof JOUEURS)[0]);

    const supprimees = await manager.nettoyerTablesInactives(dans(PLUS_DE_TROIS_HEURES));

    expect(supprimees.map((supprimee) => supprimee.tableId)).toEqual([tableId]);
    expect(manager.tableVivante(tableId)).toBeNull();
    expect(manager.tableParCode(codeInvitation)).toBeNull();
    // Pas un marquage : la partie n'existe plus du tout en base.
    expect(await depot.trouverPartieParCode(codeInvitation)).toBeNull();
    expect(await depot.chargerArchive(tableId)).toBeNull();
    expect(await depot.partiesDuJoueur('p-ana')).toEqual([]);
  });

  it('garde un salon ouvert depuis moins de 3h', async () => {
    const { depot, manager } = preparer();
    const { tableId, codeInvitation } = await manager.creerTable(JOUEURS[0] as (typeof JOUEURS)[0], { capacite: 3 });

    expect(await manager.nettoyerTablesInactives(dans(MOINS_DE_TROIS_HEURES))).toEqual([]);
    expect(manager.tableVivante(tableId)).not.toBeNull();
    expect(await depot.trouverPartieParCode(codeInvitation)).not.toBeNull();
  });

  it('supprime une partie demarree sans aucun coup joue depuis plus de 3h, donne et annonces comprises', async () => {
    const { depot, manager } = preparer();
    const { tableId } = await ouvrirTablePleine(manager, JOUEURS);
    const table = manager.table(tableId);
    const coup = demarrerCoup(table);
    // Annoncer n'est pas jouer : personne n'a encore pioché.
    coup.annonces = { 'p-ana': 'je-joue' };
    coup.phase = 'jeu';

    expect(await manager.nettoyerTablesInactives(dans(MOINS_DE_TROIS_HEURES))).toEqual([]);
    const supprimees = await manager.nettoyerTablesInactives(dans(PLUS_DE_TROIS_HEURES));

    expect(supprimees.map((supprimee) => supprimee.tableId)).toEqual([tableId]);
    expect(manager.tableVivante(tableId)).toBeNull();
    expect(await depot.chargerArchive(tableId)).toBeNull();
  });

  it('ne supprime jamais une partie ou au moins un coup a ete joue, meme tres ancienne', async () => {
    const { depot, manager } = preparer();
    const { tableId } = await ouvrirTablePleine(manager, JOUEURS);
    const table = manager.table(tableId);
    table.boule = enregistrerResultatCoup(bouleEnCours(table), 1, coupGagne);
    demarrerCoup(table);

    expect(await manager.nettoyerTablesInactives(dans(1000 * DELAI_INACTIVITE_MS))).toEqual([]);
    expect(manager.tableVivante(tableId)).not.toBeNull();
    expect(await depot.chargerArchive(tableId)).not.toBeNull();
  });

  it('protege aussi une partie dont le premier coup a deja vu un tour se jouer', async () => {
    const { manager } = preparer();
    const { tableId } = await ouvrirTablePleine(manager, JOUEURS);
    const coup = demarrerCoup(manager.table(tableId));
    coup.defausse = [c('pique', 3)];

    expect(await manager.nettoyerTablesInactives(dans(1000 * DELAI_INACTIVITE_MS))).toEqual([]);
    expect(manager.tableVivante(tableId)).not.toBeNull();
  });
});
