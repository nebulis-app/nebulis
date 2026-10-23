/**
 * The "name the objects" icon, shared look across web, iOS and macOS: a dashed ring (what the overlay draws round
 * each object) with a four-point sparkle inside. Takes the surrounding text colour like a lucide icon.
 */
export function AnnotateIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="10.2" strokeWidth="2" strokeLinecap="round" strokeDasharray="0.1 3.4" />
      <path
        d="M12 5.5 Q13 11 18.5 12 Q13 13 12 18.5 Q11 13 5.5 12 Q11 11 12 5.5Z"
        fill="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
