import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCliArgs, runCli } from "../src/cli.js";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { GraphNovelService } from "../src/web/service.js";

test("CLI parses bounded project commands and uses the shared checkpoint service", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graphnovel-cli-"));
  const create = parseCliArgs(["create", "--dir", rootDir, "--project-id", "cli-test", "--title", "CLI Test", "--chapters", "4"]);
  assert.equal(create.input?.targetTotalChapters, 4);
  const created = JSON.parse(await runCli(create));
  assert.equal(created.projectId, "cli-test");

  const list = JSON.parse(await runCli(parseCliArgs(["list", "--dir", rootDir])));
  assert.equal(list[0].projectId, "cli-test");
  const service = new GraphNovelService(new CheckpointStore(rootDir));
  const reviewCommand = parseCliArgs(["global-review", "--dir", rootDir, "--project-id", "cli-test"]);
  await assert.rejects(() => runCli(reviewCommand, service), /未配置 Pi Agent/);
  const decision = parseCliArgs(["foundation-decision", "--dir", rootDir, "--project-id", "cli-test", "--approved", "false", "--feedback", "补充因果"]);
  assert.equal(decision.approved, false);
  assert.throws(() => parseCliArgs(["state"]), /缺少 --project-id/);
  assert.throws(() => parseCliArgs(["export", "--project-id", "cli-test"]), /--kind/);
});
