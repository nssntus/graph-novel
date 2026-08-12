import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { parseGlobalReview } from "../contracts/global-review.js";
import { CheckpointStore } from "../checkpoint/store.js";
import { GraphEngine, type GraphNode, type GraphRunResult } from "../graph/engine.js";
import { PiAgentRuntime } from "../runtime/agent.js";
import { runContractedNode } from "../runtime/contracts.js";
import type { GraphEventSink } from "../runtime/types.js";
import type { GraphNovelState } from "../state/state.js";

export interface GlobalReviewDependencies {
  runtime: PiAgentRuntime;
  model: Model<any>;
  streamFn: StreamFn;
}

const NODE = "global_review";

const GLOBAL_REVIEW_CONTRACT = {
  overallScore: "1 到 10 的整数",
  readyForPlatform: "布尔值",
  summary: "非空字符串",
  recommendations: ["非空字符串；没有建议则为空数组"],
};

export function createGlobalReviewEngine(
  dependencies: GlobalReviewDependencies,
  checkpoints: CheckpointStore,
): GraphEngine {
  const nodes: GraphNode[] = [{
    key: NODE,
    async run(context) {
      const expected = context.state.targetTotalChapters;
      if (expected < 1 || context.state.approvedChapters.length < expected) {
        return { status: "failed", error: "All chapters must be approved before global review" };
      }
      const output = await runContractedNode(
        context,
        dependencies,
        NODE,
        `你负责全书终审。只输出一个 JSON 对象，不要 Markdown 代码围栏、解释或额外文字。严格遵守以下完整输出契约：${JSON.stringify(GLOBAL_REVIEW_CONTRACT)}。只能基于已批准章节评价，不得编造未完成章节内容。`,
        JSON.stringify({
          novelTitle: context.state.novelTitle,
          creativeGenre: context.state.creativeGenre,
          creativePremise: context.state.creativePremise,
          targetTotalChapters: expected,
          approvedChapters: context.state.approvedChapters,
          output: "GlobalReviewOutput",
          outputContract: GLOBAL_REVIEW_CONTRACT,
        }),
        parseGlobalReview,
      );
      context.state.globalReview = {
        ...output,
        reviewedChapterCount: context.state.approvedChapters.length,
      };
      context.state.workflowPhase = "global_review";
      return { status: "completed" };
    },
  }];
  return new GraphEngine(nodes, [{ from: NODE, to: null, reason: "global_review_completed", when: completed }], checkpoints);
}

export async function runGlobalReview(
  state: GraphNovelState,
  dependencies: GlobalReviewDependencies,
  checkpoints: CheckpointStore,
  sink?: GraphEventSink,
): Promise<GraphRunResult> {
  return createGlobalReviewEngine(dependencies, checkpoints).run(state, NODE, sink);
}

function completed(outcome: { status: string }): boolean {
  return outcome.status === "completed";
}
