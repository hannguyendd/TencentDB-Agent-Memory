/**
 * Built-in set of authentication methods -- to add a new one, add a line here.
 */

import type { AuthMethod, AuthMethodKind } from "./types.js";
import { bearerAuthMethod } from "./bearer.js";
import { basicAuthMethod } from "./basic.js";

export const AUTH_METHODS: Readonly<Record<AuthMethodKind, AuthMethod>> = Object.freeze({
  bearer: bearerAuthMethod,
  basic: basicAuthMethod,
});

/** Look up an implementation by kind; not registered -> undefined. */
export function getAuthMethod(kind: string): AuthMethod | undefined {
  return AUTH_METHODS[kind as AuthMethodKind];
}

export type { AuthMethod, AuthMethodKind, CredentialFormField } from "./types.js";
export { bearerAuthMethod, basicAuthMethod };
