// Augment React's JSX types with non-standard DOM attributes that are widely
// supported by browsers but not yet in the standard HTMLInputElement typing.
import 'react';

declare module 'react' {
  interface InputHTMLAttributes<T> {
    /**
     * Chromium/WebKit folder-picker attribute. When present on a
     * `<input type="file">`, users are prompted to select a directory and
     * the input's `files` list contains every file in that directory tree
     * with the relative path exposed on `File.webkitRelativePath`.
     *
     * Supported in Chrome, Edge, Safari, and Firefox (behind a flag on
     * older versions). Not standardized in the HTML spec.
     */
    webkitdirectory?: string;
  }
}
