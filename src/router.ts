/**
 * A small, framework-agnostic HTTP router built on a radix-style trie.
 *
 * Matching rules, in priority order at every segment:
 *   1. static segment  (`/users/new` beats `/users/:id`)
 *   2. parameter segment (`/users/:id`)
 *   3. wildcard segment (`/files/*` consumes the rest of the path)
 *
 * The router does no I/O itself: give it a method and a path and it returns
 * the handler, the extracted parameters, and the parsed query string. That
 * keeps it testable without a server and adaptable to any HTTP framework.
 */

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface RouteContext {
  method: HttpMethod;
  /** Normalised path (no trailing slash, no duplicate slashes). */
  path: string;
  /** Decoded `:param` and `*` captures. */
  params: Record<string, string>;
  /** Query string; repeated keys become an array of values. */
  query: Record<string, string | string[]>;
}

export type Handler = (
  ctx: RouteContext,
) => unknown | Promise<unknown>;

export type Middleware = (
  ctx: RouteContext,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

export interface MatchResult {
  handler: Handler;
  params: Record<string, string>;
  /** Global middlewares first, then the route's own, in registration order. */
  middlewares: Middleware[];
}

export interface HandleResult {
  status: number;
  body: unknown;
  /** Populated only for 405 responses. */
  allowed?: HttpMethod[];
}

interface RouteRecord {
  method: HttpMethod;
  path: string;
  handler: Handler;
  middlewares: Middleware[];
}

interface TrieNode {
  /** Static children, keyed by segment. */
  staticChildren: Map<string, TrieNode>;
  /** Single `:param` child, if any. */
  paramChild: { name: string; node: TrieNode } | null;
  /** Single `*` child, if any; always terminal. */
  wildcardChild: { name: string; node: TrieNode } | null;
  /** Handlers registered exactly at this node, keyed by method. */
  handlers: Map<HttpMethod, RouteRecord>;
}

function newNode(): TrieNode {
  return {
    staticChildren: new Map(),
    paramChild: null,
    wildcardChild: null,
    handlers: new Map(),
  };
}

/** `/users//42/` -> `/users/42`; `/` stays `/`. */
export function normalizePath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? "";
  const collapsed = withoutQuery.replace(/\/+/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.slice(0, -1);
  }
  return collapsed === "" ? "/" : collapsed;
}

function splitSegments(path: string): string[] {
  return normalizePath(path).split("/").filter((s) => s !== "");
}

function parseQuery(path: string): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  const raw = path.split("?")[1];
  if (raw === undefined || raw === "") return query;
  for (const [key, value] of new URLSearchParams(raw)) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // A malformed escape is the caller's data, not our error.
  }
}

export class Router {
  private readonly root: TrieNode = newNode();
  private readonly globalMiddlewares: Middleware[] = [];
  private readonly routes: RouteRecord[] = [];

  /** Register a middleware that runs before every route's handler. */
  use(middleware: Middleware): this {
    this.globalMiddlewares.push(middleware);
    return this;
  }

  add(
    method: HttpMethod,
    path: string,
    handler: Handler,
    ...middlewares: Middleware[]
  ): this {
    const segments = splitSegments(path);
    let node = this.root;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string;
      if (segment === "*") {
        if (i !== segments.length - 1) {
          throw new Error(
            `Wildcard "*" must be the last segment: ${path}`,
          );
        }
        if (node.wildcardChild === null) {
          node.wildcardChild = { name: "*", node: newNode() };
        }
        node = node.wildcardChild.node;
      } else if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (name === "") {
          throw new Error(`Empty parameter name in route: ${path}`);
        }
        if (node.paramChild === null) {
          node.paramChild = { name, node: newNode() };
        } else if (node.paramChild.name !== name) {
          // One param child per node keeps matching deterministic; a second
          // name at the same position is a route-table bug, not a feature.
          throw new Error(
            `Conflicting parameter names ":${node.paramChild.name}" and ":${name}" at the same position in ${path}`,
          );
        }
        node = node.paramChild.node;
      } else {
        let child = node.staticChildren.get(segment);
        if (child === undefined) {
          child = newNode();
          node.staticChildren.set(segment, child);
        }
        node = child;
      }
    }
    const normalized = normalizePath(path);
    if (node.handlers.has(method)) {
      throw new Error(`Duplicate route: ${method} ${normalized}`);
    }
    const record: RouteRecord = {
      method,
      path: normalized,
      handler,
      middlewares,
    };
    node.handlers.set(method, record);
    this.routes.push(record);
    return this;
  }

  get(path: string, handler: Handler, ...m: Middleware[]): this {
    return this.add("GET", path, handler, ...m);
  }
  post(path: string, handler: Handler, ...m: Middleware[]): this {
    return this.add("POST", path, handler, ...m);
  }
  put(path: string, handler: Handler, ...m: Middleware[]): this {
    return this.add("PUT", path, handler, ...m);
  }
  patch(path: string, handler: Handler, ...m: Middleware[]): this {
    return this.add("PATCH", path, handler, ...m);
  }
  delete(path: string, handler: Handler, ...m: Middleware[]): this {
    return this.add("DELETE", path, handler, ...m);
  }

  /**
   * Register a set of routes under a shared prefix. The group's own global
   * middlewares become route middlewares on each grouped route, so they run
   * after this router's globals and before the route's own middlewares.
   */
  group(prefix: string, configure: (group: Router) => void): this {
    const sub = new Router();
    configure(sub);
    const base = normalizePath(prefix);
    for (const route of sub.routes) {
      const path = route.path === "/" ? base : `${base}${route.path}`;
      this.add(route.method, path, route.handler, ...sub.globalMiddlewares, ...route.middlewares);
    }
    return this;
  }

  /** All registered routes, in registration order. */
  listRoutes(): { method: HttpMethod; path: string }[] {
    return this.routes.map(({ method, path }) => ({ method, path }));
  }

  /**
   * Find the handler for a method + path without running anything.
   * Returns `null` for an unknown path, and a result with `allowed` set
   * (and no handler) when the path exists under other methods.
   */
  match(
    method: HttpMethod,
    path: string,
  ): (MatchResult & { allowed?: HttpMethod[] }) | null {
    const segments = splitSegments(path);
    const candidates = this.walkAll(this.root, segments, 0, {});
    for (const { node, params } of candidates) {
      const record = node.handlers.get(method);
      if (record !== undefined) {
        return {
          handler: record.handler,
          params,
          middlewares: [...this.globalMiddlewares, ...record.middlewares],
        };
      }
      // HEAD falls back to GET, mirroring common server behaviour.
      if (method === "HEAD") {
        const get = node.handlers.get("GET");
        if (get !== undefined) {
          return {
            handler: get.handler,
            params,
            middlewares: [...this.globalMiddlewares, ...get.middlewares],
          };
        }
      }
    }
    // No candidate serves this method, but a candidate path exists: 405.
    // A terminal node with no handlers at all (e.g. only a longer route
    // passes through it) is not a candidate, so it cannot cause a false 405.
    const first = candidates.find((c) => c.node.handlers.size > 0);
    if (first !== undefined) {
      return {
        handler: () => undefined,
        params: first.params,
        middlewares: [],
        allowed: [...first.node.handlers.keys()].sort(),
      };
    }
    return null;
  }

  /**
   * Match and run the middleware chain + handler. Unknown paths return 404,
   * known paths under other methods return 405 with the `Allow` list.
   */
  async handle(method: HttpMethod, path: string): Promise<HandleResult> {
    const matched = this.match(method, path);
    if (matched === null) {
      return { status: 404, body: { error: "Not Found" } };
    }
    if (matched.allowed !== undefined) {
      return {
        status: 405,
        body: { error: "Method Not Allowed" },
        allowed: matched.allowed,
      };
    }
    const ctx: RouteContext = {
      method,
      path: normalizePath(path),
      params: matched.params,
      query: parseQuery(path),
    };
    const chain = matched.middlewares;
    let index = -1;
    const dispatch = async (i: number): Promise<unknown> => {
      if (i <= index) {
        throw new Error("next() called more than once in a middleware");
      }
      index = i;
      const middleware = chain[i];
      if (middleware === undefined) {
        return matched.handler(ctx);
      }
      return middleware(ctx, () => dispatch(i + 1));
    };
    const body = await dispatch(0);
    return { status: 200, body };
  }

  /**
   * Collect every terminal node reachable for these segments, in
   * static > param > wildcard priority order. Returning all candidates
   * (instead of the first terminal node) matters: a static node that only
   * leads to longer routes must not shadow a param route for the same path
   * (e.g. `/users/new` with routes `/users/new/profile` and `/users/:id`).
   * A wildcard consumes every remaining segment into one `*` capture.
   */
  private walkAll(
    node: TrieNode,
    segments: string[],
    index: number,
    params: Record<string, string>,
  ): { node: TrieNode; params: Record<string, string> }[] {
    if (index === segments.length) {
      return [{ node, params }];
    }
    const segment = segments[index] as string;
    const out: { node: TrieNode; params: Record<string, string> }[] = [];
    const staticChild = node.staticChildren.get(segment);
    if (staticChild !== undefined) {
      out.push(...this.walkAll(staticChild, segments, index + 1, params));
    }
    if (node.paramChild !== null) {
      const next = { ...params, [node.paramChild.name]: decode(segment) };
      out.push(...this.walkAll(node.paramChild.node, segments, index + 1, next));
    }
    if (node.wildcardChild !== null) {
      const rest = segments.slice(index).map(decode).join("/");
      out.push({
        node: node.wildcardChild.node,
        params: { ...params, [node.wildcardChild.name]: rest },
      });
    }
    return out;
  }
}
