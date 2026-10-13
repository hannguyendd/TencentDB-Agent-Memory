/**
 * CredentialStore — resource-level credential storage.
 *
 * Primary key: (service_id, resource_type, resource_id). Credentials attach to resources, decoupled from users.
 * Storage: `cred_secret` uses base64 (not encryption), decoded in memory at use time; plaintext never leaves KS.
 * Confidentiality is provided by file permissions + the API never echoing + plaintext never in logs, see §4.1.3.
 */

import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { knowledgeSourceCredential } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { encodeSecret, decodeSecret } from "./credential-codec.js";
import type {
  CredentialKind,
  CredentialStatus,
  ICredentialStore,
  ResourceRef,
  ResourceType,
} from "./types.js";

const log = createLogger("source-auth-credential-store");

const nowIso = (): string => new Date().toISOString();

export interface CredentialStoreOptions {
  db: Db;
}

export function createCredentialStore(opts: CredentialStoreOptions): ICredentialStore {
  const { db } = opts;

  /** Build a where triple (highly reusable). */
  const whereRef = (ref: ResourceRef) =>
    and(
      eq(knowledgeSourceCredential.serviceId, ref.serviceId),
      eq(knowledgeSourceCredential.resourceType, ref.type),
      eq(knowledgeSourceCredential.resourceId, ref.resourceId),
    );

  const rowToStatus = (row: {
    resourceType: string;
    resourceId: string;
    providerId: string;
    credKind: string;
    lastVerifiedAt: string | null;
    updatedAt: string;
  }): CredentialStatus => ({
    resource_type: row.resourceType as ResourceType,
    resource_id: row.resourceId,
    provider_id: row.providerId,
    cred_kind: row.credKind as CredentialKind,
    last_verified_at: row.lastVerifiedAt,
    updated_at: row.updatedAt,
  });

  return {
    get(ref) {
      const row = db
        .select()
        .from(knowledgeSourceCredential)
        .where(whereRef(ref))
        .get();
      if (!row) return null;

      // decode failure → null (treated as not configured), does not throw. Avoids corrupted content being used as a valid token to clone.
      const secret = decodeSecret(row.credSecret);
      if (secret === null) {
        log.warn("credential secret malformed, treating as missing", {
          resourceType: ref.type,
          resourceId: ref.resourceId,
        });
        return null;
      }

      let extra: Record<string, unknown> | undefined;
      if (row.credExtraJson) {
        try {
          extra = JSON.parse(row.credExtraJson) as Record<string, unknown>;
        } catch {
          log.warn("credential extra_json malformed, ignored", {
            resourceType: ref.type,
            resourceId: ref.resourceId,
          });
        }
      }

      return {
        kind: row.credKind as CredentialKind,
        secret,
        username: row.credUsername ?? undefined,
        extra,
      };
    },

    put(ref, cred, providerId, updatedBy) {
      if (!cred.secret) throw new Error("credential secret must be non-empty");
      const credSecret = encodeSecret(cred.secret);
      const extraJson =
        cred.extra && Object.keys(cred.extra).length > 0 ? JSON.stringify(cred.extra) : null;
      const ts = nowIso();

      const values = {
        serviceId: ref.serviceId,
        resourceType: ref.type,
        resourceId: ref.resourceId,
        providerId,
        credKind: cred.kind,
        credSecret,
        credUsername: cred.username ?? null,
        credExtraJson: extraJson,
        lastVerifiedAt: null as string | null,
        createdBy: updatedBy ?? null,
        updatedBy: updatedBy ?? null,
        createdAt: ts,
        updatedAt: ts,
      };

      db.insert(knowledgeSourceCredential)
        .values(values)
        .onConflictDoUpdate({
          target: [
            knowledgeSourceCredential.serviceId,
            knowledgeSourceCredential.resourceType,
            knowledgeSourceCredential.resourceId,
          ],
          set: {
            providerId: values.providerId,
            credKind: values.credKind,
            credSecret: values.credSecret,
            credUsername: values.credUsername,
            credExtraJson: values.credExtraJson,
            updatedBy: values.updatedBy,
            updatedAt: values.updatedAt,
          },
        })
        .run();

      // Logs never carry secret / cred_secret; only record ownership.
      log.info("credential saved", {
        resourceType: ref.type,
        resourceId: ref.resourceId,
        providerId,
        kind: cred.kind,
      });
    },

    delete(ref) {
      const res = db.delete(knowledgeSourceCredential).where(whereRef(ref)).run();
      return (res.changes ?? 0) > 0;
    },

    status(ref) {
      const row = db
        .select({
          resourceType: knowledgeSourceCredential.resourceType,
          resourceId: knowledgeSourceCredential.resourceId,
          providerId: knowledgeSourceCredential.providerId,
          credKind: knowledgeSourceCredential.credKind,
          lastVerifiedAt: knowledgeSourceCredential.lastVerifiedAt,
          updatedAt: knowledgeSourceCredential.updatedAt,
        })
        .from(knowledgeSourceCredential)
        .where(whereRef(ref))
        .get();
      return row ? rowToStatus(row) : null;
    },

    listAllByType(type) {
      const rows = db
        .select({
          serviceId: knowledgeSourceCredential.serviceId,
          resourceId: knowledgeSourceCredential.resourceId,
        })
        .from(knowledgeSourceCredential)
        .where(eq(knowledgeSourceCredential.resourceType, type))
        .all();
      return rows.map((r) => ({ serviceId: r.serviceId, resourceId: r.resourceId }));
    },

    recordVerify(ref) {
      db.update(knowledgeSourceCredential)
        .set({ lastVerifiedAt: nowIso(), updatedAt: nowIso() })
        .where(whereRef(ref))
        .run();
    },
  };
}
