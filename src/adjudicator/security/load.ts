/**
 * Where engine.ts, ../prompt.ts and ../providers/typesafe.ts reach the security prompt helpers
 * (prompt.ts here, and THREATS of types.ts) without importing security/ themselves.
 * They need them only for a request that carries hints.security, which only security code
 * builds; with security off nothing of security/ may load on the hook path (the adjudicator-on,
 * security-off case of adjudicator-hooks-off.test.ts), and the server bundle forbids a dynamic
 * import() of an internal module (scripts/check-bundle.mjs), so the helpers cannot be fetched
 * lazily. Instead advice.ts (which every producer of a hint loads: assess, the CLI, the
 * eval) imports ./register.js, and that registers them here.
 *
 * The consumers are synchronous (a cache key, the items of a request, the answer parse). Reading
 * the helpers before anything registered them is a bug in the caller, so security() throws.
 */

export type SecurityLib = {
  prompt: typeof import("./prompt.js");
  types: typeof import("./types.js");
};

let lib: SecurityLib | undefined;

/** Called once by register.ts. */
export function registerSecurity(l: SecurityLib): void {
  lib = l;
}

/** The registered helpers; only for a request that carries hints.security. */
export function security(): SecurityLib {
  if (!lib)
    throw new Error(
      "security prompt helpers are not registered: import src/adjudicator/security/register.js before building a request with hints.security",
    );
  return lib;
}
