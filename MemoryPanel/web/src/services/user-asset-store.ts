/**
 * user-asset-store.ts -- local localStorage layer for user-created assets (skill / memory).
 *
 * Extracted from the original demoStore.ts.
 *
 * Users can create their own skill or memory assets:
 *   - scope = 'team'    -> shared within the team, visible to all members and assignable to their own Agents
 *   - scope = 'private' -> visible only to oneself, and only the owner can assign it to their own Agents
 *
 * Team assets = the collection of assets all members have set to 'team'
 * Fixed assets = assets chosen from team/personal assets and assigned to a specific Agent
 *
 * Note: all assets have switched to the real backend API; this file keeps only the localStorage read/write capability
 * for use by components such as ChatMemoryPanel.
 */

import { emitChange, safeParse } from './storage-utils';

const USER_ASSETS_KEY = 'tdai-memory.userAssets.v1';

export type UserAssetKind = 'skill' | 'memory';

export interface UserAsset {
  asset_id: string;
  kind: UserAssetKind;
  owner_user_id: string;
  team_id: string;
  title: string;
  description: string;
  scope: 'team' | 'private';
  created_at_ms: number;
  updated_at_ms: number;
}

function readUserAssets(): UserAsset[] {
  if (typeof window === 'undefined') return [];
  return safeParse<UserAsset[]>(localStorage.getItem(USER_ASSETS_KEY), []);
}

function writeUserAssets(assets: UserAsset[]): void {
  try {
    localStorage.setItem(USER_ASSETS_KEY, JSON.stringify(assets));
  } catch {
    /* ignore */
  }
  emitChange();
}

/** Create a user-created asset */
export function createUserAsset(input: {
  kind: UserAssetKind;
  owner_user_id: string;
  team_id: string;
  title: string;
  description?: string;
  scope?: 'team' | 'private';
}): UserAsset {
  const assets = readUserAssets();
  const now = Date.now();
  const asset: UserAsset = {
    asset_id: `ua_${now}_${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind,
    owner_user_id: input.owner_user_id,
    team_id: input.team_id,
    title: input.title.trim(),
    description: (input.description ?? '').trim(),
    scope: input.scope ?? 'team',
    created_at_ms: now,
    updated_at_ms: now,
  };
  assets.push(asset);
  writeUserAssets(assets);
  return asset;
}

/** Update a user-created asset (only the owner can call) */
export function updateUserAsset(
  asset_id: string,
  patch: Partial<Pick<UserAsset, 'title' | 'description' | 'scope'>>
): void {
  const assets = readUserAssets();
  const target = assets.find((a) => a.asset_id === asset_id);
  if (!target) return;
  if (patch.title !== undefined) target.title = patch.title.trim();
  if (patch.description !== undefined) target.description = patch.description.trim();
  if (patch.scope !== undefined) target.scope = patch.scope;
  target.updated_at_ms = Date.now();
  writeUserAssets(assets);
}

/** Delete a user-created asset */
export function deleteUserAsset(asset_id: string): void {
  const assets = readUserAssets().filter((a) => a.asset_id !== asset_id);
  writeUserAssets(assets);
}

/** Read the assets owned by a user (filtered by kind) */
export function getUserAssetsByOwner(owner_user_id: string, kind: UserAssetKind, team_id?: string): UserAsset[] {
  return readUserAssets().filter(
    (a) => a.owner_user_id === owner_user_id && a.kind === kind && (!team_id || a.team_id === team_id)
  );
}

/** Read team-visible assets = assets that all members within the team have set to scope='team' + the current user's own private assets.
 *  When team_id is empty, no team filtering is applied (returns the visible assets of all teams). */
export function getTeamVisibleAssets(
  team_id: string | null | undefined,
  kind: UserAssetKind,
  currentUser?: string
): UserAsset[] {
  return readUserAssets().filter(
    (a) => (!team_id || a.team_id === team_id) && a.kind === kind && (a.scope === 'team' || a.owner_user_id === currentUser)
  );
}


