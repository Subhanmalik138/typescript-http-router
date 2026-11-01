import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Router, normalizePath } from "../src/index.ts";

const ok = () => "ok";

describe("static, param, and wildcard routes", () => {
  test("static route beats param route at the same position", async () => {
    const r = new Router();
    r.get("/users/:id", (ctx) => `user ${ctx.params.id}`);
    r.get("/users/new", () => "new user form");
    assert.equal((await r.handle("GET", "/users/new")).body, "new user form");
    assert.equal((await r.handle("GET", "/users/42")).body, "user 42");
  });

  test("param route wins over a static-only prefix that has no handler", async () => {
    const r = new Router();
    r.get("/users/:id", (ctx) => `user ${ctx.params.id}`);
    r.get("/users/new/profile", () => "profile form");
    // "new" alone must fall through to :id, not 404/405 on the bare node.
    assert.equal((await r.handle("GET", "/users/new")).body, "user new");
    assert.equal((await r.handle("GET", "/users/new/profile")).body, "profile form");
  });

  test("wildcard consumes the rest of the path", async () => {
    const r = new Router();
    r.get("/files/*", (ctx) => ctx.params["*"]);
    const res = await r.handle("GET", "/files/a/b/c.txt");
    assert.equal(res.body, "a/b/c.txt");
    assert.equal((await r.handle("GET", "/files")).status, 404);
  });

  test("params are URI-decoded", async () => {
    const r = new Router();
    r.get("/search/:term", (ctx) => ctx.params.term);
    assert.equal((await r.handle("GET", "/search/hello%20world")).body, "hello world");
  });

  test("trailing slashes and duplicate slashes are normalised", async () => {
    const r = new Router();
    r.get("/users/:id", ok);
    assert.equal((await r.handle("GET", "/users/42/")).status, 200);
    assert.equal((await r.handle("GET", "//users//42")).status, 200);
    assert.equal(normalizePath("/"), "/");
  });
});

describe("query strings", () => {
  test("single and repeated keys", async () => {
    const r = new Router();
    r.get("/search", (ctx) => ctx.query);
    const res = await r.handle("GET", "/search?q=trie&tag=a&tag=b");
    assert.deepEqual(res.body, { q: "trie", tag: ["a", "b"] });
  });
});

describe("methods: 404, 405, HEAD fallback", () => {
  test("unknown path is 404", async () => {
    const r = new Router();
    r.get("/a", ok);
    assert.equal((await r.handle("GET", "/nope")).status, 404);
  });

  test("known path under another method is 405 with Allow list", async () => {
    const r = new Router();
    r.get("/items", ok);
    r.post("/items", ok);
    const res = await r.handle("DELETE", "/items");
    assert.equal(res.status, 405);
    assert.deepEqual(res.allowed, ["GET", "POST"]);
  });

  test("HEAD falls back to the GET handler", async () => {
    const r = new Router();
    r.get("/ping", () => "pong");
    assert.equal((await r.handle("HEAD", "/ping")).status, 200);
  });
});

describe("middleware and groups", () => {
  test("global, route, and short-circuit middleware run in order", async () => {
    const order: string[] = [];
    const r = new Router();
    r.use(async (_ctx, next) => {
      order.push("global");
      return next();
    });
    r.get(
      "/x",
      () => {
        order.push("handler");
        return "done";
      },
      async (_ctx, next) => {
        order.push("route");
        return next();
      },
    );
    assert.equal((await r.handle("GET", "/x")).body, "done");
    assert.deepEqual(order, ["global", "route", "handler"]);
  });

  test("middleware that never calls next() short-circuits the handler", async () => {
    const r = new Router();
    r.get("/secret", ok, () => "blocked");
    assert.equal((await r.handle("GET", "/secret")).body, "blocked");
  });

  test("double next() is an error", async () => {
    const r = new Router();
    r.get("/bad", ok, async (_ctx, next) => {
      await next();
      return next();
    });
    await assert.rejects(r.handle("GET", "/bad"), /next\(\) called more than once/);
  });

  test("group prefixes paths and scopes middleware", async () => {
    const seen: string[] = [];
    const r = new Router();
    r.group("/api", (api) => {
      api.use(async (_ctx, next) => {
        seen.push("api-mw");
        return next();
      });
      api.get("/users/:id", (ctx) => ctx.params.id);
    });
    r.get("/users/:id", () => "outside");
    assert.equal((await r.handle("GET", "/api/users/7")).body, "7");
    assert.deepEqual(seen, ["api-mw"]);
    assert.equal((await r.handle("GET", "/users/7")).body, "outside");
    assert.deepEqual(r.listRoutes().map((x) => `${x.method} ${x.path}`), [
      "GET /api/users/:id",
      "GET /users/:id",
    ]);
  });
});

describe("route-table validation", () => {
  test("duplicate routes, mid-path wildcards, and param conflicts throw", () => {
    const r = new Router();
    r.get("/a", ok);
    assert.throws(() => r.get("/a", ok), /Duplicate route/);
    assert.throws(() => r.get("/a/*/b", ok), /must be the last segment/);
    const r2 = new Router();
    r2.get("/x/:id", ok);
    assert.throws(() => r2.get("/x/:name", ok), /Conflicting parameter names/);
  });
});
