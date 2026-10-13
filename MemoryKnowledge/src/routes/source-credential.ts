/**
 * source-credential routes — token CRUD for external knowledge sources (**by resource id**).
 *
 * Security boundary:
 *   - Write-only: PUT accepts a plaintext token; no response ever **echoes** the secret (GET returns only metadata).
 *   - Isolated by resource: primary key (service_id, resource_type, resource_id); out-of-scope access → 404.
 *   - Authorization gate: before PUT/DELETE, must confirm the resource_id belongs to the request header team_id,
 *     otherwise team A could write credentials for team B's resources.
 *   - Identity comes from request headers (x-tdai-service-id / x-tdai-team-id / x-tdai-user-id),
 *     never accept user_id / team_id from the body.
 *
 * Note: this route only stores/retrieves credentials and does **not** perform any fetch / graph-building action.
 */

import { Hono } from "hono";

import { wrapOk, wrapError, isValidIdSegment } from "../api-helpers.js";
import type { IKnowledgeStore } from "../store/types.js";
import type {
  CredentialKind,
  ICredentialStore,
  ResourceRef,
  ResourceType,
} from "../source-auth/types.js";

const VALID_KINDS: CredentialKind[] = ["bearer", "basic"];
const VALID_TYPES: ResourceType[] = ["code-graph", "wiki"];

export interface SourceCredentialRouteDeps {
  credentialStore: ICredentialStore;
  /** Used to verify that resource_id belongs to the request header team_id (authorization gate). */
  store: IKnowledgeStore;
}

interface Actor {
  serviceId: string;
  teamId: string;
  userId: string;
}

function actor(c: { req: { header(name: string): string | undefined } }): Actor | null {
  const serviceId = c.req.header("x-tdai-service-id");
  const teamId = c.req.header("x-tdai-team-id");
  const userId = c.req.header("x-tdai-user-id");
  if (!isValidIdSegment(serviceId) || !isValidIdSegment(teamId) || !isValidIdSegment(userId)) {
    return null;
  }
  return { serviceId: serviceId as string, teamId: teamId as string, userId: userId as string };
}

/** Parse and validate resource_type + resource_id; return a ResourceRef on success. */
function parseRef(
  serviceId: string,
  rawType: unknown,
  rawId: unknown,
): ResourceRef | { error: string } {
  if (typeof rawType !== "string" || !(VALID_TYPES as string[]).includes(rawType)) {
    return { error: `resource_type must be one of ${VALID_TYPES.join(", ")}` };
  }
  if (typeof rawId !== "string" || !isValidIdSegment(rawId)) {
    return { error: "resource_id is required and must be a valid id" };
  }
  return { type: rawType as ResourceType, serviceId, resourceId: rawId };
}

/**
 * Team gate: confirm resource_id belongs to actor.teamId.
 * Missing or team mismatch → 404 (not distinguished, to avoid probing for existence).
 */
function ensureTeamOwnership(
  store: IKnowledgeStore,
  actor: Actor,
  ref: ResourceRef,
): { ok: true } | { ok: false; status: 404 } {
  const row =
    ref.type === "code-graph"
      ? store.getCodeGraphById(actor.serviceId, ref.resourceId)
      : store.getWikiById(actor.serviceId, ref.resourceId);
  if (!row || row.team_id !== actor.teamId) {
    return { ok: false, status: 404 };
  }
  return { ok: true };
}

export function createSourceCredentialRoutes(deps: SourceCredentialRouteDeps): Hono {
  const app = new Hono();
  const { credentialStore, store } = deps;

  // GET /status?resource_type=xxx&resource_id=yyy — metadata (no secret)
  app.get("/status", async (c) => {
    const who = actor(c);
    if (!who) {
      return c.json(wrapError(400, "x-tdai-service-id/team-id/user-id headers are required"), 400);
    }
    const refOrErr = parseRef(who.serviceId, c.req.query("resource_type"), c.req.query("resource_id"));
    if ("error" in refOrErr) return c.json(wrapError(400, refOrErr.error), 400);

    const gate = ensureTeamOwnership(store, who, refOrErr);
    if (!gate.ok) return c.json(wrapError(404, "resource not found"), 404);

    const status = credentialStore.status(refOrErr);
    return c.json(wrapOk({ configured: !!status, credential: status }));
  });

  // DELETE /delete?resource_type=xxx&resource_id=yyy — delete token
  app.delete("/delete", async (c) => {
    const who = actor(c);
    if (!who) {
      return c.json(wrapError(400, "x-tdai-service-id/team-id/user-id headers are required"), 400);
    }
    const refOrErr = parseRef(who.serviceId, c.req.query("resource_type"), c.req.query("resource_id"));
    if ("error" in refOrErr) return c.json(wrapError(400, refOrErr.error), 400);

    const gate = ensureTeamOwnership(store, who, refOrErr);
    if (!gate.ok) return c.json(wrapError(404, "resource not found"), 404);

    const ok = credentialStore.delete(refOrErr);
    if (!ok) return c.json(wrapError(404, "credential not found"), 404);
    return c.json(wrapOk({ deleted: true }));
  });

  // PUT /put — write / update token.
  // body: { resource_type, resource_id, provider_id, cred_kind, secret, username?, extra? }
  app.put("/put", async (c) => {
    const who = actor(c);
    if (!who) {
      return c.json(wrapError(400, "x-tdai-service-id/team-id/user-id headers are required"), 400);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const refOrErr = parseRef(who.serviceId, body.resource_type, body.resource_id);
    if ("error" in refOrErr) return c.json(wrapError(400, refOrErr.error), 400);

    const providerId = body.provider_id;
    if (typeof providerId !== "string" || !providerId) {
      return c.json(wrapError(400, "provider_id is required"), 400);
    }
    const secret = body.secret;
    if (typeof secret !== "string" || !secret) {
      return c.json(wrapError(400, "secret is required"), 400);
    }
    const kind = (typeof body.cred_kind === "string" ? body.cred_kind : "bearer") as CredentialKind;
    if (!VALID_KINDS.includes(kind)) {
      return c.json(wrapError(400, `cred_kind must be one of ${VALID_KINDS.join(", ")}`), 400);
    }
    if (kind === "basic" && typeof body.username !== "string") {
      return c.json(wrapError(400, "username is required for basic credential"), 400);
    }

    const gate = ensureTeamOwnership(store, who, refOrErr);
    if (!gate.ok) return c.json(wrapError(404, "resource not found"), 404);

    credentialStore.put(
      refOrErr,
      {
        kind,
        secret,
        username: typeof body.username === "string" ? body.username : undefined,
        extra:
          typeof body.extra === "object" && body.extra !== null
            ? (body.extra as Record<string, unknown>)
            : undefined,
      },
      providerId,
      who.userId,
    );

    // Return metadata only; never echo the secret.
    const status = credentialStore.status(refOrErr);
    return c.json(wrapOk({ credential: status }));
  });

  return app;
}
