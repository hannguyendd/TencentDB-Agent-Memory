/**
 * basic -- username + password authentication.
 *
 * The user fills in two fields (username + password); provider.cloneUsername is not used.
 *
 * URL form: `https://<username>:<password>@host/repo.git`
 */

import { injectBasicAuth } from "../clone-url.js";
import type { AuthMethod } from "./types.js";

export const basicAuthMethod: AuthMethod = {
  kind: "basic",

  formFields: [
    { name: "username", secret: false, required: true },
    { name: "secret", secret: true, required: true },
  ],

  buildCredential(form) {
    if (!form.username) throw new Error("username is required");
    if (!form.secret) throw new Error("password is required");
    return { username: form.username, secret: form.secret };
  },

  buildCloneUrl(repoUrl, cred, _cloneUsername) {
    if (!cred.username) {
      throw new Error("basic auth requires credential.username");
    }
    return injectBasicAuth(repoUrl, { user: cred.username, pass: cred.secret });
  },
};
