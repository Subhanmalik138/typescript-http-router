# typescript-http-router

A small, framework-agnostic HTTP router in TypeScript, built on a trie.
Give it a method and a path; it returns the handler, the extracted
parameters, and the parsed query string — no server, no I/O, so it drops
into any framework and tests without spinning anything up.

## Usage

```ts
import { Router } from "./src/index.ts";

const router = new Router();

// Logging middleware runs before every handler.
router.use(async (ctx, next) => {
  console.log(ctx.method, ctx.path);
  return next();
});

router.get("/users/new", () => "new user form");
router.get("/users/:id", (ctx) => `user ${ctx.params.id}`);
router.get("/files/*", (ctx) => `file at ${ctx.params["*"]}`);

router.group("/api", (api) => {
  api.get("/users/:id", (ctx) => ({ id: ctx.params.id }));
});

const res = await router.handle("GET", "/users/42?tab=posts");
console.log(res); // { status: 200, body: "user 42" }
```

## Matching rules

At every path segment, matching prefers **static > parameter > wildcard**:

- `/users/new` beats `/users/:id` for the path `/users/new`.
- `/users/:id` captures one segment, URI-decoded, into `ctx.params.id`.
- `/files/*` captures the rest of the path into `ctx.params["*"]`.
- Trailing slashes and duplicate slashes are normalised before matching.

Response codes from `handle()`:

| Situation | Result |
| --- | --- |
| Handler found (middleware chain runs) | `200` + handler return value |
| Path unknown | `404` + `{ error: "Not Found" }` |
| Path known under other methods | `405` + `{ error: "Method Not Allowed" }`, with an `allowed` list |
| `HEAD` with no `HEAD` handler | Falls back to the `GET` handler |

Middleware is `(ctx, next) => ...`. A middleware that never calls `next()`
short-circuits the chain (useful for auth guards); calling `next()` twice
is an error. Route groups prefix every path and scope their own global
middlewares to just that group's routes.

## Design decisions

1. **Trie, not a route list.** Matching walks one node per segment, so
   lookup cost grows with path depth, not with the number of routes, and
   static/param/wildcard priority falls out of the walk order.
2. **All candidates, not the first terminal node.** A static node that only
   leads to longer routes (e.g. `/users/new` existing only because of
   `/users/new/profile`) must not shadow a param route for the same path —
   the matcher collects every reachable terminal node in priority order
   and picks the first that actually serves the method.
3. **Framework-agnostic core.** `handle()` takes a method and a path
   string and returns a plain result object, so the router stays testable
   with plain unit tests and adaptable to Node's `http` module, Express
   adapters, or edge runtimes without changing its API.
4. **Strict route-table validation.** Duplicate routes, mid-path wildcards,
   and two different parameter names at the same trie position all throw
   at registration time, when the mistake is cheap to fix — not at request
   time, when it would silently misroute.

## Run

Requires Node ≥ 22.6 (uses Node's native TypeScript type stripping, so no
build step is needed for tests).

```sh
npm test        # node --test tests/*.test.ts
npm run typecheck
```

## Tech stack

- TypeScript 5 (strict mode, `noUncheckedIndexedAccess`)
- Node's built-in test runner — no test-framework dependency

## License

MIT
