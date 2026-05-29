import { Page, Route } from "playwright";
import { ResourceFilterConfig, ResourceType } from "./types";
import { Logger } from "./logger";

/**
 * Converts a glob-style pattern string into a RegExp.
 * Supports * (any char except /) and ** (any char including /).
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") /* escape regex specials */
    .replace(/\*\*/g, "§DOUBLE§")          /* protect **           */
    .replace(/\*/g, "[^/]*")               /* * → not-a-slash      */
    .replace(/§DOUBLE§/g, ".*");           /* ** → anything        */
  return new RegExp(escaped, "i");
}

export class ResourceFilter {
  private readonly blockedTypes: Set<string>;
  private readonly blockedPatterns: RegExp[];

  constructor(
    private readonly config: ResourceFilterConfig,
    private readonly logger: Logger
  ) {
    this.blockedTypes = new Set<string>(config.blockedTypes);
    this.blockedPatterns = config.blockedUrlPatterns.map((p) =>
      p.startsWith("/") && p.endsWith("/")
        ? new RegExp(p.slice(1, -1), "i") /* treat /regex/ as regex literal */
        : globToRegex(p)
    );
  }

  /**
   * Attaches an intercept handler to the given Playwright Page.
   * Must be called before the first navigation on that page.
   */
  attach(page: Page): void {
    page.route("**/*", (route: Route) => {
      const request = route.request();
      const resourceType = request.resourceType() as ResourceType;
      const url = request.url();

      const abort = (reason: string, extra: Record<string, unknown>): void => {
        this.logger.debug(reason, undefined, extra);
        route.abort().catch((err: unknown) => {
          this.logger.warn("resource.abort.failed", undefined, {
            url,
            error: String(err),
          });
        });
      };

      if (this.blockedTypes.has(resourceType)) {
        abort("resource.blocked.type", { resourceType, url });
        return;
      }

      for (const pattern of this.blockedPatterns) {
        if (pattern.test(url)) {
          abort("resource.blocked.pattern", { url, pattern: pattern.source });
          return;
        }
      }

      route.continue().catch((err: unknown) => {
        this.logger.warn("resource.continue.failed", undefined, {
          url,
          error: String(err),
        });
      });
    });
  }
}
