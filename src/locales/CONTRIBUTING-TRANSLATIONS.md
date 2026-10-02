# Contributing a translation

Nebulis's UI text lives in per-feature JSON files under `src/locales/<language>/<namespace>.json`, one folder per language. English (`en`) is the source of truth; every other language should carry the exact same set of files and the exact same keys inside each file.

## Current languages

| Code | Language |
|---|---|
| `en` | English (source) |
| `de` | Deutsch |
| `fr` | Français |
| `es` | Español |
| `nl` | Nederlands |

German, French, and Spanish were produced by AI translation and have **not** been reviewed by a native speaker. If you're fluent in one of these and spot something wrong, awkward, or too literal, please open an issue or a pull request against the relevant files below.

Dutch was translated with AI assistance and reviewed file by file by a contributor.

## Namespaces

Each JSON file covers one feature area. You can translate a single namespace at a time — you don't need to touch the whole app in one pass.

| File | Covers |
|---|---|
| `common.json` | Shared chrome: nav, generic buttons, confirm dialogs, moon phases, compass directions, the update banner |
| `settings.json` | The Settings page, all its sections and modals, the System Log |
| `library.json` | The Library, Object Detail, Image Gallery, image editor, backup/sync |
| `observations.json` | Observations calendar/list/map, Observation Detail, session modals |
| `planner.json` | The Planner |
| `forecast.json` | Sky Forecast |
| `catalogs.json` | Catalog boards (Messier, Caldwell, Herschel 400, Sharpless) |
| `help.json` | The Help page and What's New |
| `onboarding.json` | First-run setup |
| `errors.json` | Generic client-side error strings |

## Adding a new language

1. Copy the entire `src/locales/en/` folder to `src/locales/<code>/`, using the language's [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes) two-letter code (e.g. `it` for Italian, `ja` for Japanese).
2. Translate the values in each file. **Never change a key name** — only the string on the right of the `:`. Leave anything wrapped in `{{double braces}}` exactly as it is; those are placeholders the app fills in at runtime (a name, a count, a date). A sentence with a numbered tag like `<1>...</1>` is a bolded or linked span — keep the tags, translate the text between them.
3. A key ending in `_one` / `_other` (occasionally `_zero`/`_two`/`_few`/`_many`) is a plural pair driven by a `{{count}}` placeholder. English only needs `_one`/`_other`; some languages need more forms (see [CLDR plural rules](https://cldr.unicode.org/index/cldr-spec/plural-rules) for your language) — add whichever suffixes your language's grammar requires.
4. Register the new language in `src/i18n.ts`:
   - Add one `import` line per namespace, following the existing `de`/`fr`/`es` pattern (`import xxCommon from './locales/xx/common.json';`, etc.)
   - Add your language code and its native display name to the `SUPPORTED_LANGUAGES` array.
   - Add a `resources.xx` block listing every namespace, mirroring the existing `de`/`fr`/`es` blocks.
5. Run the test suite: `npm run test`. `tests/frontend/i18nKeys.test.ts` checks that every translation key used in the code resolves — it doesn't check your new language's file content directly, but it will catch a broken merge or a missing file.
6. A quick manual check: run `npm run dev`, open Settings → General, switch the language dropdown to yours, and click through the app looking for anything still in English (a missing key silently falls back to English rather than erroring, so this is the only way to catch a gap).

## Editing an existing translation

Find the string in the relevant `src/locales/<code>/<namespace>.json` file (searching for a snippet of the English text in `src/locales/en/<namespace>.json` first is usually the fastest way to find the right key) and edit the value. Keep placeholders and tags intact, as above. No code changes are needed for a wording fix.

## What isn't translated yet

- Backend-generated error and log prose (API error messages, connectivity/import failure text) is English-only. This is a larger, separate piece of work that needs a server-side error-code system before it can be translated client-side, and isn't part of this UI-text translation process.
- Server-sourced editorial content (catalog object descriptions, changelog entries) stays in its original language.
