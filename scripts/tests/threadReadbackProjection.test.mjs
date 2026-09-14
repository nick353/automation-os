import assert from "node:assert/strict";
import test from "node:test";
import {
  createThreadAlias,
  createThreadReadbackProjection,
  normalizeThreadReadbackProjection,
  normalizeOfficialThreadReadback,
  projectionCallbacks,
} from "../lib/thread-readback-projection.mjs";

function baseProjection(overrides = {}) {
  return createThreadReadbackProjection({
    automationId: "aos-companion-2",
    rootRunId: "root-run",
    childAuditId: "child-audit",
    ...overrides,
  });
}

test("accepts a successful empty list and exposes no child tasks", () => {
  const projection = baseProjection({ listSucceeded: 1 });
  assert.deepEqual(projection.counts, {
    listAttempted: 1,
    listSucceeded: 1,
    lightweightRequested: 0,
    lightweightSucceeded: 0,
    lightweightFailed: 0,
    deepCandidates: 0,
    deepAttempted: 0,
    deepSucceeded: 0,
    deepFailed: 0,
  });
  assert.deepEqual(projectionCallbacks(projection).tasks, []);
});

test("does not synthesize an active task when the root omits task state", () => {
  const alias = createThreadAlias("state-omitted");
  const bridged = projectionCallbacks(baseProjection({
    lightweight: [{ alias, outcome: "success" }],
  }));
  assert.equal(bridged.tasks.length, 1);
  assert.equal(bridged.tasks[0].hostId, "local");
  assert.equal(bridged.tasks[0].status, "unknown");
  assert.equal(bridged.tasks[0].userOwned, null);
  assert.equal(bridged.tasks[0].goalStatus, "unknown");
  assert.equal(bridged.tasks[0].actionable, null);
  assert.equal(bridged.tasks[0].stalled, null);
  assert.equal(bridged.tasks[0].changed, null);
});

test("preserves root task, Goal, Plan, owner, and blocker state", async () => {
  const alias = createThreadAlias("state-preserved");
  const state = {
    taskStatus: "notLoaded",
    latestTurnStatus: "completed",
    goalStatus: "blocked",
    planStatus: "blocked",
    owner: "user",
    userOwned: true,
    actionable: true,
    stalled: false,
    changed: true,
    revision: "rev-2",
    updatedAt: "2026-09-02T00:00:00.000Z",
    generation: "gen-2",
    exactBlocker: "profile_not_connected",
    softAnomalyTypes: ["unstable_behavior"],
  };
  const bridged = projectionCallbacks(baseProjection({
    lightweight: [{ alias, outcome: "success", state }],
  }));
  assert.equal(bridged.tasks[0].status, state.taskStatus);
  assert.equal(bridged.tasks[0].goalStatus, state.goalStatus);
  assert.equal(bridged.tasks[0].planStatus, state.planStatus);
  assert.equal(bridged.tasks[0].owner, state.owner);
  assert.equal(bridged.tasks[0].userOwned, state.userOwned);
  assert.equal(bridged.tasks[0].exactBlocker, state.exactBlocker);
  assert.equal(bridged.tasks[0].blocked, true);
  const readback = await bridged.inspectThread({ threadId: alias });
  assert.equal(readback.threadStatus, state.taskStatus);
  assert.equal(readback.goalStatus, state.goalStatus);
  assert.equal(readback.planStatus, state.planStatus);
  assert.equal(readback.exactBlocker, state.exactBlocker);
  assert.deepEqual(readback.softAnomalyTypes, state.softAnomalyTypes);
});

test("preserves a secret-free exact blocker for a bounded readback failure", async () => {
  const alias = createThreadAlias("readback-failed");
  const bridged = projectionCallbacks(baseProjection({
    lightweight: [{
      alias,
      outcome: "bounded_error",
      state: {
        taskStatus: "active",
        latestTurnStatus: "unknown",
        goalStatus: "unknown",
        planStatus: "unknown",
        owner: "user",
        exactBlocker: "thread_readback_unavailable",
      },
    }],
  }));
  const readback = await bridged.inspectThread({ threadId: alias });
  assert.equal(readback.status, "failed");
  assert.equal(readback.exact_blocker, "thread_readback_unavailable");
});

test("normalizes the official App read_thread envelope into current task and turn state", () => {
  const readback = {
    schemaVersion: 1,
    thread: {
      id: "thread-1",
      status: { type: "idle" },
      updatedAt: 1788417000,
    },
    page: { order: "newest_first" },
    turns: [{ id: "turn-1", status: "completed" }],
  };
  assert.deepEqual(normalizeOfficialThreadReadback(readback, {
    fallbackState: { owner: "user", userOwned: true },
  }), {
    status: "observed",
    taskStatus: "idle",
    latestTurnStatus: "completed",
    goalStatus: "unknown",
    planStatus: "unknown",
    owner: "user",
    userOwned: true,
    actionable: null,
    stalled: null,
    changed: null,
    revision: null,
    updatedAt: "1788417000",
    generation: null,
    exactBlocker: null,
    softAnomalyTypes: [],
  });
});

test("normalizes the current App Server response with turns nested in thread", () => {
  const normalized = normalizeOfficialThreadReadback({
    thread: {
      id: "thread-1",
      status: { type: "idle" },
      updatedAt: 1788417000,
      turns: [{ id: "turn-1", status: "completed" }],
    },
  }, { fallbackState: { owner: "user", userOwned: true } });
  assert.equal(normalized.status, "observed");
  assert.equal(normalized.taskStatus, "idle");
  assert.equal(normalized.latestTurnStatus, "completed");
  assert.equal(normalized.updatedAt, "1788417000");
});

test("uses the declared oldest-first order instead of assuming turns[0] is latest", () => {
  const normalized = normalizeOfficialThreadReadback({
    thread: { id: "thread-ordered", status: "idle" },
    page: { order: "oldest_first" },
    turns: [
      { id: "turn-old", status: "completed" },
      { id: "turn-new", status: "inProgress" },
    ],
  }, { fallbackState: { owner: "user" } });
  assert.equal(normalized.latestTurnStatus, "inProgress");
});

test("keeps latest turn unknown when order and timestamps are both absent", () => {
  const normalized = normalizeOfficialThreadReadback({
    thread: { id: "thread-ambiguous", status: "idle" },
    turns: [
      { id: "turn-old", status: "completed" },
      { id: "turn-new", status: "inProgress" },
    ],
  }, { fallbackState: { owner: "user" } });
  assert.equal(normalized.latestTurnStatus, "unknown");
});

test("uses the newest turn timestamp when the official response omits ordering", () => {
  const normalized = normalizeOfficialThreadReadback({
    thread: { id: "thread-timestamped", status: "idle" },
    turns: [
      { id: "turn-new", status: "inProgress", updatedAt: "2026-09-04T00:00:02.000Z" },
      { id: "turn-old", status: "completed", updatedAt: "2026-09-04T00:00:01.000Z" },
    ],
  }, { fallbackState: { owner: "user" } });
  assert.equal(normalized.latestTurnStatus, "inProgress");
});

test("finds a read_thread payload nested in a functionCallOutput text block", () => {
  const readback = {
    content: [{
      type: "text",
      text: JSON.stringify({
        thread: { status: "notLoaded", updatedAt: "2026-09-03T00:00:00.000Z" },
        turns: [{ status: "completed" }],
      }),
    }],
  };
  const normalized = normalizeOfficialThreadReadback(readback, { fallbackState: { owner: "user" } });
  assert.equal(normalized.status, "observed");
  assert.equal(normalized.taskStatus, "notLoaded");
  assert.equal(normalized.latestTurnStatus, "completed");
  assert.equal(normalized.owner, "user");
});

test("extracts Goal and Plan status from structured output in the newest turn", () => {
  const normalized = normalizeOfficialThreadReadback({
    thread: { status: { type: "idle" } },
    turns: [{
      status: "completed",
      items: [{
        type: "mcpToolCall",
        result: {
          goal: { status: "blocked" },
          plan: { status: "active" },
        },
      }],
    }],
  }, { fallbackState: { owner: "user" } });
  assert.equal(normalized.goalStatus, "blocked");
  assert.equal(normalized.planStatus, "active");
});

test("keeps missing Goal and Plan state unknown instead of inventing a blocker", () => {
  const normalized = normalizeOfficialThreadReadback({
    thread: { status: { type: "idle" } },
    turns: [{ status: "completed" }],
  }, { fallbackState: { owner: "user" } });
  assert.equal(normalized.goalStatus, "unknown");
  assert.equal(normalized.planStatus, "unknown");
  assert.equal(normalized.exactBlocker, null);
});

test("rejects a non-opaque alias", () => {
  assert.throws(
    () => baseProjection({ lightweight: [{ alias: "thread-id", outcome: "success" }] }),
    (error) => error.exact_blocker === "thread_readback_projection_alias_invalid",
  );
});

test("rejects duplicate reads and deep reads for an unlisted target", () => {
  const alias = createThreadAlias("duplicate");
  assert.throws(
    () => baseProjection({ lightweight: [{ alias, outcome: "success" }, { alias, outcome: "success" }] }),
    (error) => error.exact_blocker === "thread_readback_projection_duplicate_record",
  );
  assert.throws(
    () => baseProjection({ deep: [{ alias: createThreadAlias("not-listed"), outcome: "success" }] }),
    (error) => error.exact_blocker === "thread_readback_projection_deep_target_not_listed",
  );
});

test("rejects unknown fields and an oversized payload", () => {
  const projection = baseProjection({ lightweight: [{ alias: createThreadAlias("known"), outcome: "success" }] });
  assert.throws(
    () => normalizeThreadReadbackProjection({ ...projection, unexpected: "secret" }),
    (error) => error.exact_blocker === "thread_readback_projection_field_not_allowed",
  );
  assert.throws(
    () => normalizeThreadReadbackProjection(projection, { maxBytes: 1 }),
    (error) => error.exact_blocker === "thread_readback_projection_oversize",
  );
});

test("accepts a full bounded App page with 54 lightweight and 50 deep reads", () => {
  const state = {
    taskStatus: "notLoaded",
    latestTurnStatus: "unknown",
    goalStatus: "unknown",
    planStatus: "unknown",
    owner: "user",
    userOwned: true,
    actionable: false,
    stalled: false,
    changed: true,
    revision: "1788378031",
    updatedAt: "1788378031",
    generation: "gen-readback",
    exactBlocker: `companion_${"x".repeat(220)}`,
    softAnomalyTypes: Array.from({ length: 8 }, (_, index) => `anomaly_${index}_${"y".repeat(45)}`),
  };
  const lightweight = Array.from({ length: 54 }, (_, index) => ({
    alias: createThreadAlias(`full-light-${index}`),
    outcome: "success",
    state,
  }));
  const deep = lightweight.slice(0, 50).map((record) => ({
    alias: record.alias,
    outcome: "success",
    state,
  }));
  const projection = baseProjection({ lightweight, deep });
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") > 64 * 1024);
  assert.doesNotThrow(() => normalizeThreadReadbackProjection(projection));
});

test("rejects inconsistent declared counts even when the digest is stale", () => {
  const alias = createThreadAlias("count-mismatch");
  const projection = baseProjection({ lightweight: [{ alias, outcome: "success" }] });
  assert.throws(
    () => normalizeThreadReadbackProjection({
      ...projection,
      counts: { ...projection.counts, lightweightRequested: 0 },
    }),
    (error) => error.exact_blocker === "thread_readback_projection_digest_mismatch",
  );
});
