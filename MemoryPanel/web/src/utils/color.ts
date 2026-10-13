/**
 * Color utilities -- extracted from App.tsx
 *
 * Team avatar colors: picked stably by team_id, ensuring the same team always shows the same color.
 */

/** Team avatar color list */
export const TEAM_AVATAR_COLORS = [
  'bg-rose-500', 'bg-amber-500', 'bg-blue-500', 'bg-emerald-500', 'bg-violet-500',
  'bg-cyan-600', 'bg-orange-500', 'bg-pink-500', 'bg-teal-500', 'bg-indigo-500',
];

/**
 * Pick a Tailwind background color class name stably from a seed (usually team_id).
 * The same seed always returns the same color.
 */
export function teamColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TEAM_AVATAR_COLORS[h % TEAM_AVATAR_COLORS.length];
}
