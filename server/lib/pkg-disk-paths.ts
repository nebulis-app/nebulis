/**
 * pkg snapshot → real-disk module resolution bridge.
 *
 * When the server runs as a `@yao-pkg/pkg` binary, all of its bundled JS lives
 * under a virtual /snapshot/ filesystem. A bare `require('@img/sharp-<arch>/sharp.node')`
 * issued by sharp's internal loader resolves only against that snapshot —
 * which doesn't contain native bindings — and throws. The `--public-packages`
 * pkg flag does not help here: it only controls whether a package's source is
 * decompressed inside the snapshot, not whether requires fall through to disk.
 *
 * Fix: prepend `<dir-of-the-pkg-binary>/node_modules` to Node's global module
 * search path before sharp is imported. The platform-specific @img/sharp-*
 * package (shipped next to the binary by build-mac.mjs / build-win.mjs) then
 * resolves through the normal Module._resolveFilename → globalPaths walk.
 *
 * This file must be evaluated BEFORE any code that loads sharp. Side-effect
 * import only — there are no exports.
 *
 * No-op outside pkg (dev, tests, Docker).
 */
import { Module } from 'node:module';
import path from 'node:path';

// `pkg` is injected on `process` by the @yao-pkg/pkg runtime. The `in` check
// narrows without needing a cast or a global type augmentation.
if ('pkg' in process) {
  const onDiskModules = path.join(path.dirname(process.execPath), 'node_modules');
  // Both legs of the fix:
  //   1. NODE_PATH propagates the path to child processes / nested resolvers.
  //   2. _initPaths() forces this Module instance to rebuild globalPaths
  //      from the updated NODE_PATH so the change applies to the current
  //      process. Without (2), the env update would only affect children.
  process.env.NODE_PATH = process.env.NODE_PATH
    ? `${onDiskModules}${path.delimiter}${process.env.NODE_PATH}`
    : onDiskModules;
  // _initPaths is an undocumented but ancient and stable Module internal —
  // it's what `Module` itself calls during startup to populate globalPaths.
  (Module as unknown as { _initPaths: () => void })._initPaths();
}
