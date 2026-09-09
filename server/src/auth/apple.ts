/**
 * Vérification du jeton d'identité « Sign in with Apple ».
 *
 * L'app iOS obtient un JWT signé par Apple et l'envoie au serveur. Celui-ci en
 * vérifie la signature avec les clés publiques d'Apple, puis l'émetteur,
 * l'audience et l'expiration. Le claim `sub` est l'identifiant stable du
 * compte : c'est lui qui rattache la connexion à un joueur en base.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const URL_CLES_APPLE = 'https://appleid.apple.com/auth/keys';
export const EMETTEUR_APPLE = 'https://appleid.apple.com';

export interface IdentiteApple {
  /** Claim `sub` : identifiant du compte Apple, stable pour cette application. */
  readonly identifiantApple: string;
  readonly email: string | null;
  /** Apple indique si l'adresse a été vérifiée ; utile avant de s'y fier. */
  readonly emailVerifie: boolean;
}

export interface ConfigApple {
  /** Identifiant du service Apple (audience attendue du jeton). */
  readonly clientId: string;
  /**
   * Source des clés publiques. Par défaut le JWKS d'Apple ; injectable pour
   * pouvoir tester la vérification sans appel réseau.
   */
  readonly cles?: JWTVerifyGetKey;
}

export class JetonAppleInvalideError extends Error {
  constructor(detail: string) {
    super(`Jeton Apple invalide : ${detail}`);
    this.name = 'JetonAppleInvalideError';
  }
}

let clesApple: JWTVerifyGetKey | null = null;

/** JWKS d'Apple, mis en cache par `jose` entre les appels. */
const clesParDefaut = (): JWTVerifyGetKey => {
  clesApple ??= createRemoteJWKSet(new URL(URL_CLES_APPLE));
  return clesApple;
};

/** Apple sérialise parfois `email_verified` en chaîne. */
const estVrai = (valeur: unknown): boolean => valeur === true || valeur === 'true';

export const verifierJetonApple = async (
  jetonIdentite: string,
  config: ConfigApple,
): Promise<IdentiteApple> => {
  try {
    const { payload } = await jwtVerify(jetonIdentite, config.cles ?? clesParDefaut(), {
      issuer: EMETTEUR_APPLE,
      audience: config.clientId,
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new JetonAppleInvalideError('identifiant de compte absent');
    }

    return {
      identifiantApple: payload.sub,
      email: typeof payload['email'] === 'string' ? payload['email'] : null,
      emailVerifie: estVrai(payload['email_verified']),
    };
  } catch (erreur) {
    if (erreur instanceof JetonAppleInvalideError) throw erreur;
    throw new JetonAppleInvalideError(
      erreur instanceof Error ? erreur.message : 'verification impossible',
    );
  }
};
