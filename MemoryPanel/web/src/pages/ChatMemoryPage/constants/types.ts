import type { ChatMemoryLayerItem } from '@/lib/teamApi';
export type { ScopeTab } from '@/lib/asset-common';

export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3';

export type LayerTone = 'default' | 'brand' | 'success' | 'warning';

export interface LayerMeta {
  id: MemoryLayer;
  label: string;
  short: string;
  desc: string;
  tone: LayerTone;
}

export interface AtomicItem {
  id: string;
  title: string;
  body: string;
  refs?: string[];
  tags?: string[];
  /** Entry creation/record time (ISO8601), display only, not used for sorting */
  created_at?: string;
}

export interface MemoryBlock {
  id: string;
  title: string;
  summary?: string;
  tags: string[];
  updated_at_ms: number;
  agent_id?: string;
  uploaded_by_user_id: string;
  scope?: 'team' | 'private';
  layer_counts: { L0_messages: number; L1: number; L2: number; L3: number };
  bound_agent_count?: number;
  layers: {
    L0: ChatMemoryLayerItem[];
    L1: AtomicItem[];
    L2: AtomicItem[];
    L3: AtomicItem[];
  };
  layerCounts: Partial<Record<MemoryLayer, number>>;
  /** Whether L0 has loaded to the earliest under the current time filter (set when "Load earlier" adds no new data, used to hide the entry point) */
  l0Ended?: boolean;
}

export interface AgentOption {
  agent_id: string;
  name: string;
}
