/**
 * AuthMethod -- the full encapsulation of one authentication method.
 *
 * One AuthMethod = one kind + form metadata + URL injection + persistence conversion.
 *
 * To add a new auth method (e.g. token-header, oauth-pkce):
 *   1. Create a file `auth-methods/<kind>.ts` exporting a constant that implements this interface
 *   2. Add one line to the AUTH_METHODS array in `auth-methods/index.ts`
 *   3. Use `authMethod: <kindConst>` in the Provider
 *
 * That's it. The storage layer, credential API, injection entry point and frontend form are all driven by this interface's fields;
 * no need to touch provider files, the registry, or write any switch.
 */

import type { CredentialPayload } from "../types.js";

/** Auth method kind (discriminated union; adding a member forces compile errors at every kind reference in the repo). */
export type AuthMethodKind = "bearer" | "basic";

/** Description of one field in the frontend credential form (the i18n key is composed by the frontend from name). */
export interface CredentialFormField {
  /** Field name, used as the payload key (consumed by `AuthMethod.buildCredential`). */
  name: "secret" | "username";
  /** Whether it is a password input (type=password). */
  secret: boolean;
  /** Whether it is required. */
  required: boolean;
}

/**
 * Auth method contract.
 *
 * All decisions of a method -- what the form looks like, what shape the credential is stored in, how the clone URL is built --
 * live here. Business code only calls these methods and never branches on kind.
 */
export interface AuthMethod {
  readonly kind: AuthMethodKind;

  /** Frontend credential form: field list (decides "whether to show the username input"). */
  readonly formFields: readonly CredentialFormField[];

  /**
   * Form values submitted by the frontend -> credential shape before persistence.
   *
   * A method may do its own validation (e.g. "basic must provide both username and password"),
   * and throws if it fails.
   *
   * Note: does not include provider_id / kind or other info already known at the registry layer; only handles the form values themselves.
   */
  buildCredential(form: Record<string, string | undefined>): {
    secret: string;
    username?: string;
  };

  /**
   * Inject the credential into the clone URL.
   *
   * The `cloneUsername` parameter is the placeholder username declared by the provider (differs per platform,
   * supplied by the provider itself; concrete values are not fixed in this document), used only by bearer;
   * basic ignores it and always uses cred.username.
   */
  buildCloneUrl(repoUrl: string, cred: CredentialPayload, cloneUsername?: string): string;
}
