// Next's ambient types, referenced here rather than relying on the generated
// next-env.d.ts.
//
// next-env.d.ts is gitignored AND imports ./.next/types/routes.d.ts, which only
// exists after a build — so on a fresh clone (or in CI) it is either missing or
// unusable, and every `import img from "./foo.png"` fails with TS2307. These two
// references restore the image/asset module declarations without needing a build.
//
// Safe to keep alongside next-env.d.ts locally: reference directives are
// idempotent.

/// <reference types="next" />
/// <reference types="next/image-types/global" />
