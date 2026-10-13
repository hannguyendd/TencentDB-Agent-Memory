/**
 * SourceFetcherRegistry — routes to the matching ISourceFetcher by the sourceUrl protocol.
 *
 * The worker in module.ts obtains a fetcher via registry.resolve(url) and no longer calls git directly.
 * To add a protocol in the future, just implements ISourceFetcher + register().
 */

import type { ISourceFetcher, SourceType } from "./types.js";
import { GitSourceFetcher } from "./git-fetcher.js";

export class SourceFetcherRegistry {
  private readonly fetchers = new Map<SourceType, ISourceFetcher>();

  constructor() {
    this.register(new GitSourceFetcher());
    // Future: this.register(new LocalSourceFetcher());
    // Future: this.register(new FtpSourceFetcher());
  }

  register(fetcher: ISourceFetcher): void {
    this.fetchers.set(fetcher.supportedType, fetcher);
  }

  /** Auto-detect the protocol type from sourceUrl and return the matching fetcher; throw if not registered. */
  resolve(sourceUrl: string): ISourceFetcher {
    const type = this.detectType(sourceUrl);
    const fetcher = this.fetchers.get(type);
    if (!fetcher) {
      throw new Error(`unsupported source type: ${type} (${sourceUrl})`);
    }
    return fetcher;
  }

  private detectType(url: string): SourceType {
    if (
      url.startsWith("git@") ||
      url.startsWith("ssh://") ||
      url.startsWith("https://") ||
      url.startsWith("http://")
    ) {
      return "git";
    }
    if (url.startsWith("file://") || url.startsWith("/") || url.startsWith("./")) {
      return "local";
    }
    if (url.startsWith("ftp://")) return "ftp";
    return "git";
  }
}
