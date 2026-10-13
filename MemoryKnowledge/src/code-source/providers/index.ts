/**
 * Built-in provider registration entry.
 *
 * The **only change point** for onboarding a new platform:
 *   1. Create `<id>.ts` in the same directory, exporting `<id>Provider: ICodeSourceProvider`
 *   2. Add one line to the BUILTIN_PROVIDERS array below
 *
 * Whether a platform is enabled is decided by the deployment env `CODE_SOURCE_ENABLED`, decoupled from this table.
 */

import type { ICodeSourceProvider } from "../types.js";
import { gongfengProvider } from "./gongfeng.js";

/** All built-in providers (whether enabled is filtered by CODE_SOURCE_ENABLED; not all of them are shown to users). */
export const BUILTIN_PROVIDERS: readonly ICodeSourceProvider[] = [
  gongfengProvider,
];
