import { CheckpointStore } from "./checkpoint/store.js";
import { previewLegacyFile, writeMigratedFile } from "./migration/io.js";
import { createAgentDependenciesFromEnv, loadProjectEnv } from "./runtime/config.js";
import { GraphNovelService, type CreateProjectInput } from "./web/service.js";

export interface CliCommand {
  name:
    | "list"
    | "create"
    | "state"
    | "export"
    | "foundation-generate"
    | "foundation-decision"
    | "chapter-plan"
    | "chapter-plan-decision"
    | "chapter-writing"
    | "chapter-writing-decision"
    | "global-review"
    | "migration-preview"
    | "migration-write";
  projectId?: string;
  input?: CreateProjectInput;
  exportKind?: "state" | "novel";
  chapterNumber?: number;
  approved?: boolean;
  feedback?: string;
  sourcePath?: string;
  allowReview?: boolean;
  force?: boolean;
  rootDir: string;
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [rawName = "list", ...rest] = argv;
  const name = parseCommandName(rawName);
  const flags = parseFlags(rest);
  const rootDir = flags.dir ?? process.env.GRAPH_NOVEL_DIR ?? "./.graphnovel-data";
  if (name === "list") return { name, rootDir };
  if (name === "migration-preview") {
    return { name, rootDir, sourcePath: requiredFlag(flags, "source") };
  }
  if (name === "migration-write") {
    return {
      name,
      rootDir,
      sourcePath: requiredFlag(flags, "source"),
      allowReview: booleanFlag(flags, "allow-review"),
      force: booleanFlag(flags, "force"),
    };
  }
  if (name === "state") return { name, rootDir, projectId: requiredFlag(flags, "project-id") };
  if (name === "export") {
    const exportKind = flags.kind === "novel" ? "novel" : flags.kind === "state" ? "state" : undefined;
    if (!exportKind) throw new Error("export 需要 --kind state|novel");
    return { name, rootDir, projectId: requiredFlag(flags, "project-id"), exportKind };
  }
  if (["foundation-generate", "global-review"].includes(name)) {
    return { name, rootDir, projectId: requiredFlag(flags, "project-id") };
  }
  if (["foundation-decision", "chapter-plan-decision", "chapter-writing-decision"].includes(name)) {
    const approved = requiredFlag(flags, "approved");
    if (approved !== "true" && approved !== "false") throw new Error("--approved 必须是 true 或 false");
    return {
      name,
      rootDir,
      projectId: requiredFlag(flags, "project-id"),
      chapterNumber: name === "foundation-decision" ? undefined : integerFlag(requiredFlag(flags, "chapter"), "chapter"),
      approved: approved === "true",
      feedback: flags.feedback,
    };
  }
  if (["chapter-plan", "chapter-writing"].includes(name)) {
    return {
      name,
      rootDir,
      projectId: requiredFlag(flags, "project-id"),
      chapterNumber: integerFlag(requiredFlag(flags, "chapter"), "chapter"),
    };
  }
  if (name === "create") {
    return {
      name,
      rootDir,
      input: {
        projectId: flags["project-id"],
        novelTitle: requiredFlag(flags, "title"),
        creativeGenre: flags.genre,
        creativePremise: flags.premise,
        creativeTheme: flags.theme,
        creativeNotes: flags.notes,
        targetTotalChapters: flags.chapters ? integerFlag(flags.chapters, "chapters") : undefined,
        targetTotalWords: flags.words ? integerFlag(flags.words, "words") : undefined,
      },
    };
  }
  throw new Error(`未知 CLI 命令：${name}`);
}

type CliCommandName = CliCommand["name"];

function parseCommandName(value: string): CliCommandName {
  const supported: readonly CliCommandName[] = [
    "list",
    "create",
    "state",
    "export",
    "foundation-generate",
    "foundation-decision",
    "chapter-plan",
    "chapter-plan-decision",
    "chapter-writing",
    "chapter-writing-decision",
    "global-review",
    "migration-preview",
    "migration-write",
  ];
  if (!supported.includes(value as CliCommandName)) throw new Error(`未知 CLI 命令：${value}`);
  return value as CliCommandName;
}

export async function runCli(command: CliCommand, providedService?: GraphNovelService): Promise<string> {
  if (command.name === "migration-preview") {
    return JSON.stringify((await previewLegacyFile(command.sourcePath!)).report, null, 2);
  }
  if (command.name === "migration-write") {
    return JSON.stringify(await writeMigratedFile(command.sourcePath!, command.rootDir, {
      allowReview: command.allowReview,
      force: command.force,
    }), null, 2);
  }
  const service = providedService ?? new GraphNovelService(new CheckpointStore(command.rootDir), createAgentDependenciesFromEnv());
  if (command.name === "list") {
    const projects = await service.listProjects();
    return JSON.stringify(projects.map((state) => ({ projectId: state.projectId, novelTitle: state.novelTitle, workflowPhase: state.workflowPhase })), null, 2);
  }
  if (command.name === "create") return JSON.stringify(await service.createProject(command.input!), null, 2);
  const state = await service.getState(command.projectId!);
  if (command.name === "state") return JSON.stringify(state, null, 2);
  if (command.name === "foundation-generate") return JSON.stringify(await service.startFoundationFor(command.projectId!), null, 2);
  if (command.name === "foundation-decision") return JSON.stringify(await service.decideFoundationFor(command.projectId!, command.approved!, command.feedback), null, 2);
  if (command.name === "chapter-plan") return JSON.stringify(await service.startChapterPlanningFor(command.projectId!, command.chapterNumber!), null, 2);
  if (command.name === "chapter-plan-decision") return JSON.stringify(await service.decideChapterPlanFor(command.projectId!, command.chapterNumber!, command.approved!, command.feedback), null, 2);
  if (command.name === "chapter-writing") return JSON.stringify(await service.startChapterWritingFor(command.projectId!, command.chapterNumber!), null, 2);
  if (command.name === "chapter-writing-decision") return JSON.stringify(await service.decideChapterWritingFor(command.projectId!, command.chapterNumber!, command.approved!, command.feedback), null, 2);
  if (command.name === "global-review") return JSON.stringify(await service.startGlobalReviewFor(command.projectId!), null, 2);
  return command.exportKind === "novel" ? service.exportNovel(state) : service.exportState(state);
}

async function main(): Promise<void> {
  loadProjectEnv();
  const command = parseCliArgs(process.argv.slice(2));
  process.stdout.write(`${await runCli(command)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

type Flags = Record<string, string | undefined>;

function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) throw new Error(`无法识别参数：${token ?? ""}`);
    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 --${key} 需要值`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

function requiredFlag(flags: Flags, key: string): string {
  const value = flags[key];
  if (!value?.trim()) throw new Error(`缺少 --${key}`);
  return value.trim();
}

function booleanFlag(flags: Flags, key: string): boolean {
  const value = flags[key];
  if (value === undefined) return false;
  if (value !== "true" && value !== "false") throw new Error(`--${key} 必须是 true 或 false`);
  return value === "true";
}

function integerFlag(value: string, key: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`--${key} 必须是正整数`);
  return Number(value);
}
