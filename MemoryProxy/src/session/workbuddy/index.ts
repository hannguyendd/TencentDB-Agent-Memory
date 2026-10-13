/**
 * WorkBuddy session-init layer unified exports.
 *
 * ⚠️ Independence rule: this barrel exposes only workbuddy's own types and entry points; it no longer re-exports
 * session-init content from other clients. The caller (workbuddyHandler) gets
 * all necessary interfaces from here in one place.
 */

export {
  handleWorkbuddySessionInit,
  type WorkbuddySessionInitResult,
  type WorkbuddyRequestContext,
} from "./init.js";
