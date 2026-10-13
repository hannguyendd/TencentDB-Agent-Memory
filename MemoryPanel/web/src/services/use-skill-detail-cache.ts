/**
 * useSkillDetailCache -- on-demand loading cache of skill data plane details.
 *
 * Background: the asset list returned by the asset/list-accessible endpoint contains only asset-layer fields
 * (version is always 1, no owner_agent_id); the real version and
 * owner_agent_id of the skill data plane must be obtained by calling getSkill(). The old implementation fired getSkill()
 * N times concurrently for each skill after the list loaded (N+1), pulling back all details before the user opened any.
 *
 * This hook is switched to on-demand: the list first renders with asset-layer defaults, and only after the user selects a skill
 * is that one's data plane detail fetched and written into the cache; later hits on the same skill read the cache directly.
 *
 * Usage (parent component):
 *   const { getFromCache, preload, applyCachedDetail } = useSkillDetailCache(activeTeamId);
 *   useEffect(() => { if (selectedId) void preload(selectedId); }, [selectedId]);
 *   List rendering: const s = applyCachedDetail(skill);
 */

import { useRef, useState, useCallback } from 'react';
import { getSkill } from '@/lib/api/skill-api';

export interface CachedSkillDetail {
  version: number;
  owner_agent_id: string;
}

export function useSkillDetailCache(teamId: string | null | undefined) {
  /** skill_id -> fetched data plane details (version + owner_agent_id). */
  const cacheRef = useRef(new Map<string, CachedSkillDetail>());

  /** Set of skill_ids currently being requested, preventing concurrent duplicate requests for the same skill. */
  const inFlightRef = useRef(new Set<string>());

  /** +1 after each cache write; parent components depend on this value to recompute list items in useMemo. */
  const [cacheVersion, setCacheVersion] = useState(0);

  /** Synchronously read the cache (does not trigger a request). */
  const getFromCache = useCallback((skillId: string): CachedSkillDetail | undefined => {
    return cacheRef.current.get(skillId);
  }, []);

  /** Preload the data plane details of one skill (idempotent; skipped if already cached or in flight). */
  const preload = useCallback(async (skillId: string) => {
    if (!teamId || !skillId) return;
    if (cacheRef.current.has(skillId) || inFlightRef.current.has(skillId)) return;
    inFlightRef.current.add(skillId);
    try {
      const full = await getSkill({
        skill_id: skillId,
        team_id: teamId,
        include_content: false,
        include_manifest: false,
      });
      cacheRef.current.set(skillId, {
        version: full.version,
        owner_agent_id: full.owner_agent_id,
      });
      setCacheVersion((n) => n + 1);
    } catch {
      // Fail silently: the list still uses the asset defaults (v1 / empty owner_agent_id)
    } finally {
      inFlightRef.current.delete(skillId);
    }
  }, [teamId]);

  /**
   * Overwrite the version / owner_agent_id fields of the skill object with the latest values in the cache.
   * On a cache miss it is returned as-is without affecting rendering.
   */
  const applyCachedDetail = useCallback(<T extends { skill_id: string; version: number; owner_agent_id: string }>(
    skill: T,
  ): T => {
    const cached = cacheRef.current.get(skill.skill_id);
    if (!cached) return skill;
    return { ...skill, version: cached.version, owner_agent_id: cached.owner_agent_id };
  }, []);

  return { getFromCache, preload, applyCachedDetail, cacheRef, cacheVersion };
}
