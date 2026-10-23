import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WishlistObjectModal } from '../planner/WishlistObjectModal';
import { PlanNightModal } from './PlanNightModal';
import { getPlannerTargets } from '../../lib/api/planner';
import type { ExploreRow } from '../../lib/api/explore';
import type { WishlistCandidate } from '../../hooks/useWishlist';
import type { WishlistItem, WishlistPriority } from '../../lib/api/wishlist';
import type { PlanResult } from './usePlanObject';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  rows: ExploreRow[];
  openId: string;
  onOpenId: (id: string | null) => void;
  siteId: string | null;
  minAlt: number;
  wishlistItems: WishlistItem[];
  onAdd: (candidate: WishlistCandidate) => void;
  onSetPriority: (id: string, priority: WishlistPriority) => void;
  onSetNotes: (id: string, notes: string) => void;
  onRemove: (id: string) => void;
  planOnNight: (row: ExploreRow, date: string) => Promise<PlanResult>;
}

/**
 * The object sheet: the same popup the Wishlist and Planner open (image,
 * description, best-months chart, tonight's altitude curve, add/remove),
 * reached from any Explore card or search row, plus a "Plan a night…" action
 * that opens the ranked night picker. Prev/next step through whatever list
 * the sheet was opened from.
 */
export function ExploreObjectSheet({
  rows, openId, onOpenId, siteId, minAlt, wishlistItems, onAdd, onSetPriority, onSetNotes, onRemove, planOnNight,
}: Props) {
  const { isDark, isNight, isSpace } = useTheme();
  const [planning, setPlanning] = useState(false);

  // The same call the Wishlist page makes, for the observer coordinates, the
  // moon and tonight's target (altitude curve, "up tonight").
  const planner = useQuery({
    queryKey: ['planner-targets', 'explore-sheet', siteId],
    queryFn: () => getPlannerTargets(siteId ? { siteId } : undefined),
    staleTime: 60_000,
  });

  const index = rows.findIndex(r => r.id === openId);
  const row = index >= 0 ? rows[index] : null;
  if (!row) return null;

  const real = wishlistItems.find(i => i.objectId === row.id);
  const target = planner.data?.targets.find(t => t.id === row.id);

  return (
    <>
      <WishlistObjectModal
        item={real ?? {
          id: row.id,
          objectId: row.id,
          name: row.name,
          type: row.type,
          constellation: row.constellation,
          magnitude: row.magnitude,
          majorAxisArcmin: row.majorAxisArcmin,
          priority: 'medium',
          notes: '',
          addedAt: new Date().toISOString(),
        }}
        isPreview={!real}
        onAdd={onAdd}
        target={target}
        isImaged={row.isImaged}
        libraryObjectId={row.libraryObjectId}
        observerLat={planner.data?.observerLat ?? null}
        observerLon={planner.data?.observerLon ?? null}
        minAlt={minAlt}
        moonIllumination={planner.data?.moonIllumination}
        observerTimezone={planner.data?.observerTimezone ?? undefined}
        isDark={isDark}
        isNight={isNight}
        isSpace={isSpace}
        onSetPriority={onSetPriority}
        onSetNotes={onSetNotes}
        onRemove={onRemove}
        onPlanNight={row.visibility && row.visibility.kind !== 'never' ? () => setPlanning(true) : undefined}
        onClose={() => onOpenId(null)}
        hasPrev={index > 0}
        hasNext={index < rows.length - 1}
        onPrev={() => onOpenId(rows[Math.max(0, index - 1)].id)}
        onNext={() => onOpenId(rows[Math.min(rows.length - 1, index + 1)].id)}
      />
      {planning && (
        <PlanNightModal
          row={row}
          siteId={siteId}
          isDark={isDark}
          plan={date => planOnNight(row, date)}
          onClose={() => setPlanning(false)}
        />
      )}
    </>
  );
}
