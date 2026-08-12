import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { EventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { PiAgentRuntime } from "../src/runtime/agent.js";
import { buildContinuityContext } from "../src/state/continuity.js";
import { createInitialState } from "../src/state/state.js";
import { createGraphNovelHttpServer } from "../src/web/server.js";
import { GraphNovelService } from "../src/web/service.js";
import { enhancedFoundationResponses } from "./foundation-fixture.js";

function model(): Model<"openai-responses"> {
  return {
    id: "mock", name: "mock", api: "openai-responses", provider: "openai",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192, maxTokens: 1024,
  };
}

function streamFor(text: string, delay = 0): ReturnType<StreamFn> {
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
  setTimeout(() => stream.push({ type: "done", reason: "stop", message }), delay);
  return stream;
}

function foundationResponses(): string[] {
  return enhancedFoundationResponses({ totalChapters: 2 });
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-web-"));
  const responses = foundationResponses();
  let index = 0;
  const service = new GraphNovelService(
    new CheckpointStore(root),
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++], 35) },
  );
  const server = createGraphNovelHttpServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { service, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl: string, path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function waitForStatus(baseUrl: string, projectId: string, expected: string): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(baseUrl, `/api/projects/${projectId}/status`);
    const payload = await json(response);
    if (payload.status === expected) return payload;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`status did not reach ${expected}`);
}

test("Node API creates projects, serves the workbench, validates input, and lists status", async (t) => {
  const { server, baseUrl } = await setup();
  t.after(() => server.close());

  const shell = await request(baseUrl, "/");
  assert.equal(shell.status, 200);
  const shellHtml = await shell.text();
  assert.match(shellHtml, /graphnovel-frontend" content="react-shadcn/);
  assert.match(shellHtml, /id="root"/);
  assert.match(shellHtml, /src="\/assets\//);
  const readerShell = await request(baseUrl, "/reader");
  assert.equal(readerShell.status, 200);
  assert.match(await readerShell.text(), /graphnovel-frontend" content="react-shadcn/);
  const favicon = await request(baseUrl, "/favicon.svg");
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.match(await favicon.text(), /GraphNovel/);

  const invalid = await request(baseUrl, "/api/projects", { method: "POST", body: JSON.stringify({ novelTitle: "坏项目", projectId: "../escape" }) });
  assert.equal(invalid.status, 400);

  const created = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ projectId: "web-test", novelTitle: "Web Test", targetTotalChapters: 2, creativeNotes: "先建立因果" }),
  });
  assert.equal(created.status, 201);
  const list = await request(baseUrl, "/api/projects");
  const projects = await json(list);
  assert.equal(projects.projects[0].projectId, "web-test");
  assert.equal(projects.projects[0].status, "idle");
  const state = await request(baseUrl, "/api/projects/web-test/state");
  assert.equal((await json(state)).state.creativeNotes, "先建立因果");
  const workspaceRoutes = [
    "overview", "studio/foundation", "studio/chapters", "studio/final-review",
    "library/settings", "library/chapters", "library/reviews", "runs",
    "workflow", "documents", "foundation", "chapters", "review",
  ];
  for (const route of workspaceRoutes) {
    const workspace = await request(baseUrl, `/project/web-test/${route}`);
    assert.equal(workspace.status, 200);
    assert.match(await workspace.text(), /id="root"/);
  }
});

test("trial reading center exposes only approved full chapter prose", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-trial-reading-"));
  const service = new GraphNovelService(new CheckpointStore(root));
  const published = await service.createProject({ projectId: "published-novel", novelTitle: "已出版小说", targetTotalChapters: 3 });
  published.chapterPlans["1"] = { chapterNumber: 1, title: "规划标题", contextHash: "plan", openingBridge: { previousChapter: 0, inheritedEndpoint: "", transitionSteps: [], firstSceneStart: "", carryOverThreads: [] }, causalChain: [], requiredFactIds: [], plannedFacts: [], informationFlow: [] };
  published.chapterCandidates["1"] = {
    chapterNumber: 1, title: "候选标题", contextHash: "candidate", draft: "不应泄露的初稿", polishedDraft: "不应泄露的润色稿", chapterHook: "", chapterSummary: "候选摘要", endingExcerpt: "候选片段", lastScene: { time: "", location: "", povCharacter: "", charactersPresent: [], finalAction: "", finalDialogue: "" }, unresolvedActions: [], openThreads: [], delta: { factsEstablished: [], knowledgeChanges: [], continuityChanges: {} }, revision: 2, approved: false, humanFeedback: "", revisionHistory: [],
  };
  published.approvedChapters = [
    { chapterNumber: 2, title: "第二章", summary: "第二章摘要", polishedDraft: "第二章完整正文", endingExcerpt: "第二章结尾", lastScene: { time: "", location: "", povCharacter: "", charactersPresent: [], finalAction: "", finalDialogue: "" }, unresolvedActions: [], openThreads: [] },
    { chapterNumber: 1, title: "第一章", summary: "第一章摘要", polishedDraft: "第一章完整正文", endingExcerpt: "第一章结尾", lastScene: { time: "", location: "", povCharacter: "", charactersPresent: [], finalAction: "", finalDialogue: "" }, unresolvedActions: [], openThreads: [] },
    { chapterNumber: 3, title: "无正文章节", summary: "", polishedDraft: "", endingExcerpt: "不应作为正文展示", lastScene: { time: "", location: "", povCharacter: "", charactersPresent: [], finalAction: "", finalDialogue: "" }, unresolvedActions: [], openThreads: [] },
  ];
  const draftOnly = await service.createProject({ projectId: "draft-only", novelTitle: "只有草稿", targetTotalChapters: 1 });
  draftOnly.chapterCandidates["1"] = { ...published.chapterCandidates["1"]!, chapterNumber: 1 };
  await service.checkpoints.save(published);
  await service.checkpoints.save(draftOnly);
  const server = createGraphNovelHttpServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const page = await request(baseUrl, "/reader");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /graphnovel-frontend" content="react-shadcn/);
  const response = await request(baseUrl, "/api/trial-reading");
  assert.equal(response.status, 200);
  const payload = await json(response);
  assert.deepEqual(payload.novels.map((novel: any) => novel.projectId), ["published-novel"]);
  assert.deepEqual(payload.novels[0].chapters.map((chapter: any) => chapter.chapterNumber), [1, 2]);
  assert.equal(payload.novels[0].chapters[0].content, "第一章完整正文");
  assert.doesNotMatch(JSON.stringify(payload), /不应泄露|规划标题|候选摘要|不应作为正文展示/);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.novels[0], "status"), false);
});

test("chapter documents are edited and persisted as separate manuscript versions", async (t) => {
  const { server, baseUrl, service } = await setup();
  t.after(() => server.close());
  await service.createProject({ projectId: "document-edit", novelTitle: "Document Edit", targetTotalChapters: 2 });
  const state = await service.getState("document-edit");
  state.foundationApproval = "approved";
  state.workflowPhase = "chapter_loop";
  const context = buildContinuityContext(state, 1);
  state.chapterPlans["1"] = {
    contextHash: context.contextHash,
    chapterNumber: 1,
    title: "旧规划标题",
    openingBridge: {
      previousChapter: 0,
      inheritedEndpoint: "故事尚未开始",
      transitionSteps: ["建立首个场景"],
      firstSceneStart: "主角走进港口",
      carryOverThreads: [],
    },
    causalChain: [{ cause: "收到信号", event: "调查港口", effect: "发现旧终端" }],
    requiredFactIds: [],
    plannedFacts: [],
    informationFlow: [],
  };
  state.chapterCandidates["1"] = {
    chapterNumber: 1,
    title: "第一章",
    contextHash: context.contextHash,
    draft: "原始初稿",
    polishedDraft: "原始润色稿",
    chapterHook: "终端亮起",
    chapterSummary: "主角调查港口",
    endingExcerpt: "屏幕亮了。",
    lastScene: {
      time: "第一日",
      location: "港口",
      povCharacter: "林澈",
      charactersPresent: ["林澈"],
      finalAction: "打开终端",
      finalDialogue: "",
    },
    unresolvedActions: [],
    openThreads: ["信号来源"],
    delta: { factsEstablished: [], knowledgeChanges: [], continuityChanges: {} },
    revision: 1,
    approved: true,
    humanFeedback: "",
    revisionHistory: [],
  };
  state.approvedChapters.push({
    chapterNumber: 1,
    title: "第一章",
    summary: "主角调查港口",
    polishedDraft: "原始审批后正文",
    endingExcerpt: "屏幕亮了。",
    lastScene: state.chapterCandidates["1"]!.lastScene,
    unresolvedActions: [],
    openThreads: ["信号来源"],
  });
  await service.checkpoints.save(state);

  const editedPlan = { ...state.chapterPlans["1"]!, title: "手动修改后的规划" };
  const updates = [
    { kind: "chapter_plan", chapterNumber: 1, value: editedPlan },
    { kind: "chapter_draft", chapterNumber: 1, content: "手动修改后的初稿" },
    { kind: "chapter_polished", chapterNumber: 1, content: "手动修改后的润色稿" },
    { kind: "approved_chapter", chapterNumber: 1, content: "手动修改后的审批正文" },
  ];
  for (const update of updates) {
    const response = await request(baseUrl, "/api/projects/document-edit/documents", {
      method: "PATCH",
      body: JSON.stringify(update),
    });
    assert.equal(response.status, 200);
  }

  const reloaded = await service.getState("document-edit");
  assert.equal(reloaded.chapterPlans["1"]?.title, "手动修改后的规划");
  assert.equal(reloaded.chapterCandidates["1"]?.draft, "手动修改后的初稿");
  assert.equal(reloaded.chapterCandidates["1"]?.polishedDraft, "手动修改后的润色稿");
  assert.equal(reloaded.approvedChapters[0]?.polishedDraft, "手动修改后的审批正文");
  const novel = await request(baseUrl, "/api/projects/document-edit/export/novel");
  assert.match(await novel.text(), /手动修改后的审批正文/);

  const empty = await request(baseUrl, "/api/projects/document-edit/documents", {
    method: "PATCH",
    body: JSON.stringify({ kind: "chapter_draft", chapterNumber: 1, content: "   " }),
  });
  assert.equal(empty.status, 400);
  assert.equal((await service.getState("document-edit")).chapterCandidates["1"]?.draft, "手动修改后的初稿");
});

test("generation without configured Pi Agent fails explicitly and preserves pending state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-web-no-agent-"));
  const service = new GraphNovelService(new CheckpointStore(root));
  const server = createGraphNovelHttpServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await request(baseUrl, "/api/projects", { method: "POST", body: JSON.stringify({ projectId: "no-agent", novelTitle: "No Agent" }) });

  const response = await request(baseUrl, "/api/projects/no-agent/commands/foundation/generate", { method: "POST", body: "{}" });
  assert.equal(response.status, 503);
  assert.equal((await json(response)).code, "agent_unavailable");
  const chatResponse = await request(baseUrl, "/api/creative/chat", { method: "POST", body: JSON.stringify({ message: "测试" }) });
  assert.equal(chatResponse.status, 503);
  assert.equal((await json(chatResponse)).code, "agent_unavailable");
  const state = await request(baseUrl, "/api/projects/no-agent/state");
  const payload = await json(state);
  assert.equal(payload.state.foundationApproval, "pending");
  assert.equal(payload.state.pendingGate, null);
  assert.equal(payload.status, "idle");
});

test("creative chat uses Pi Runtime in both standalone and project context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-web-chat-"));
  const service = new GraphNovelService(
    new CheckpointStore(root),
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor("建议先让主角看到证据，再让消息传播。") },
  );
  const server = createGraphNovelHttpServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await request(baseUrl, "/api/projects", { method: "POST", body: JSON.stringify({ projectId: "chat-project", novelTitle: "Chat Project", creativeGenre: "科幻" }) });

  const creative = await request(baseUrl, "/api/creative/chat", {
    method: "POST",
    body: JSON.stringify({ message: "帮我检查开篇因果", history: [{ role: "user", content: "我想写灾变题材" }] }),
  });
  assert.equal(creative.status, 200);
  assert.equal((await json(creative)).reply, "建议先让主角看到证据，再让消息传播。");

  const project = await request(baseUrl, "/api/projects/chat-project/chat", {
    method: "POST",
    body: JSON.stringify({ message: "结合当前项目给建议", history: [] }),
  });
  assert.equal(project.status, 200);
  assert.equal((await json(project)).success, true);
  const legacyProject = await request(baseUrl, "/api/chat-project/chat", {
    method: "POST",
    body: JSON.stringify({ message: "兼容旧入口", history: [] }),
  });
  assert.equal(legacyProject.status, 200);
  const chatTestPage = await request(baseUrl, "/chat-test");
  assert.equal(chatTestPage.status, 200);
  assert.match(await chatTestPage.text(), /graphnovel-frontend" content="react-shadcn/);

  const invalid = await request(baseUrl, "/api/creative/chat", { method: "POST", body: JSON.stringify({ message: "" }) });
  assert.equal(invalid.status, 400);
});

test("Foundation command runs in background, exposes SSE, and rejects duplicate starts", async (t) => {
  const { server, baseUrl } = await setup();
  t.after(() => server.close());
  await request(baseUrl, "/api/projects", { method: "POST", body: JSON.stringify({ projectId: "foundation-web", novelTitle: "Foundation Web", targetTotalChapters: 2 }) });

  const controller = new AbortController();
  const events = await request(baseUrl, "/api/projects/foundation-web/events", { signal: controller.signal });
  assert.equal(events.status, 200);
  assert.equal(events.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = events.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: state/);
  controller.abort();
  await reader.cancel().catch(() => undefined);

  const started = await request(baseUrl, "/api/projects/foundation-web/commands/foundation/generate", { method: "POST", body: "{}" });
  assert.equal(started.status, 202);
  const duplicate = await request(baseUrl, "/api/projects/foundation-web/commands/foundation/generate", { method: "POST", body: "{}" });
  assert.equal(duplicate.status, 409);
  assert.equal((await json(duplicate)).code, "busy");

  const gated = await waitForStatus(baseUrl, "foundation-web", "awaiting_approval");
  assert.equal(gated.state.pendingGate, "foundation");
  assert.equal(gated.state.foundationReview.passed, true);
  assert.equal(gated.state.foundationReviewAttempts, 1);
  const invalidDecision = await request(baseUrl, "/api/projects/foundation-web/commands/foundation/decision", { method: "POST", body: JSON.stringify({ approved: "yes" }) });
  assert.equal(invalidDecision.status, 400);
  const approved = await request(baseUrl, "/api/projects/foundation-web/commands/foundation/decision", { method: "POST", body: JSON.stringify({ approved: true }) });
  assert.equal(approved.status, 200);
  const approvedState = (await json(approved)).state;
  assert.equal(approvedState.workflowPhase, "chapter_loop");
  assert.equal(approvedState.narrativeFacts[0].factId, "fact_father_missing");
  assert.equal(approvedState.foundationSnapshot.version, 1);
});

test("legacy Foundation upgrade is exposed as a background Graph command", async (t) => {
  const { server, baseUrl, service } = await setup();
  t.after(() => server.close());
  const responses = foundationResponses();
  const state = createInitialState("upgrade-web", "Upgrade Web");
  state.targetTotalChapters = 2;
  state.worldSetting = JSON.parse(responses[1]!);
  state.characters = JSON.parse(responses[2]!);
  state.novelOutline = JSON.parse(responses[6]!);
  state.foundationApproval = "approved";
  state.workflowPhase = "chapter_loop";
  await service.checkpoints.save(state);

  const started = await request(baseUrl, "/api/projects/upgrade-web/commands/foundation/upgrade", {
    method: "POST",
    body: "{}",
  });
  assert.equal(started.status, 202);
  const gated = await waitForStatus(baseUrl, "upgrade-web", "awaiting_approval");
  assert.equal(gated.state.pendingGate, "foundation");
  assert.equal(gated.state.foundationUpgrade.status, "awaiting_approval");
  assert.match(gated.state.foundationUpgrade.backupFile, /pre-foundation-upgrade.*\.json\.bak$/);

  const approved = await request(baseUrl, "/api/projects/upgrade-web/commands/foundation/decision", {
    method: "POST",
    body: JSON.stringify({ approved: true }),
  });
  assert.equal(approved.status, 200);
  const approvedState = (await json(approved)).state;
  assert.equal(approvedState.foundationUpgrade.status, "completed");
  assert.equal(approvedState.foundationUpgrade.source, null);
  assert.equal(approvedState.foundationSnapshot.version, 1);
});

test("exports state and novel through the same service checkpoint", async (t) => {
  const { server, baseUrl, service } = await setup();
  t.after(() => server.close());
  await service.createProject({ projectId: "export-web", novelTitle: "Export Web" });
  const stateExport = await request(baseUrl, "/api/projects/export-web/export/state");
  assert.equal(stateExport.status, 200);
  assert.match(stateExport.headers.get("content-disposition") ?? "", /export-web\.json/);
  assert.match(await stateExport.text(), /Export Web/);
  const novelExport = await request(baseUrl, "/api/projects/export-web/export/novel");
  assert.equal(novelExport.status, 200);
  assert.equal(await novelExport.text(), "");
});

test("a fresh Node service reloads persisted Gate and FAILED checkpoints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-restart-"));
  const firstService = new GraphNovelService(new CheckpointStore(root));
  await firstService.createProject({ projectId: "restart-test", novelTitle: "Restart Test" });
  const gatedState = await firstService.getState("restart-test");
  gatedState.workflowPhase = "awaiting_approval";
  gatedState.pendingGate = "foundation";
  await firstService.checkpoints.save(gatedState);

  const firstServer = createGraphNovelHttpServer(firstService);
  await new Promise<void>((resolve) => firstServer.listen(0, "127.0.0.1", resolve));
  const firstAddress = firstServer.address() as AddressInfo;
  const firstStatus = await request(`http://127.0.0.1:${firstAddress.port}`, "/api/projects/restart-test/status");
  assert.equal((await json(firstStatus)).status, "awaiting_approval");
  await new Promise<void>((resolve, reject) => firstServer.close((error) => error ? reject(error) : resolve()));

  const secondService = new GraphNovelService(new CheckpointStore(root));
  const secondServer = createGraphNovelHttpServer(secondService);
  await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
  t.after(() => secondServer.close());
  const secondAddress = secondServer.address() as AddressInfo;
  const reloaded = await request(`http://127.0.0.1:${secondAddress.port}`, "/api/projects/restart-test/status");
  assert.equal((await json(reloaded)).status, "awaiting_approval");

  const failedState = await secondService.getState("restart-test");
  failedState.workflowPhase = "failed";
  failedState.lastError = { nodeKey: "world_building", message: "persisted failure", attempt: 1, timestamp: new Date().toISOString() };
  await secondService.checkpoints.save(failedState);
  const failedReload = await request(`http://127.0.0.1:${secondAddress.port}`, "/api/projects/restart-test/status");
  assert.equal((await json(failedReload)).status, "failed");
});

test("chapter rewrite exhaustion can be reopened through an explicit manual-revision command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-web-reopen-"));
  const service = new GraphNovelService(new CheckpointStore(root));
  const state = await service.createProject({ projectId: "reopen-web", novelTitle: "Reopen Web", targetTotalChapters: 1 });
  state.foundationApproval = "approved";
  state.workflowPhase = "failed";
  state.pendingChapterNumber = 1;
  state.chapterRewriteAttempts["1"] = 3;
  state.chapterWritingFeedback["1"] = "旧审稿反馈";
  state.chapterCandidates["1"] = {
    chapterNumber: 1,
    title: "第一章",
    contextHash: "context",
    draft: "人工修订前正文",
    polishedDraft: "人工修订前正文",
    chapterHook: "钩子",
    chapterSummary: "摘要",
    endingExcerpt: "结尾",
    lastScene: { time: "第一日", location: "港口", povCharacter: "林澈", charactersPresent: ["林澈"], finalAction: "停下", finalDialogue: "" },
    unresolvedActions: [],
    openThreads: [],
    delta: { factsEstablished: [], knowledgeChanges: [], continuityChanges: {} },
    revision: 3,
    approved: false,
    humanFeedback: "旧审稿反馈",
    revisionHistory: [],
  };
  state.chapterReviews["1"] = { contextHash: "context", chapterNumber: 1, score: 4, requiresRewrite: true, rewriteScope: "修正承接", issues: ["承接不足"], narrativeViolations: [], summary: "需要重写" };
  state.nodes.consistency_review_1 = { status: "failed", attempts: 4, error: "Chapter rewrite limit exceeded (2)" };
  state.lastError = { nodeKey: "consistency_review_1", message: "Chapter rewrite limit exceeded (2)", attempt: 4, timestamp: new Date().toISOString() };
  await service.checkpoints.save(state);

  const server = createGraphNovelHttpServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const missingFeedback = await request(baseUrl, "/api/projects/reopen-web/commands/chapters/1/writing-reopen", { method: "POST", body: JSON.stringify({}) });
  assert.equal(missingFeedback.status, 400);
  const reopened = await request(baseUrl, "/api/projects/reopen-web/commands/chapters/1/writing-reopen", { method: "POST", body: JSON.stringify({ feedback: "已修正承接和伏笔，并人工检查正文" }) });
  assert.equal(reopened.status, 200);
  const reopenedState = (await json(reopened)).state;
  assert.equal(reopenedState.workflowPhase, "chapter_loop");
  assert.equal(reopenedState.chapterRewriteAttempts["1"], 0);
  assert.equal(reopenedState.nodes.consistency_review_1.status, "pending");
  assert.equal(reopenedState.chapterCandidates["1"].revision, 3);
  assert.equal(reopenedState.lastError, null);
});
