import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { CheckpointStore } from "../checkpoint/store.js";
import { migrateLegacyState, MigrationError, type MigrationReport, type MigrationResult } from "./legacy.js";

export interface MigrationWriteOptions {
  allowReview?: boolean;
  force?: boolean;
}

export interface MigrationWriteResult {
  report: MigrationReport;
  statePath: string;
  backupPath: string;
  reusedExisting: boolean;
}

export async function previewLegacyFile(sourcePath: string): Promise<MigrationResult> {
  const resolvedSource = resolve(sourcePath);
  const serialized = await readFile(resolvedSource, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new MigrationError("source", `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return migrateLegacyState(value, resolvedSource);
}

export async function writeMigratedFile(
  sourcePath: string,
  destinationDir: string,
  options: MigrationWriteOptions = {},
): Promise<MigrationWriteResult> {
  const resolvedSource = resolve(sourcePath);
  const resolvedDestination = resolve(destinationDir);
  const result = await previewLegacyFile(resolvedSource);
  if (result.report.status === "requires_review" && !options.allowReview) {
    throw new MigrationError(
      "migration",
      "迁移结果需要人工复核；先运行 preview，确认后使用 --allow-review true",
    );
  }

  await mkdir(resolvedDestination, { recursive: true });
  const statePath = join(resolvedDestination, `${encodeURIComponent(result.state.projectId)}.json`);
  const backupPath = join(resolvedDestination, `${encodeURIComponent(result.state.projectId)}.legacy.json`);
  if (resolve(statePath) === resolvedSource) {
    throw new MigrationError("destination", "目标 State 不能覆盖源 JSON，请使用新的目录");
  }

  await copySourceIfMissing(resolvedSource, backupPath);
  if (!options.force && await exists(statePath)) {
    const existing = await new CheckpointStore(resolvedDestination).load(result.state.projectId);
    if (existing) {
      return { report: result.report, statePath, backupPath, reusedExisting: true };
    }
    throw new MigrationError("destination", `目标文件已存在且不是可复用的 GraphNovelState：${statePath}`);
  }
  await new CheckpointStore(resolvedDestination).save(result.state);
  return { report: result.report, statePath, backupPath, reusedExisting: false };
}

async function copySourceIfMissing(sourcePath: string, backupPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (isAlreadyExists(error)) return;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
