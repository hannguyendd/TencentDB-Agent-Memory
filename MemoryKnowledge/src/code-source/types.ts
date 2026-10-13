/**
 * code-source -- abstraction of codegraph external sources.
 *
 * Two orthogonal dimensions:
 *   - **Provider (code platform)** -> `providers/<id>.ts`: platform constants + pick one AuthMethod
 *   - **AuthMethod (authentication method)** -> `auth-methods/<kind>.ts`: form / persistence / URL injection
 *
 * Adding a platform: write a provider constant that picks an authMethod; the auth layer is untouched
 * Adding an auth method: write an AuthMethod implementation; the platform layer is untouched
 */

import type { AuthMethod, AuthMethodKind } from "./auth-methods/types.js";

/** Source metadata for the frontend dropdown (KS sends it to the Panel, including form-driving info). */
export interface CodeSourceMeta {
  id: string;
  /** Auth method type; the frontend renders the credential form accordingly. */
  auth_method: AuthMethodKind;
  /** The method's form field list (the frontend dynamically renders inputs from this). */
  form_fields: ReadonlyArray<{ name: string; secret: boolean; required: boolean }>;
  /** Token application guide (the fully assembled URL; composed of the site root from deployment config + the provider's in-site path). */
  token_doc_url?: string;
}

/** Credential payload (internal data; not persisted, does not leave the process). */
export interface CredentialPayload {
  secret: string;
  username?: string;
}

/**
 * Platform provider contract.
 *
 * One platform file = one constant:
 *   - `id`: source id, corresponds to the deployment `CODE_SOURCE_ENABLED` and i18n `code.source.<id>`
 *   - `authMethod`: pick one from `auth-methods/` (bearer / basic / custom ones in the future...)
 *   - `cloneUsername`: only used in the bearer scenario (placeholder username dictated by the platform protocol)
 *   - `sitePaths`: relative paths of in-site pages
 *
 * **Do not write auth logic in a provider** -- that is the AuthMethod's responsibility.
 */
export interface ICodeSourceProvider {
  readonly id: string;
  readonly authMethod: AuthMethod;
  /** Placeholder basic-auth username for the bearer scenario; not needed for basic. */
  readonly cloneUsername?: string;
  readonly sitePaths: {
    /** Token / account application page. */
    tokenDoc?: string;
  };
  /** Optional: override the AuthMethod's default clone URL construction (generally unused). */
  applyToCloneUrl?(repoUrl: string, cred: CredentialPayload): string;
  /** Optional: override the generic git error mapping. */
  explainCloneError?(rawStderr: string, needsCredential: boolean): string | null;
}
