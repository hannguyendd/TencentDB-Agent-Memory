/**
 * api/chat-memory.ts - dedicated business routes for the Chat Memory panel (/api/v1/chat-memory/*).
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

/** Memory block list item (shared by team-assets / agent-fixed / my-agents) */
export interface ChatMemoryBlock {
  id: string;
  title: string;
  summary?: string;
  uploaded_by_user_id: string;
  updated_at_ms: number;
  layer_counts: { L0_messages: number; L1: number; L2: number; L3: number };
  /** team-assets only */
  bound_agent_count?: number;
  /** agent-fixed only */
  agent_id?: string;
  /** Asset visibility scope: agent-fixed / my-agents return it mapped from visibility; team-assets does not return it (always team) */
  scope?: 'team' | 'private';
}

/** Layered lazy-loading entry */
export interface ChatMemoryLayerItem {
  id: string;
  role?: string;
  title: string;
  body: string;
  tags?: string[];
  refs?: string[];
  /** Entry creation/record time (ISO8601), converted by the backend from recorded_at_ms / created_time_ms / updated_at */
  created_at?: string;
}

/** L1 semantic search hit: the layered entry plus a relevance score (larger is more relevant) */
export interface ChatMemorySearchHit extends ChatMemoryLayerItem {
  score?: number;
}

const CHAT_MEMORY_PREFIX = '/api/v1/chat-memory';

async function chatMemoryCall<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>(
    'POST',
    `${CHAT_MEMORY_PREFIX}/${endpoint}`,
    body,
    {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    },
  );
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

export const chatMemoryApi = {
  /** Team Memory pool: all shared chat_memory of the current team */
  teamAssets: (teamId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[]; total: number }>('team-assets', { team_id: teamId }),

  /** Agent fixed assets */
  agentFixed: (agentId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[]; total: number }>('agent-fixed', {
      agent_id: agentId,
    }),

  /** My asset allocation (list of agents with owner=me) */
  myAgents: (teamId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[] }>('my-agents', { team_id: teamId }),

  /** L0/L1/L2/L3 layered lazy loading; L2 can pass path to lazily read a single Markdown source.
   *  L0 cursor pagination: the first page passes offset=0; later pages pass beforeTs (created_at of the last message),
   *  the backend filters by time_end and offset resets to zero, avoiding large-offset VDB scans. */
  layer: (
    blockId: string,
    l: 'L0' | 'L1' | 'L2' | 'L3',
    limit = 50,
    offset = 0,
    path?: string,
    beforeTs?: string,
    timeStart?: string,
    timeEnd?: string,
  ) =>
    chatMemoryCall<{
      layer: string;
      items: ChatMemoryLayerItem[];
      total: number;
      limit: number;
      offset: number;
    }>('layer', {
      block_id: blockId,
      layer: l,
      limit,
      offset,
      ...(path ? { path } : {}),
      ...(beforeTs ? { before_ts: beforeTs } : {}),
      // Detail page time filter (ISO8601), effective only for L0 / L1; the backend ignores it for L2 / L3
      ...(timeStart ? { time_start: timeStart } : {}),
      ...(timeEnd ? { time_end: timeEnd } : {}),
    }),

  /** Batch set the fixed memory of an agent; the backend atomically validates the borrow limit. */
  setAgentFixed: (teamId: string, agentId: string, blockIds: string[]) =>
    chatMemoryCall<{ updated: boolean; agent_id: string; block_ids: string[] }>('set-agent-fixed', {
      team_id: teamId,
      agent_id: agentId,
      block_ids: blockIds,
    }),

  /** Borrow an asset into my agent */
  allocate: (teamId: string, blockId: string, agentId: string) =>
    chatMemoryCall<{ allocated: boolean; agent_id: string; block_id: string }>('allocate', {
      team_id: teamId,
      block_id: blockId,
      agent_id: agentId,
    }),

  /** Unbind from the agent */
  unbind: (teamId: string, blockId: string, agentId: string) =>
    chatMemoryCall<{ unbound: boolean; agent_id: string; block_id: string }>('unbind', {
      team_id: teamId,
      block_id: blockId,
      agent_id: agentId,
    }),

  /** Manually create a standalone UserAsset */
  create: (teamId: string, title: string, scope: 'team' | 'private', description?: string) =>
    chatMemoryCall<ChatMemoryBlock>('create', { team_id: teamId, title, scope, description }),

  /** Switch asset visibility scope */
  patchScope: (blockId: string, scope: 'team' | 'private') =>
    chatMemoryCall<{ updated: boolean; id: string; scope: string }>('patch-scope', {
      block_id: blockId,
      scope,
    }),

  /** Import historical conversation into the agent's L0 (goes through /v3/conversation/add) */
  import: (params: {
    teamId: string;
    agentId: string;
    messages: Array<{ role: string; content: string }>;
    sessionId?: string;
  }) =>
    chatMemoryCall<{
      imported: boolean;
      block_id: string;
      session_id: string;
      accepted_count: number;
    }>('import', {
      team_id: params.teamId,
      agent_id: params.agentId,
      messages: params.messages,
      session_id: params.sessionId,
    }),

  /** Edit single-layer memory content (Owner-only):
   *  L1 passes id=record primary key + content; L2 passes id=file path + content (optional summary);
   *  L3 passes only content (overwrite the whole core persona). */
  updateLayer: (
    blockId: string,
    layer: 'L1' | 'L2' | 'L3',
    params: { id?: string; content: string; summary?: string },
  ) =>
    chatMemoryCall<{
      id?: string;
      path?: string;
      version?: string;
      updated_at?: string;
    }>('layer-update', {
      block_id: blockId,
      layer,
      ...(params.id ? { id: params.id } : {}),
      content: params.content,
      ...(params.summary !== undefined ? { summary: params.summary } : {}),
    }),

  /** Layered semantic / keyword search (agent dimension, cross-session recall, hits carry score):
   *  L0 = conversation message retrieval; L1 = atomic memory retrieval. */
  searchLayer: (
    blockId: string,
    layer: 'L0' | 'L1',
    query: string,
    limit = 30,
    type?: string,
  ) =>
    chatMemoryCall<{ items: ChatMemorySearchHit[]; total: number }>('search', {
      block_id: blockId,
      layer,
      query,
      limit,
      ...(type ? { type } : {}),
    }),
};
