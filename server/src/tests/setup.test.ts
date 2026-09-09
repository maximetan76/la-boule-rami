import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Garde-fou : `docs/REGLES.md` est la référence unique de la logique de jeu.
 * Ce test échoue si le fichier de règles disparaît ou est vidé.
 */
describe('socle du projet', () => {
  it('expose les règles du jeu dans docs/REGLES.md', () => {
    const regles = readFileSync(
      fileURLToPath(new URL('../../../docs/REGLES.md', import.meta.url)),
      'utf8',
    );

    expect(regles).toContain('## La Boule — règles complètes');
    expect(regles).toContain('### Fin de la Boule (tous les coups joués)');
  });
});
