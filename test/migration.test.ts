import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { EventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { buildContinuityContext } from "../src/state/continuity.js";
import { PiAgentRuntime } from "../src/runtime/agent.js";
import { GraphNovelService } from "../src/web/service.js";
import { migrateLegacyState } from "../src/migration/legacy.js";
import { previewLegacyFile, writeMigratedFile } from "../src/migration/io.js";

const SOURCE_PATH = join(process.cwd(), "examples", "xunhuan-zhi-wai", "xunhuan-zhi-wai_state.json");

test("legacy v8 preview maps the demo State without losing Graph facts", async () => {
  const source = JSON.parse(await readFile(SOURCE_PATH, "utf8"));
  const result = migrateLegacyState(source, SOURCE_PATH);

  assert.equal(result.report.sourceVersion, 8);
  assert.equal(result.report.status, "ready");
  assert.equal(result.state.schemaVersion, 1);
  assert.equal(result.state.projectId, "xunhuan-zhi-wai");
  assert.equal(result.state.foundationApproval, "approved");
  assert.equal(result.state.approvedChapters.length, 5);
  assert.equal(result.state.narrativeFacts.length, 5);
  assert.equal(result.state.characterKnowledge.length, 5);
  assert.equal(result.state.chapterPlans["5"]?.contextHash.length, 64);
  assert.equal(result.state.globalReview?.overallScore, 9);
});

test("migration writes a new checkpoint, copies the source, and is idempotent", async () => {
  const destination = await mkdtemp(join(tmpdir(), "graphnovel-migration-"));
  const sourceBefore = await readFile(SOURCE_PATH, "utf8");
  const first = await writeMigratedFile(SOURCE_PATH, destination);
  assert.equal(await readFile(SOURCE_PATH, "utf8"), sourceBefore);
  assert.equal(await readFile(first.backupPath, "utf8"), sourceBefore);
  assert.equal((await new CheckpointStore(destination).load("xunhuan-zhi-wai"))?.schemaVersion, 1);

  const second = await writeMigratedFile(SOURCE_PATH, destination);
  assert.equal(second.reusedExisting, true);
  assert.equal(second.statePath, first.statePath);
});

test("a migrated chapter Gate can be approved and the next chapter can continue planning", async () => {
  const legacy = JSON.parse(await readFile(SOURCE_PATH, "utf8"));
  legacy.target_total_chapters = 6;
  legacy.total_chapters = 6;
  legacy.workflow_phase = "chapter_loop";
  legacy.pending_gate = "chapter:5";
  legacy.active_task = { current_node: "human_approval_5" };
  legacy.chapters[4].approval = "pending";

  const destination = await mkdtemp(join(tmpdir(), "graphnovel-migration-gate-"));
  const sourcePath = join(destination, "legacy_state.json");
  await writeFile(sourcePath, JSON.stringify(legacy), "utf8");
  await writeMigratedFile(sourcePath, join(destination, "new"));
  const store = new CheckpointStore(join(destination, "new"));
  const pending = await store.load("xunhuan-zhi-wai");
  assert.ok(pending);
  assert.equal(pending.pendingGate, "chapter_writing:5");
  assert.ok(pending.chapterCandidates["5"]);

  let nextContextHash = "";
  const service = new GraphNovelService(store, {
    runtime: new PiAgentRuntime(),
    model: model(),
    streamFn: () => streamFor(JSON.stringify({
      contextHash: nextContextHash,
      chapterNumber: 6,
      title: "新的回声",
      openingBridge: {
        previousChapter: 5,
        inheritedEndpoint: pending!.approvedChapters.at(-1)?.endingExcerpt || "",
        transitionSteps: ["承接第五章公开记录"],
        firstSceneStart: "新的回声从公开记录的余波中出现。",
        carryOverThreads: [],
      },
      causalChain: [{ cause: "第五章公开记录", event: "新的线索出现", effect: "调查继续" }],
      requiredFactIds: ["F005"],
      plannedFacts: [],
      informationFlow: [],
    })),
  });
  await service.decideChapterWritingFor("xunhuan-zhi-wai", 5, true);
  const approved = await service.getState("xunhuan-zhi-wai");
  assert.equal(approved.approvedChapters.length, 5);
  assert.equal(approved.pendingGate, null);
  assert.match(service.exportNovel(approved), /循环之外/);
  nextContextHash = buildContinuityContext(approved, 6).contextHash;

  await service.startChapterPlanningFor("xunhuan-zhi-wai", 6);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await service.getStatus("xunhuan-zhi-wai")).status === "awaiting_approval") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const next = await service.getState("xunhuan-zhi-wai");
  assert.equal(next.pendingGate, "chapter_plan:6", JSON.stringify({
    phase: next.workflowPhase,
    error: next.lastError,
    plan: next.chapterPlans["6"],
  }));
  assert.ok(next.chapterPlans["6"]);
});

test("unsupported legacy versions fail before writing", async () => {
  const legacy = JSON.parse(await readFile(SOURCE_PATH, "utf8"));
  legacy.version = 99;
  assert.throws(() => migrateLegacyState(legacy, SOURCE_PATH), /只支持旧 State v1-v8/);
  const preview = await previewLegacyFile(SOURCE_PATH);
  assert.equal(preview.report.projectId, "xunhuan-zhi-wai");
});

function model(): Model<"openai-responses"> {
  return {
    id: "mock", name: "mock", api: "openai-responses", provider: "openai",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192, maxTokens: 1024,
  };
}

function streamFor(text: string): ReturnType<StreamFn> {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") throw event.error;
      throw new Error("incomplete");
    },
  );
  const message: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text }], api: "openai-responses",
    provider: "openai", model: "mock", stopReason: "stop", timestamp: Date.now(),
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
  return stream;
}
