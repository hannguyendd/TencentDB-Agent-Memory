/**
 * source-fetcher barrel — external exports of the source fetch interface layer.
 */

export type { ISourceFetcher, FetchResult, SourceType } from "./types.js";
export { GitSourceFetcher, type GitSourceFetcherOptions } from "./git-fetcher.js";
export { SourceFetcherRegistry } from "./registry.js";
