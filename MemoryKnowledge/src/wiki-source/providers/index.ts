/**
 * Built-in provider registration entry (symmetric with code-source/providers/index.ts).
 *
 * The **only change point** for onboarding a new platform:
 *   1. Create `<id>/index.ts` in the same directory, exporting `<id>Provider: WikiSourceProvider`
 *   2. Add a line to the BUILTIN_PROVIDERS array below
 *
 * Whether a platform is enabled is decided by the deployment env `WIKI_SOURCE_ENABLED`, decoupled from this table.
 * The registry therefore **imports no concrete provider**.
 */

import type { WikiSourceProvider } from "../types.js";
import { iwikiProvider } from "./iwiki/index.js";

/** All built-in providers (whether enabled is filtered by WIKI_SOURCE_ENABLED; it does not mean all are shown to users). */
export const BUILTIN_PROVIDERS: readonly WikiSourceProvider[] = [iwikiProvider];
