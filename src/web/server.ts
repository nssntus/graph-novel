import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";
import {
  GraphNovelService,
  ServiceError,
  type CreateProjectInput,
  type ServiceEvent,
} from "./service.js";
import type { CreativeChatInput, CreativeChatMessage } from "../agents/creative-chat.js";
import type { CreativeProjectDraftInput } from "../agents/creative-project-draft.js";

const MAX_BODY_BYTES = 1_000_000;
const FRONTEND_ROOT = resolve(process.cwd(), "dist/web");

export function createGraphNovelHttpServer(service: GraphNovelService): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, service).catch((error: unknown) => {
      sendError(response, error);
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: GraphNovelService,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/reader" || url.pathname === "/chat-test" || parts[0] === "project" || url.pathname === "/favicon.svg" || url.pathname.startsWith("/assets/"))) {
    await serveReaderFrontend(url.pathname, response);
    return;
  }
  if (parts[0] !== "api") throw new ServiceError(404, "not_found", "路径不存在");
  if (request.method === "GET" && parts.length === 2 && parts[1] === "projects") {
    const projects = await service.listProjects();
    const entries = await Promise.all(projects.map(async (state) => ({
      projectId: state.projectId,
      novelTitle: state.novelTitle,
      status: (await service.getStatus(state.projectId)).status,
    })));
    sendJson(response, 200, { projects: entries });
    return;
  }
  if (request.method === "GET" && parts.length === 2 && parts[1] === "trial-reading") {
    sendJson(response, 200, { novels: await service.listTrialReadingNovels() });
    return;
  }
  if (request.method === "POST" && parts.length === 2 && parts[1] === "projects") {
    const state = await service.createProject(await readJson<CreateProjectInput>(request));
    sendJson(response, 201, { project: state });
    return;
  }
  if (request.method === "POST" && parts.length === 3 && parts[1] === "creative" && parts[2] === "project-draft") {
    const result = await service.draftProjectFromCreativeChat(parseCreativeProjectDraftRequest(await readJson<Record<string, unknown>>(request)));
    sendJson(response, 200, { success: true, draft: result.draft, sessionId: result.sessionId });
    return;
  }
  if (request.method === "POST" && parts.length === 3 && parts[0] === "api" && parts[2] === "chat") {
    const input = parseChatRequest(await readJson<Record<string, unknown>>(request));
    const result = parts[1] === "creative"
      ? await service.chatCreatively(input)
      : await service.chatFor(parts[1], input);
    sendJson(response, 200, { success: true, reply: result.reply, sessionId: result.sessionId });
    return;
  }
  if (parts.length < 3 || parts[1] !== "projects") throw new ServiceError(404, "not_found", "路径不存在");
  const projectId = parts[2];
  if (request.method === "GET" && parts.length === 4 && parts[3] === "state") {
    const state = await service.getState(projectId);
    sendJson(response, 200, { state, status: (await service.getStatus(projectId)).status });
    return;
  }
  if (request.method === "GET" && parts.length === 4 && parts[3] === "status") {
    sendJson(response, 200, await service.getStatus(projectId));
    return;
  }
  if (request.method === "GET" && parts.length === 4 && parts[3] === "events") {
    await openEvents(request, response, service, projectId);
    return;
  }
  if (request.method === "GET" && parts.length === 5 && parts[3] === "export") {
    const state = await service.getState(projectId);
    if (parts[4] === "state") {
      sendText(response, 200, service.exportState(state), "application/json; charset=utf-8", `${projectId}.json`);
      return;
    }
    if (parts[4] === "novel") {
      sendText(response, 200, service.exportNovel(state), "text/markdown; charset=utf-8", `${projectId}.md`);
      return;
    }
  }
  if (request.method === "POST" && parts.length === 4 && parts[3] === "chat") {
    const result = await service.chatFor(projectId, parseChatRequest(await readJson<Record<string, unknown>>(request)));
    sendJson(response, 200, { success: true, reply: result.reply, sessionId: result.sessionId });
    return;
  }
  if (request.method === "PATCH" && parts.length === 4 && parts[3] === "documents") {
    const state = await service.updateChapterDocumentFor(
      projectId,
      await readJson(request),
    );
    sendJson(response, 200, { success: true, state });
    return;
  }
  if (request.method === "POST") {
    if (parts[3] !== "commands") throw new ServiceError(404, "not_found", "路径不存在");
    await handleCommand(request, response, service, projectId, parts.slice(4));
    return;
  }
  throw new ServiceError(404, "not_found", "路径不存在");
}

async function serveReaderFrontend(pathname: string, response: ServerResponse): Promise<void> {
  const isStaticAsset = pathname === "/favicon.svg" || pathname.startsWith("/assets/");
  const relativePath = isStaticAsset ? pathname.slice(1) : "index.html";
  const filePath = resolve(FRONTEND_ROOT, normalize(relativePath));
  if (filePath !== FRONTEND_ROOT && !filePath.startsWith(`${FRONTEND_ROOT}/`)) {
    throw new ServiceError(400, "invalid_path", "非法资源路径");
  }
  try {
    const body = await readFile(filePath);
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    }[extname(filePath)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": contentType, "cache-control": isStaticAsset ? "public, max-age=31536000, immutable" : "no-cache" });
    response.end(body);
  } catch (error: unknown) {
    if (isStaticAsset) throw new ServiceError(404, "not_found", "资源不存在");
    throw error;
  }
}

async function handleCommand(
  request: IncomingMessage,
  response: ServerResponse,
  service: GraphNovelService,
  projectId: string,
  command: string[],
): Promise<void> {
  const body = await readJson<Record<string, unknown>>(request);
  if (command.length === 2 && command[0] === "foundation" && command[1] === "generate") {
    sendJson(response, 202, { task: await service.startFoundationFor(projectId) });
    return;
  }
  if (command.length === 2 && command[0] === "foundation" && command[1] === "upgrade") {
    sendJson(response, 202, { task: await service.startFoundationUpgradeFor(projectId) });
    return;
  }
  if (command.length === 2 && command[0] === "foundation" && command[1] === "decision") {
    const decision = parseDecision(body);
    sendJson(response, 200, { state: await service.decideFoundationFor(projectId, decision.approved, decision.feedback) });
    return;
  }
  if (command.length === 2 && command[0] === "global-review" && command[1] === "generate") {
    sendJson(response, 202, { task: await service.startGlobalReviewFor(projectId) });
    return;
  }
  if (command.length === 3 && command[0] === "chapters") {
    const chapterNumber = parseChapterNumber(command[1]);
    const action = command[2];
    if (action === "plan") {
      sendJson(response, 202, { task: await service.startChapterPlanningFor(projectId, chapterNumber) });
      return;
    }
    if (action === "plan-decision") {
      const decision = parseDecision(body);
      sendJson(response, 200, { state: await service.decideChapterPlanFor(projectId, chapterNumber, decision.approved, decision.feedback) });
      return;
    }
    if (action === "writing") {
      sendJson(response, 202, { task: await service.startChapterWritingFor(projectId, chapterNumber) });
      return;
    }
    if (action === "writing-decision") {
      const decision = parseDecision(body);
      sendJson(response, 200, { state: await service.decideChapterWritingFor(projectId, chapterNumber, decision.approved, decision.feedback) });
      return;
    }
    if (action === "writing-reopen") {
      const feedback = parseFeedback(body);
      sendJson(response, 200, { state: await service.reopenChapterWritingFor(projectId, chapterNumber, feedback) });
      return;
    }
  }
  throw new ServiceError(404, "not_found", "graph command 不存在");
}

async function openEvents(
  request: IncomingMessage,
  response: ServerResponse,
  service: GraphNovelService,
  projectId: string,
): Promise<void> {
  await service.getState(projectId);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: ServiceEvent): void => {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = service.subscribe(projectId, send);
  send({ type: "state", status: (await service.getStatus(projectId)).status });
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function parseDecision(body: Record<string, unknown>): { approved: boolean; feedback: string } {
  if (typeof body.approved !== "boolean") throw new ServiceError(400, "invalid_input", "approved 必须是布尔值");
  if (body.feedback !== undefined && typeof body.feedback !== "string") throw new ServiceError(400, "invalid_input", "feedback 必须是字符串");
  return { approved: body.approved, feedback: typeof body.feedback === "string" ? body.feedback : "" };
}

function parseFeedback(body: Record<string, unknown>): string {
  if (typeof body.feedback !== "string" || !body.feedback.trim()) {
    throw new ServiceError(400, "invalid_input", "feedback 必须是非空字符串");
  }
  return body.feedback;
}

function parseChatRequest(body: Record<string, unknown>): CreativeChatInput {
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 2000) {
    throw new ServiceError(400, "invalid_input", "message 必须是 1-2000 个字符");
  }
  const rawHistory = body.history === undefined ? [] : body.history;
  if (!Array.isArray(rawHistory) || rawHistory.length > 20) {
    throw new ServiceError(400, "invalid_input", "history 必须是最多 20 条消息的数组");
  }
  const history = rawHistory.map((item, index) => {
    if (!item || typeof item !== "object") throw new ServiceError(400, "invalid_input", `history[${index}] 格式无效`);
    const message = item as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") {
      throw new ServiceError(400, "invalid_input", `history[${index}].role 必须是 user 或 assistant`);
    }
    if (typeof message.content !== "string" || !message.content.trim() || message.content.length > 4000) {
      throw new ServiceError(400, "invalid_input", `history[${index}].content 长度无效`);
    }
    const role = message.role as "user" | "assistant";
    return { role, content: message.content.trim() };
  });
  return { message: body.message.trim(), history };
}

function parseCreativeProjectDraftRequest(body: Record<string, unknown>): CreativeProjectDraftInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ServiceError(400, "invalid_input", "请求体必须是对象");
  }
  if (!Array.isArray(body.history) || body.history.length === 0 || body.history.length > 20) {
    throw new ServiceError(400, "invalid_input", "history 必须是 1-20 条消息的数组");
  }
  const history = body.history.map((item, index): CreativeChatMessage => {
    if (!item || typeof item !== "object") throw new ServiceError(400, "invalid_input", `history[${index}] 格式无效`);
    const message = item as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") {
      throw new ServiceError(400, "invalid_input", `history[${index}].role 必须是 user 或 assistant`);
    }
    if (typeof message.content !== "string" || !message.content.trim() || message.content.length > 4000) {
      throw new ServiceError(400, "invalid_input", `history[${index}].content 长度无效`);
    }
    return { role: message.role, content: message.content.trim() };
  });
  if (!history.some((message) => message.role === "user")) {
    throw new ServiceError(400, "invalid_input", "history 至少需要一条作者消息");
  }
  return { history };
}

function parseChapterNumber(value: string): number {
  if (!/^\d+$/.test(value)) throw new ServiceError(400, "invalid_input", "章节号必须是正整数");
  const chapterNumber = Number(value);
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) throw new ServiceError(400, "invalid_input", "章节号必须是正整数");
  return chapterNumber;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > MAX_BODY_BYTES) throw new ServiceError(413, "body_too_large", "请求体过大");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ServiceError(413, "body_too_large", "请求体过大");
    chunks.push(buffer);
  }
  if (size === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new ServiceError(400, "invalid_json", "请求体必须是合法 JSON");
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ServiceError(400, "invalid_path", "路径编码无效");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendText(response: ServerResponse, statusCode: number, body: string, contentType: string, filename: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const serviceError = error instanceof ServiceError
    ? error
    : new ServiceError(500, "internal_error", error instanceof Error ? error.message : String(error));
  sendJson(response, serviceError.statusCode, { error: serviceError.message, code: serviceError.code });
}
