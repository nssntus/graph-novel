import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseState,
  serializeState,
  type GraphNovelState,
} from "../state/state.js";

export class ProjectBusyError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Project is already running: ${projectId}`);
    this.name = "ProjectBusyError";
    this.projectId = projectId;
  }
}

export class CheckpointStore {
  constructor(private readonly rootDir: string) {}

  async save(state: GraphNovelState): Promise<string> {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.statePath(state.projectId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, serializeState(state), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    return target;
  }

  async backup(state: GraphNovelState, label: string): Promise<string> {
    await mkdir(this.rootDir, { recursive: true });
    const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!safeLabel) throw new Error("Backup label cannot be empty");
    const fileName = `${encodeURIComponent(state.projectId)}.${safeLabel}.${randomUUID()}.json.bak`;
    await writeFile(join(this.rootDir, fileName), serializeState(state), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return fileName;
  }

  async load(projectId: string): Promise<GraphNovelState | null> {
    try {
      return parseState(await readFile(this.statePath(projectId), "utf8"));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async list(): Promise<GraphNovelState[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const states: GraphNovelState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        states.push(parseState(await readFile(join(this.rootDir, entry.name), "utf8")));
      } catch {
        // Ignore unrelated or incomplete files; an explicit load still reports its error.
      }
    }
    return states.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.rootDir, { recursive: true });
    const lockPath = this.lockPath(projectId);
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (!(await isStaleLock(lockPath))) throw new ProjectBusyError(projectId);
      await rm(lockPath, { force: true });
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (retryError) {
        if (isAlreadyExists(retryError)) throw new ProjectBusyError(projectId);
        throw retryError;
      }
    }

    try {
      await handle.writeFile(
        JSON.stringify({ projectId, pid: process.pid, startedAt: new Date().toISOString() }),
        "utf8",
      );
      return await operation();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }

  private statePath(projectId: string): string {
    return join(this.rootDir, `${encodeURIComponent(projectId)}.json`);
  }

  private lockPath(projectId: string): string {
    return join(this.rootDir, `${encodeURIComponent(projectId)}.lock`);
  }
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || !("pid" in value)) return false;
    const pid = (value as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return isNodeError(error) && error.code === "ESRCH";
    }
  } catch (error) {
    return isMissingFile(error);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
