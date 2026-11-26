import { useQuery } from '@tanstack/react-query';
import { useResolvedFov } from './useResolvedFov';
import { getTelescopeNightRate } from '../lib/api/telescopes';
import { telescopeIdOfFovProfile } from '../lib/telescopeFov';

/**
 * The telescope the planner plans for: the one its framing follows (the Framing & Mosaic pick, else the configured
 * telescope; see useResolvedFov). `telescopeId` is null when the framing is a preset or custom optics rather than a
 * telescope profile; the planner then plans as it did before it knew the telescope.
 */
export function usePlannerTelescope() {
  const fov = useResolvedFov();
  const telescopeId = telescopeIdOfFovProfile(fov.profileId);
  const { data: nightRate } = useQuery({
    queryKey: ['telescope-night-rate', telescopeId],
    queryFn: () => getTelescopeNightRate(telescopeId!),
    enabled: telescopeId != null,
    staleTime: 10 * 60_000,
  });
  return { fov, telescopeId, nightRate: telescopeId ? nightRate ?? null : null };
}
