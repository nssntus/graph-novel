import assert from "node:assert/strict";
import test from "node:test";
import { parseChapterPlan } from "../src/contracts/chapter.js";
import { buildContinuityContext } from "../src/state/continuity.js";
import { createInitialState } from "../src/state/state.js";

function baseState() {
  const state = createInitialState("continuity-test", "Continuity Test");
  state.novelOutline = {
    genre: "都市科幻",
    premise: "维修员追查海上城秘密",
    theme: "真相与责任",
    targetLength: "12章",
    chapterOutlines: [{
      chapterNumber: 2,
      title: "回声来源",
      summary: "林澈沿着异常信号寻找来源",
      keyEvents: ["追踪信号"],
      foreshadowingToPlant: ["旧徽章"],
      foreshadowingToPayOff: [],
    }],
  };
  state.approvedChapters = [{
    chapterNumber: 1,
    title: "潮汐警报",
    summary: "林澈发现异常信号",
    polishedDraft: "警报在维修舱深处再次响起。",
    endingExcerpt: "警报在维修舱深处再次响起。",
    lastScene: {
      time: "第一日夜间",
      location: "海上城维修舱",
      povCharacter: "林澈",
      charactersPresent: ["林澈"],
      finalAction: "林澈保存了信号频段",
      finalDialogue: "这不是潮汐噪声。",
    },
    unresolvedActions: ["确认信号来源"],
    openThreads: ["旧徽章上的编号"],
  }];
  state.narrativeFacts = [{
    factId: "signal_exists",
    statement: "维修舱收到一段异常信号",
    category: "plot",
    establishedInChapter: 1,
    visibility: "林澈已知",
  }];
  state.characterKnowledge = [{
    factId: "signal_exists",
    character: "林澈",
    knowledgeLevel: "confirmed",
    learnedInChapter: 1,
    sourceType: "observed",
    sourceCharacter: "",
    evidence: "林澈亲自听见信号",
  }];
  state.characterArcs = { 林澈: "从谨慎观察转向主动追查" };
  state.foreshadowings = [{ id: "badge", description: "旧徽章上的编号", plantedInChapter: 1, status: "planted" }];
  state.continuity.time = "第一日夜间";
  state.continuity.characterLocations = { 林澈: "海上城维修舱" };
  state.continuity.characterConditions = { 林澈: "轻微擦伤" };
  state.continuity.resources = { 林澈: "维修工具" };
  return state;
}

function planFor(contextHash: string, patch: Record<string, unknown> = {}) {
  return {
    contextHash,
    chapterNumber: 2,
    title: "回声来源",
    openingBridge: {
      previousChapter: 1,
      inheritedEndpoint: "警报在维修舱深处再次响起。",
      transitionSteps: ["林澈确认信号仍在重复", "他带上维修工具前往旧天线室"],
      firstSceneStart: "林澈没有离开维修舱，而是先检查频段记录。",
      carryOverThreads: ["确认信号来源"],
    },
    causalChain: [{
      cause: "异常信号持续重复",
      event: "林澈追踪到旧天线室",
      effect: "他发现信号与旧徽章编号有关",
    }],
    requiredFactIds: ["signal_exists"],
    plannedFacts: [{
      factId: "badge_frequency_link",
      statement: "异常信号使用旧徽章编号对应的频段",
      category: "plot",
      visibility: "林澈可验证",
    }],
    informationFlow: [{
      factId: "signal_exists",
      character: "林澈",
      knowledgeLevel: "confirmed",
      sourceType: "observed",
      sourceCharacter: "",
      evidence: "林澈复核了第一章保存的频段记录",
    }],
    ...patch,
  };
}

test("continuity context distinguishes first chapter and direct predecessor", () => {
  const first = buildContinuityContext(createInitialState("first", "First"), 1);
  assert.equal(first.immediatePredecessor, null);
  assert.equal(first.targetChapter, 1);

  const state = baseState();
  const context = buildContinuityContext(state, 2);
  assert.equal(context.contextVersion, 1);
  assert.equal("foundationContext" in context, false);
  assert.equal(context.immediatePredecessor?.chapterNumber, 1);
  assert.equal(context.recentChapterSummaries[0]?.endingExcerpt, "警报在维修舱深处再次响起。");
  assert.equal(context.targetOutline?.chapterNumber, 2);
  assert.equal(context.contextHash.length, 64);
});

test("chapter plan must use the exact continuity context hash", () => {
  const context = buildContinuityContext(baseState(), 2);
  const parsed = parseChapterPlan(JSON.stringify(planFor(context.contextHash)), 2, context);
  assert.equal(parsed.openingBridge.previousChapter, 1);
  assert.equal(parsed.informationFlow[0]?.sourceCharacter, "");

  assert.throws(
    () => parseChapterPlan(JSON.stringify(planFor("wrong")), 2, context),
    /chapter_plan\.contextHash/,
  );
});

test("chapter plan rejects null source character and untraceable information", () => {
  const context = buildContinuityContext(baseState(), 2);
  const nullSource = planFor(context.contextHash, {
    informationFlow: [{
      factId: "signal_exists", character: "林澈", knowledgeLevel: "confirmed",
      sourceType: "observed", sourceCharacter: null, evidence: "现场观察",
    }],
  });
  assert.throws(
    () => parseChapterPlan(JSON.stringify(nullSource), 2, context),
    /informationFlow\[0\]\.sourceCharacter/,
  );

  const unknownFact = planFor(context.contextHash, {
    informationFlow: [{
      factId: "mysterious_superior", character: "林澈", knowledgeLevel: "confirmed",
      sourceType: "public", sourceCharacter: "", evidence: "公开广播",
    }],
  });
  assert.throws(
    () => parseChapterPlan(JSON.stringify(unknownFact), 2, context),
    /informationFlow\[0\]\.factId.*未知事实/,
  );

  const unearnedTransfer = planFor(context.contextHash, {
    informationFlow: [{
      factId: "signal_exists", character: "林澈", knowledgeLevel: "confirmed",
      sourceType: "told", sourceCharacter: "神秘上级", evidence: "通讯转述",
    }],
  });
  assert.throws(
    () => parseChapterPlan(JSON.stringify(unearnedTransfer), 2, context),
    /sourceCharacter.*尚不知道/,
  );
});
