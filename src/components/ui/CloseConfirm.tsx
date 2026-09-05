/**
 * Inline confirm bar shown when a modal with unsaved state is about to close.
 * Sits absolutely at the bottom of the parent modal panel and offers two
 * choices: keep editing (cancel the close) or discard (proceed). Designed to
 * be rendered as the last child of a relatively-positioned modal panel.
 *
 * Use over `window.confirm` so the prompt looks native to the app and stays
 * inside the focus-trapped modal.
 */
export function CloseConfirm({
  message,
  cancelLabel = 'Keep editing',
  onCancel,
  onDiscard,
  isDark = true,
}: {
  message: string;
  /** Label for the cancel button. Defaults to "Keep editing" for form-style
   * callers; pass something like "Keep syncing" when the modal is closing
   * an in-progress operation rather than discarding edits. */
  cancelLabel?: string;
  onCancel: () => void;
  onDiscard: () => void;
  /** Every current caller passes its own `useTheme().isDark`; defaults to the
   * dark styling that shipped originally in case a future caller forgets. */
  isDark?: boolean;
}) {
  return (
    <div
      className="absolute inset-x-0 bottom-0 z-30"
      role="alertdialog"
      aria-label="Confirm close"
      onClick={e => e.stopPropagation()}
    >
      <div className={`border-t px-5 py-3 flex items-center justify-between gap-4 shadow-2xl ${
        isDark ? 'bg-slate-900 text-slate-100 border-slate-700' : 'bg-white text-slate-800 border-slate-200'
      }`}>
        <p className="text-sm font-medium">{message}</p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            autoFocus
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
