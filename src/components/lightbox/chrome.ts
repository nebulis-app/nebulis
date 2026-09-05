/**
 * Toolbar chrome shared by both lightboxes.
 *
 * The viewer is night-side in every theme, the same rule the session hero and
 * the planner's night canvas follow: what fills it is a photograph of the sky,
 * so the surround stays black and the controls are glass on dark rather than
 * theme-driven slate. Nothing here branches on `isDark`.
 *
 * The classes live in one module because the two viewers pass their own action
 * buttons into `LightboxFrame` as a slot. When each viewer spelled those styles
 * out itself they drifted, which is the same failure `LightboxFrame` was
 * created to end.
 *
 * Active states use `accent-400` / `accent-500/15` deliberately: those exact
 * utilities are the ones `.night` and `.space` remap in `src/index.css`, so the
 * toolbar follows the theme's accent instead of staying gold in red-light mode.
 */

/** Rounded container that groups related controls into one glass pill. */
export const LB_GROUP =
  'flex items-center gap-0.5 rounded-full bg-white/[0.06] p-1 ring-1 ring-inset ring-white/10 backdrop-blur-md';

/** Icon-only button inside a group. */
export const LB_ICON_BTN =
  'inline-flex h-8 w-8 items-center justify-center rounded-full text-white/60 outline-none transition '
  + 'hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 '
  + 'disabled:pointer-events-none disabled:opacity-25';

/** Text button inside a group, e.g. "Fit", "1:1", "FITS Header". */
export const LB_TEXT_BTN =
  'inline-flex h-8 items-center justify-center rounded-full px-2.5 text-[11.5px] font-medium '
  + 'whitespace-nowrap text-white/60 outline-none transition hover:bg-white/15 hover:text-white '
  + 'focus-visible:ring-2 focus-visible:ring-white/60 disabled:pointer-events-none disabled:opacity-25';

/** Appended to either button when the control it represents is the current state. */
export const LB_ACTIVE = 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/20 hover:text-accent-400';

/** Destructive action. Kept red rather than accent: it is not a brand moment. */
export const LB_DANGER_BTN =
  'inline-flex h-8 w-8 items-center justify-center rounded-full text-red-400 outline-none transition '
  + 'hover:bg-red-500/15 hover:text-red-300 focus-visible:ring-2 focus-visible:ring-white/60 '
  + 'disabled:pointer-events-none disabled:opacity-25';

/** Standalone glass button, used for Close. Sits outside every group so the one
 *  control that dismisses the viewer is never mistaken for a tool. */
export const LB_CLOSE_BTN =
  'inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/70 '
  + 'ring-1 ring-inset ring-white/10 backdrop-blur-md outline-none transition hover:bg-white/15 hover:text-white '
  + 'focus-visible:ring-2 focus-visible:ring-white/60';
