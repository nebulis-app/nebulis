/**
 * Which telescope shot this session, with an admin popover to reassign it.
 *
 * Styled for the session hero, which is dark imagery in every theme, so it
 * takes the glass treatment the Catalogs panels use rather than branching on
 * isDark. The reassign popover is the one part that drops back onto a solid
 * surface: a translucent menu over a photograph is unreadable.
 */
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { CheckCircle2, Pencil } from 'lucide-react';
import { reassignSessionTelescope } from '../../lib/api/telescopes';
import type { TelescopeProfile } from '../../lib/api/telescopes';
import { useClickOutside } from '../../hooks/useClickOutside';

export function TelescopeChip({
  objectId,
  date,
  telescope,
  telescopes,
  isAdmin,
}: {
  objectId: string;
  date: string;
  telescope: TelescopeProfile;
  telescopes: TelescopeProfile[];
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useClickOutside(wrapRef, () => setOpen(false), { enabled: open, closeOnEscape: true });

  const reassign = useMutation({
    mutationFn: (newTelescopeId: string) => reassignSessionTelescope(objectId, date, newTelescopeId),
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
      queryClient.invalidateQueries({ queryKey: ['library-sessions', objectId] });
    },
  });

  return (
    <span ref={wrapRef} className="relative inline-flex items-center">
      <Link
        to={`/observations?telescopeId=${encodeURIComponent(telescope.id)}`}
        className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-2.5 py-1
          text-[11.5px] font-medium text-white/80 ring-1 ring-inset ring-white/15 backdrop-blur-md
          transition-colors hover:bg-white/15 hover:text-white
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        title={`Captured on ${telescope.name}. Click to see its other sessions.`}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: telescope.color }}
          aria-hidden="true"
        />
        {telescope.name}
      </Link>

      {isAdmin && (
        <button
          onClick={() => setOpen(o => !o)}
          className="ml-1 rounded-md p-1 text-white/40 transition hover:bg-white/10 hover:text-white
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          title="Reassign to a different telescope"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-56 rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl">
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Reassign to
          </div>
          {telescopes.map(t => (
            <button
              key={t.id}
              onClick={() => reassign.mutate(t.id)}
              disabled={reassign.isPending || t.id === telescope.id}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs
                text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} />
              <span className="flex-1 truncate">{t.name}</span>
              {t.id === telescope.id && <CheckCircle2 className="h-3 w-3 text-teal-500" />}
            </button>
          ))}
          {reassign.isError && (
            <div className="mt-1 px-2 py-1 text-[11px] text-red-400">Reassignment failed</div>
          )}
        </div>
      )}
    </span>
  );
}
