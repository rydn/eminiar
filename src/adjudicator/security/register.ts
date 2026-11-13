/**
 * Registers the security prompt helpers with load.ts. Imported (for this effect) by
 * advice.ts, which every producer of a security hint loads (assess, the CLI, the eval), so any
 * process that can build a hint can also key and ask it. Never imported on the hook path while
 * security is off.
 */
import { registerSecurity } from "./load.js";
import * as prompt from "./prompt.js";
import * as types from "./types.js";

registerSecurity({ prompt, types });
