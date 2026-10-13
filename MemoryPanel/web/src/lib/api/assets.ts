/**
 * api/assets.ts - asset management (meta/asset/*).
 */
import { metaPost, metaListAll, getCurrentUser } from './base';
import type { Asset, AssetType, AssetStatus } from './types';

function newExternalAssetId(assetType: AssetType): string {
  const prefix = { skill: 'skl', llm_wiki: 'wiki', code_graph: 'cg', chat_memory: 'mem' }[assetType];
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}-${suffix}`;
}

export const assetsApi = {
  /** List team assets (supports filtering by type/status/owner) */
  list: (
    teamId: string,
    params?: { asset_type?: AssetType; status?: AssetStatus; owner_user_id?: string }
  ) =>
    metaListAll<Asset>('asset/list', {
      team_id: teamId,
      asset_type: params?.asset_type,
      status: params?.status,
      owner_user_id: params?.owner_user_id,
    }),

  /** Asset detail */
  get: (assetId: string) => metaPost<Asset>('asset/get', { asset_id: assetId }),

  /** Create/register asset (two-stage: main table + detail table) */
  create: async (
    teamId: string,
    data: {
      asset_type: AssetType;
      name: string;
      description?: string;
      source_type?: string;
      content_ref?: string;
      visibility?: string;
      metadata_json?: string;
      detail?: Record<string, unknown>;
    }
  ) => {
    const me = await getCurrentUser();
    return metaPost<Asset>('asset/create', {
      asset_id: newExternalAssetId(data.asset_type),
      team_id: teamId,
      asset_type: data.asset_type,
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
      source_type: data.source_type ?? 'uploaded',
      content_ref: data.content_ref,
      visibility: data.visibility ?? 'team',
      metadata_json: data.metadata_json,
      detail: data.detail,
    });
  },

  /** Update asset */
  update: (
    assetId: string,
    data: Partial<{ name: string; description: string; status: AssetStatus; visibility: string }>
  ) => metaPost<Asset>('asset/update', { asset_id: assetId, ...data }),

  /** Delete asset (meta asset/delete → physically deletes the row) */
  delete: async (assetId: string) => {
    await metaPost<{ deleted_ids: string[] }>('asset/delete', { asset_ids: [assetId] });
  },

  /**
   * List assets the current user can **access** in the given team (goes through the backend permission-checker,
   * strictly enforcing visibility × ACL filtering).
   *
   * Difference from asset/list:
   *   - asset/list: queries meta_assets directly via SQL, no visibility/ACL filtering, adminOps perspective.
   *   - asset/list-accessible: first computes the visible set by visibility × role × ACL,
   *     others automatically cannot see a private skill; owner is let through first.
   *
   * Optional `visibility` parameter: a secondary server-side whitelist filter (e.g. `['team']` returns only
   * team-shared ones), avoiding the information-leak risk of "response body carries everything, frontend JS filters".
   *
   * Used for the "Team assets" tab - team members should only see three parts: "team public + own private + explicitly authorized".
   */
  listAccessible: async (
    teamId: string,
    params?: {
      asset_type?: AssetType;
      action?: 'read' | 'write' | 'use';
      visibility?: Asset['visibility'] | Asset['visibility'][];
    }
  ): Promise<Asset[]> => {
    const me = await getCurrentUser();
    return metaListAll<Asset>('asset/list-accessible', {
      user_id: me.user_id,
      team_id: teamId,
      asset_type: params?.asset_type,
      action: params?.action ?? 'read',
      visibility: params?.visibility,
    });
  },
};
