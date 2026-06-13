// Static re-export of sharp so the tsup bundler can inline sharp's pure-JS
// code (lib/*.js, detect-libc, semver, @img/colour) into the pkg snapshot.
// The only runtime resolution that remains is the dynamic
// `require('@img/sharp-${runtimePlatform}/sharp.node')` inside sharp itself.
// In a pkg binary that require is unresolvable from within /snapshot/, so
// './pkg-disk-paths' must run FIRST: it prepends the on-disk node_modules
// directory next to the binary to Node's global module search path, letting
// the @img/sharp-<arch> package ship-on-disk resolve through normal Node
// resolution. Side-effect import only.
//
// A previous version used `createRequire(import.meta.url)` + try/catch to
// soft-fail when sharp couldn't load. That pattern hid require() from the
// bundler, leaving the pkg snapshot with an unresolved `require('sharp')`
// and every thumbnail endpoint returning 500 with "object null is not a
// function". Static imports here fail fast with sharp's own diagnostic
// message at startup instead, which is far easier to debug.
import './pkg-disk-paths.js';
import sharp from 'sharp';

export default sharp;
