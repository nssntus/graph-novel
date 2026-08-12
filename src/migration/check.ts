import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateLegacyState } from "./legacy.js";

const sourcePath = join(process.cwd(), "examples", "xunhuan-zhi-wai", "xunhuan-zhi-wai_state.json");
const result = migrateLegacyState(JSON.parse(await readFile(sourcePath, "utf8")), sourcePath);
if (result.report.status !== "ready") {
  throw new Error(`迁移检查需要人工复核：${JSON.stringify(result.report.issues)}`);
}
if (result.state.approvedChapters.length !== 5 || result.state.narrativeFacts.length !== 5) {
  throw new Error("示例项目迁移计数不符合预期");
}
process.stdout.write(`${JSON.stringify(result.report)}\n`);
