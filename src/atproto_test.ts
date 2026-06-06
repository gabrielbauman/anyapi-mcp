import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIndexAndMethods,
  generateMethodMap,
  namespaceTag,
} from "./atproto.ts";

// A synthetic lexicon set covering the cases the builder must handle: a query
// with params + output, a procedure with input + output, a procedure with NO
// output, a subscription and a record (both skipped), a doc whose NSID isn't in
// `ids` (skipped - can't be typed), and a doc with no `main` (skipped).
const schemas = [
  {
    lexicon: 1,
    id: "app.bsky.feed.getTimeline",
    defs: {
      main: {
        type: "query",
        description: "Get the requesting account's home timeline.",
        parameters: {
          type: "params",
          properties: {
            algorithm: { type: "string" },
            limit: { type: "integer" },
            cursor: { type: "string" },
          },
        },
        output: {
          encoding: "application/json",
          schema: { type: "ref", ref: "#feedViewPost" },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: "com.atproto.repo.createRecord",
    defs: {
      main: {
        type: "procedure",
        description: "Create a single new repository record.",
        input: {
          encoding: "application/json",
          schema: {
            type: "object",
            required: ["repo", "collection", "record"],
            properties: {},
          },
        },
        output: { encoding: "application/json", schema: { type: "object" } },
      },
    },
  },
  {
    lexicon: 1,
    id: "com.atproto.server.requestPasswordReset",
    defs: {
      main: {
        type: "procedure",
        input: { encoding: "application/json", schema: { type: "object" } },
        // no output
      },
    },
  },
  {
    lexicon: 1,
    id: "app.bsky.actor.searchActors",
    defs: {
      main: {
        type: "query",
        parameters: {
          type: "params",
          required: ["q"],
          properties: {
            q: { type: "string", description: "Search query string." },
            limit: { type: "integer" },
            typeahead: { type: "boolean" },
          },
        },
        output: { encoding: "application/json", schema: { type: "ref" } },
      },
    },
  },
  // skipped: not a query/procedure
  {
    lexicon: 1,
    id: "com.atproto.sync.subscribeRepos",
    defs: { main: { type: "subscription" } },
  },
  {
    lexicon: 1,
    id: "app.bsky.feed.post",
    defs: { main: { type: "record", key: "tid", record: { type: "object" } } },
  },
  // skipped: NSID absent from `ids`, so no exported namespace to point at
  {
    lexicon: 1,
    id: "app.bsky.unknown.method",
    defs: { main: { type: "query" } },
  },
  // skipped: no `main`
  { lexicon: 1, id: "app.bsky.feed.defs", defs: {} },
];

const ids: Record<string, string> = {
  AppBskyFeedGetTimeline: "app.bsky.feed.getTimeline",
  ComAtprotoRepoCreateRecord: "com.atproto.repo.createRecord",
  ComAtprotoServerRequestPasswordReset:
    "com.atproto.server.requestPasswordReset",
  AppBskyActorSearchActors: "app.bsky.actor.searchActors",
  ComAtprotoSyncSubscribeRepos: "com.atproto.sync.subscribeRepos",
  AppBskyFeedPost: "app.bsky.feed.post",
  // app.bsky.unknown.method intentionally absent
};

Deno.test("namespaceTag drops the final NSID segment", () => {
  assertEquals(namespaceTag("app.bsky.feed.getTimeline"), "app.bsky.feed");
  assertEquals(
    namespaceTag("com.atproto.repo.createRecord"),
    "com.atproto.repo",
  );
  assertEquals(namespaceTag("single"), "single");
});

Deno.test("buildIndexAndMethods keeps only query/procedure docs present in ids", () => {
  const { operations, methods } = buildIndexAndMethods(schemas, ids);
  const paths = operations.map((o) => o.path).sort();
  assertEquals(paths, [
    "app.bsky.actor.searchActors",
    "app.bsky.feed.getTimeline",
    "com.atproto.repo.createRecord",
    "com.atproto.server.requestPasswordReset",
  ]);
  // subscription, record, unknown-nsid, and no-main docs are all dropped.
  assertEquals(methods.length, 4);
});

Deno.test("buildIndexAndMethods maps a query: method, tag, params, returns", () => {
  const { operations } = buildIndexAndMethods(schemas, ids);
  const tl = operations.find((o) => o.path === "app.bsky.feed.getTimeline")!;
  assertEquals(tl.method, "query");
  assertEquals(tl.operationId, "app.bsky.feed.getTimeline");
  assertEquals(tl.tags, ["app.bsky.feed"]);
  assertEquals(tl.params.map((p) => p.name).sort(), [
    "algorithm",
    "cursor",
    "limit",
  ]);
  assert(tl.params.every((p) => p.in === "query"));
  assert(tl.params.every((p) => !p.required)); // none listed in `required`
  assertEquals(tl.returns, "#feedViewPost");
  assertEquals(tl.requestBodyHint, undefined); // queries have no body
});

Deno.test("buildIndexAndMethods marks required params and keeps types", () => {
  const { operations } = buildIndexAndMethods(schemas, ids);
  const search = operations.find((o) =>
    o.path === "app.bsky.actor.searchActors"
  )!;
  const q = search.params.find((p) => p.name === "q")!;
  assertEquals(q.required, true);
  assertEquals(q.type, "string");
  assertEquals(q.description, "Search query string.");
  assertEquals(
    search.params.find((p) => p.name === "limit")!.type,
    "integer",
  );
  assertEquals(
    search.params.find((p) => p.name === "typeahead")!.type,
    "boolean",
  );
});

Deno.test("buildIndexAndMethods maps a procedure's input/output hints", () => {
  const { operations, methods } = buildIndexAndMethods(schemas, ids);
  const create = operations.find((o) =>
    o.path === "com.atproto.repo.createRecord"
  )!;
  assertEquals(create.method, "procedure");
  assertEquals(create.requestBodyHint, "application/json: object");
  assertEquals(create.returns, "object");
  assertEquals(
    methods.find((m) => m.nsid === "com.atproto.repo.createRecord")!
      .hasOutputSchema,
    true,
  );
});

Deno.test("a procedure without an output schema is typed unknown", () => {
  const { operations, methods } = buildIndexAndMethods(schemas, ids);
  const reset = operations.find((o) =>
    o.path === "com.atproto.server.requestPasswordReset"
  )!;
  assertEquals(reset.returns, undefined);
  const method = methods.find((m) =>
    m.nsid === "com.atproto.server.requestPasswordReset"
  )!;
  assertEquals(method.hasOutputSchema, false);
});

Deno.test("generateMethodMap points each NSID at the exact exported namespace", () => {
  const { methods } = buildIndexAndMethods(schemas, ids);
  const dts = generateMethodMap(methods);
  assertStringIncludes(dts, `import type * as Lex from "npm:@atproto/api@`);
  // string-literal key -> official param/input/output types
  assertStringIncludes(dts, `"app.bsky.feed.getTimeline": {`);
  assertStringIncludes(dts, `params: Lex.AppBskyFeedGetTimeline.QueryParams;`);
  assertStringIncludes(dts, `input: Lex.AppBskyFeedGetTimeline.InputSchema;`);
  assertStringIncludes(dts, `output: Lex.AppBskyFeedGetTimeline.OutputSchema;`);
  assertStringIncludes(dts, `type: "procedure";`);
  // no output schema -> unknown, never a dangling Lex reference
  assertStringIncludes(dts, `output: unknown;`);
  assert(
    !dts.includes("ComAtprotoServerRequestPasswordReset.OutputSchema"),
    "no-output method must not reference a missing OutputSchema",
  );
});
