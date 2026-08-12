import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckpointStore, ProjectBusyError } from "../src/checkpoint/store.js";
import { GraphEngine, type GraphNode } from "../src/graph/engine.js";
import {
  createInitialState,
  parseState,
  type GraphNovelState,
} from "../src/state/state.js";

async function createStore(): Promise<CheckpointStore> {
  return new CheckpointStore(await mkdtemp(join(tmpdir(), "graphnovel-kernel-")));
}

test("checkpoint store saves atomically and reloads state", async () => {
  const store = await createStore();
  const state = createInitialState("project/one", "Test Novel");
  const path = await store.save(state);
  const loaded = await store.load(state.projectId);

  assert.ok(path.endsWith("project%2Fone.json"));
  assert.deepEqual(loaded, state);
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
});

test("corrupt checkpoints fail explicit loads but do not hide healthy projects", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graphnovel-corrupt-"));
  const store = new CheckpointStore(rootDir);
  await writeFile(join(rootDir, "corrupt.json"), "{not-json", "utf8");
  await assert.rejects(() => store.load("corrupt"));
  assert.deepEqual(await store.list(), []);
});

test("project lock rejects overlapping work and releases after failure", async () => {
  const store = await createStore();
  const running = store.withProjectLock("locked", async () => {
    await assert.rejects(
      store.withProjectLock("locked", async () => undefined),
      (error: unknown) => error instanceof ProjectBusyError,
    );
    throw new Error("expected failure");
  });

  await assert.rejects(running, /expected failure/);
  await store.withProjectLock("locked", async () => undefined);
});

test("project lock reclaims a lock owned by a dead process", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graphnovel-stale-lock-"));
  const store = new CheckpointStore(rootDir);
  await writeFile(
    join(rootDir, "stale.lock"),
    JSON.stringify({ projectId: "stale", pid: 2_147_483_647, startedAt: new Date().toISOString() }),
    "utf8",
  );

  let ran = false;
  await store.withProjectLock("stale", async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("engine persists completed routes and reaches done", async () => {
  const store = await createStore();
  const state = createInitialState("route-test", "Route Test");
  const visited: string[] = [];
  const nodes: GraphNode[] = [
    {
      key: "first",
      async run() {
        visited.push("first");
        return { status: "completed" };
      },
    },
    {
      key: "second",
      async run() {
        visited.push("second");
        return { status: "completed" };
      },
    },
  ];
  const engine = new GraphEngine(
    nodes,
    [
      { from: "first", to: "second", reason: "continue", when: () => true },
      { from: "second", to: null, reason: "finish", when: () => true },
    ],
    store,
  );

  const result = await engine.run(state, "first");
  assert.equal(result.status, "completed");
  assert.deepEqual(visited, ["first", "second"]);
  assert.equal(result.state.nodes.first?.status, "completed");
  assert.equal(result.state.nodes.second?.status, "completed");
  assert.ok(result.state.executionEvents.some((event) => event.type === "node_started"));
  assert.equal((await store.load("route-test"))?.workflowPhase, "done");
});

test("engine persists gates and failures without claiming success", async () => {
  const store = await createStore();
  const gatedState = createInitialState("gate-test", "Gate Test");
  const gateEngine = new GraphEngine(
    [{
      key: "approval_node",
      async run() {
        return { status: "awaiting_gate", gate: "foundation" };
      },
    }],
    [],
    store,
  );
  const gated = await gateEngine.run(gatedState, "approval_node");
  assert.equal(gated.status, "awaiting_approval");
  assert.equal((await store.load("gate-test"))?.pendingGate, "foundation");

  const failedState = createInitialState("failure-test", "Failure Test");
  const failedEngine = new GraphEngine(
    [{
      key: "broken_node",
      async run() {
        throw new Error("node exploded");
      },
    }],
    [],
    store,
  );
  const failed = await failedEngine.run(failedState, "broken_node");
  assert.equal(failed.status, "failed");
  assert.equal(failed.state.workflowPhase, "failed");
  assert.equal(failed.state.nodes.broken_node?.status, "failed");
  assert.equal((await store.load("failure-test"))?.lastError?.message, "node exploded");
});

test("engine stops a looping graph at its transition limit", async () => {
  const store = await createStore();
  const state = createInitialState("loop-test", "Loop Test");
  const engine = new GraphEngine(
    [{
      key: "loop",
      async run() {
        return { status: "completed" };
      },
    }],
    [{ from: "loop", to: "loop", reason: "retry", when: () => true }],
    store,
    2,
  );

  const result = await engine.run(state, "loop");
  assert.equal(result.status, "failed");
  assert.match(result.state.lastError?.message ?? "", /transition limit/);
  assert.equal(result.state.nodes.loop?.status, "failed");
});

test("engine turns an aborted run into a persisted failure", async () => {
  const store = await createStore();
  const state = createInitialState("abort-test", "Abort Test");
  const controller = new AbortController();
  controller.abort();
  const engine = new GraphEngine([], [], store);

  const result = await engine.run(state, "never_started", undefined, {
    signal: controller.signal,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.state.lastError?.message, "Graph run aborted");
});

test("state parser rejects unsupported versions", () => {
  const state = createInitialState("version-test", "Version Test");
  const payload = JSON.stringify({ ...state, schemaVersion: 999 });
  assert.throws(() => parseState(payload), /Unsupported GraphNovelState schema version/);
});

test("state parser backfills continuity fields for pre-continuity checkpoints", () => {
  const state = createInitialState("legacy-continuity", "Legacy Continuity");
  const legacy = { ...state } as Record<string, unknown>;
  delete legacy.creativeNotes;
  delete legacy.approvedChapters;
  delete legacy.narrativeFacts;
  delete legacy.characterKnowledge;
  delete legacy.characterArcs;
  delete legacy.foreshadowings;
  delete legacy.continuity;
  delete legacy.chapterPlans;
  delete legacy.chapterCandidates;
  delete legacy.chapterReviews;
  delete legacy.chapterRewriteAttempts;
  delete legacy.chapterWritingFeedback;
  const parsed = parseState(JSON.stringify(legacy));
  assert.equal(parsed.creativeNotes, "");
  assert.deepEqual(parsed.approvedChapters, []);
  assert.deepEqual(parsed.continuity.characterLocations, {});
  assert.deepEqual(parsed.chapterCandidates, {});
});

test("state parser backfills polished draft for an older approved chapter", () => {
  const state = createInitialState("legacy-style", "Legacy Style");
  state.approvedChapters = [{
    chapterNumber: 1,
    title: "旧章",
    summary: "旧章摘要",
    polishedDraft: "旧正文",
    endingExcerpt: "旧结尾",
    lastScene: {
      time: "夜间",
      location: "旧地点",
      povCharacter: "主角",
      charactersPresent: ["主角"],
      finalAction: "停下",
      finalDialogue: "",
    },
    unresolvedActions: [],
    openThreads: [],
  }];
  const legacy = JSON.parse(JSON.stringify(state)) as Record<string, any>;
  delete legacy.approvedChapters[0].polishedDraft;
  const parsed = parseState(JSON.stringify(legacy));
  assert.equal(parsed.approvedChapters[0]?.polishedDraft, "旧结尾");
});
