import { createHash } from "node:crypto";
import type { FoundationRewriteTarget } from "./foundation.js";
import type { GraphNovelState } from "./state.js";
import { isRollingOutline, parseChapterRange } from "./rolling-outline.js";

export type FoundationDocumentKey = FoundationRewriteTarget;
export type FoundationDocumentStatus = "current" | "stale";

export interface FoundationRegistryEntry {
  id: string;
  kind: "character" | "location" | "faction" | "power_system" | "world_rule" | "secret" | "story_arc" | "foreshadowing" | "fact";
  owner: FoundationDocumentKey;
  path: string;
  label: string;
}

export interface FoundationDocumentManifest {
  key: FoundationDocumentKey;
  version: number;
  inputHash: string;
  outputHash: string;
  dependsOn: FoundationDocumentKey[];
  status: FoundationDocumentStatus;
}

export interface FoundationRegistry {
  version: 1;
  entries: FoundationRegistryEntry[];
  registryHash: string;
}

export interface FoundationValidationIssue {
  code: string;
  target: FoundationRewriteTarget;
  path: string;
  message: string;
}

export interface FoundationValidationReport {
  passed: boolean;
  summary: string;
  issues: FoundationValidationIssue[];
  registryHash: string;
}

export interface FoundationSnapshot {
  version: number;
  registryHash: string;
  documentHashes: Record<string, string>;
  snapshotHash: string;
  approvedAt: string;
}

export const FOUNDATION_DOCUMENT_ORDER: FoundationDocumentKey[] = [
  "creative_charter", "world_building", "character_design", "relationship_design",
  "story_architecture", "narrative_planning", "outline_planning", "style_design",
  "continuity_baseline",
];

const FOUNDATION_DEPENDENCIES: Record<FoundationDocumentKey, FoundationDocumentKey[]> = {
  creative_charter: [],
  world_building: ["creative_charter"],
  character_design: ["creative_charter", "world_building"],
  relationship_design: ["character_design"],
  story_architecture: ["creative_charter", "world_building", "character_design", "relationship_design"],
  narrative_planning: ["story_architecture", "relationship_design"],
  outline_planning: ["story_architecture", "narrative_planning"],
  style_design: ["creative_charter", "character_design", "outline_planning"],
  continuity_baseline: ["world_building", "character_design", "relationship_design", "outline_planning"],
};

export function recordFoundationDocument(
  state: GraphNovelState,
  key: FoundationDocumentKey,
  input: unknown,
  output: unknown,
): void {
  const existing = state.foundationDocuments[key];
  state.foundationDocuments[key] = {
    key,
    version: (existing?.version ?? 0) + 1,
    inputHash: stableHash(input),
    outputHash: stableHash(output),
    dependsOn: [...FOUNDATION_DEPENDENCIES[key]],
    status: "current",
  };
  const index = FOUNDATION_DOCUMENT_ORDER.indexOf(key);
  for (const downstream of FOUNDATION_DOCUMENT_ORDER.slice(index + 1)) {
    const manifest = state.foundationDocuments[downstream];
    if (manifest) manifest.status = "stale";
  }
  state.foundationRegistry = buildFoundationRegistry(state);
  if (state.foundationValidation?.passed !== false) state.foundationValidation = null;
  state.foundationSnapshot = null;
}

export function buildFoundationRegistry(state: GraphNovelState): FoundationRegistry {
  const entries: FoundationRegistryEntry[] = [];
  const add = (id: unknown, kind: FoundationRegistryEntry["kind"], owner: FoundationDocumentKey, path: string, label: unknown) => {
    if (typeof id === "string" && id.trim()) entries.push({ id: id.trim(), kind, owner, path, label: String(label || id).trim() });
  };
  state.worldSetting?.keyLocations?.forEach((item, index) => add(item.locationId, "location", "world_building", `worldSetting.keyLocations[${index}]`, item.name));
  state.worldSetting?.factions?.forEach((item, index) => add(item.factionId, "faction", "world_building", `worldSetting.factions[${index}]`, item.name));
  if (state.worldSetting?.powerSystem) add(state.worldSetting.powerSystem.systemId, "power_system", "world_building", "worldSetting.powerSystem", state.worldSetting.magicSystem);
  state.worldSetting?.rules?.forEach((item, index) => add(item.ruleId, "world_rule", "world_building", `worldSetting.rules[${index}]`, item.statement));
  state.characters.forEach((item, index) => {
    add(item.characterId, "character", "character_design", `characters[${index}]`, item.name);
    item.secrets?.forEach((secret, secretIndex) => add(secret.secretId, "secret", "character_design", `characters[${index}].secrets[${secretIndex}]`, secret.content));
  });
  state.storyArchitecture?.storyArcs.forEach((item, index) => add(item.arcId, "story_arc", "story_architecture", `storyArchitecture.storyArcs[${index}]`, item.name));
  state.narrativePlan?.foreshadowingPlan.forEach((item, index) => add(item.id, "foreshadowing", "narrative_planning", `narrativePlan.foreshadowingPlan[${index}]`, item.description));
  state.narrativePlan?.revelationPlan.forEach((item, index) => add(item.factId, "fact", "narrative_planning", `narrativePlan.revelationPlan[${index}]`, item.information));
  state.continuityBaseline?.initialFacts.forEach((item, index) => add(item.factId, "fact", "continuity_baseline", `continuityBaseline.initialFacts[${index}]`, item.statement));
  entries.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  return { version: 1, entries, registryHash: stableHash(entries) };
}

export function validateFoundationRegistry(state: GraphNovelState): FoundationValidationReport {
  const registry = buildFoundationRegistry(state);
  state.foundationRegistry = registry;
  const issues: FoundationValidationIssue[] = [];
  const establishedFactIds = new Set(state.narrativeFacts.map((fact) => fact.factId));
  const byId = new Map<string, FoundationRegistryEntry>();
  for (const entry of registry.entries) {
    const existing = byId.get(entry.id);
    if (existing) issue(issues, "duplicate_id", entry.owner, entry.path, `ID ${entry.id} 已由 ${existing.path} 定义`);
    else byId.set(entry.id, entry);
  }
  for (const key of FOUNDATION_DOCUMENT_ORDER) {
    const manifest = state.foundationDocuments[key];
    if (!manifest) issue(issues, "missing_document", key, `foundationDocuments.${key}`, "缺少文档清单");
    else if (manifest.status !== "current") issue(issues, "stale_document", key, `foundationDocuments.${key}`, "上游已修改，文档需要重新生成");
    else if (manifest.outputHash !== stableHash(foundationDocumentValue(state, key))) issue(issues, "document_hash_mismatch", key, `foundationDocuments.${key}`, "文档内容已改变但依赖清单尚未更新");
  }

  const expect = (id: unknown, kind: FoundationRegistryEntry["kind"], target: FoundationRewriteTarget, path: string, allowEmpty = false) => {
    if (allowEmpty && (!id || id === "")) return;
    if (typeof id !== "string" || !id.trim()) return issue(issues, "missing_reference", target, path, `必须引用 ${kind} ID`);
    if (kind === "fact" && establishedFactIds.has(id)) return;
    const entry = byId.get(id);
    if (!entry || entry.kind !== kind) issue(issues, "unknown_reference", target, path, `引用的 ${kind} ID ${id} 不存在`);
  };
  state.characters.forEach((item, index) => {
    if (item.secret?.trim()) {
      issue(issues, "duplicate_secret_source", "character_design", `characters[${index}].secret`, "旧 secret 字段会形成第二事实来源；秘密内容只能写入 secrets[].content");
    }
  });
  state.relationshipMap?.relationships.forEach((item, index) => {
    expect(item.fromCharacterId, "character", "relationship_design", `relationshipMap.relationships[${index}].fromCharacterId`);
    expect(item.toCharacterId, "character", "relationship_design", `relationshipMap.relationships[${index}].toCharacterId`);
  });
  const secretSchedules = new Map<string, number>();
  state.relationshipMap?.secrets.forEach((item, index) => {
    const path = `relationshipMap.secrets[${index}]`;
    expect(item.secretId, "secret", "relationship_design", `relationshipMap.secrets[${index}].secretId`);
    item.holders.forEach((id, child) => expect(id, "character", "relationship_design", `relationshipMap.secrets[${index}].holders[${child}]`));
    item.affectedCharacters.forEach((id, child) => expect(id, "character", "relationship_design", `relationshipMap.secrets[${index}].affectedCharacters[${child}]`));
    if (item.content?.trim()) issue(issues, "duplicate_secret_source", "relationship_design", `${path}.content`, "关系文档只能引用 secretId，秘密内容由角色设定集唯一维护");
    const occurrences = (secretSchedules.get(item.secretId) ?? 0) + 1;
    secretSchedules.set(item.secretId, occurrences);
    if (occurrences > 1) issue(issues, "duplicate_secret_schedule", "relationship_design", `${path}.secretId`, `${item.secretId} 存在重复揭示计划`);
    if (item.plannedRevealChapter && item.plannedRevealChapter > state.targetTotalChapters) {
      issue(issues, "secret_reveal_out_of_range", "relationship_design", `${path}.plannedRevealChapter`, `计划章节 ${item.plannedRevealChapter} 超出全书 ${state.targetTotalChapters} 章范围`);
    }
  });
  registry.entries.filter((entry) => entry.kind === "secret").forEach((entry) => {
    if (!secretSchedules.has(entry.id)) issue(issues, "missing_secret_schedule", "relationship_design", "relationshipMap.secrets", `角色秘密 ${entry.id} 缺少持有者与揭示计划`);
  });
  const revelationFacts = new Map((state.narrativePlan?.revelationPlan ?? []).map((item) => [item.factId, item]));
  state.relationshipMap?.secrets.forEach((secret, index) => {
    const baseId = secret.secretId.startsWith("secret_") ? secret.secretId.slice("secret_".length) : secret.secretId;
    const relatedFact = revelationFacts.get(`fact_${secret.secretId}`) ?? revelationFacts.get(`fact_${baseId}`);
    if (relatedFact && relatedFact.earliestChapter !== secret.plannedRevealChapter) {
      issue(
        issues,
        "secret_fact_reveal_mismatch",
        "relationship_design",
        `relationshipMap.secrets[${index}].plannedRevealChapter`,
        `${secret.secretId} 计划在第 ${secret.plannedRevealChapter} 章揭示，但对应事实 ${relatedFact.factId} 计划在第 ${relatedFact.earliestChapter} 章揭示`,
      );
    }
  });
  if (state.styleGuide?.characterVoices?.length) {
    issue(issues, "duplicate_character_voice_source", "style_design", "styleGuide.characterVoices", "人物声音只能由角色设定集的 voice 字段维护，文风文档只负责全局叙事规范");
  }
  state.storyArchitecture?.characterArcMilestones.forEach((item, index) => expect(item.characterId, "character", "story_architecture", `storyArchitecture.characterArcMilestones[${index}].characterId`));
  state.narrativePlan?.revelationPlan.forEach((item, index) => {
    item.knownInitiallyBy.forEach((id, child) => expect(id, "character", "narrative_planning", `narrativePlan.revelationPlan[${index}].knownInitiallyBy[${child}]`));
    item.revealTo.forEach((id, child) => expect(id, "character", "narrative_planning", `narrativePlan.revelationPlan[${index}].revealTo[${child}]`));
    if (item.earliestChapter > state.targetTotalChapters) issue(issues, "fact_reveal_out_of_range", "narrative_planning", `narrativePlan.revelationPlan[${index}].earliestChapter`, `最早揭示章节 ${item.earliestChapter} 超出全书 ${state.targetTotalChapters} 章范围`);
  });
  state.narrativePlan?.foreshadowingPlan.forEach((item, index) => {
    const path = `narrativePlan.foreshadowingPlan[${index}]`;
    if (item.plantChapter > state.targetTotalChapters) issue(issues, "foreshadowing_plant_out_of_range", "narrative_planning", `${path}.plantChapter`, `埋设章节 ${item.plantChapter} 超出全书范围`);
    if (item.payoffChapter > state.targetTotalChapters) issue(issues, "foreshadowing_payoff_out_of_range", "narrative_planning", `${path}.payoffChapter`, `回收章节 ${item.payoffChapter} 超出全书范围`);
    if (item.payoffChapter <= item.plantChapter) issue(issues, "foreshadowing_order", "narrative_planning", `${path}.payoffChapter`, "伏笔回收章节必须晚于埋设章节");
    item.reinforceChapters.forEach((chapter, child) => {
      if (chapter <= item.plantChapter || chapter >= item.payoffChapter || chapter > state.targetTotalChapters) {
        issue(issues, "foreshadowing_reinforce_order", "narrative_planning", `${path}.reinforceChapters[${child}]`, "强化章节必须位于埋设与回收章节之间且不超出全书范围");
      }
    });
  });

  const facts = new Map((state.narrativePlan?.revelationPlan ?? []).map((item) => [item.factId, item]));
  if (isRollingOutline(state.novelOutline)) {
    const segments = [...(state.novelOutline?.roadmapSegments ?? [])]
      .sort((left, right) => left.chapterStart - right.chapterStart);
    let expectedStart = 1;
    if (segments.length === 0) {
      issue(issues, "roadmap_empty", "story_architecture", "storyArchitecture.storyArcs", "长篇路线图至少需要一个故事阶段");
    }
    segments.forEach((segment, index) => {
      const path = `novelOutline.roadmapSegments[${index}]`;
      if (segment.chapterStart !== expectedStart) {
        issue(issues, "roadmap_gap", "story_architecture", `${path}.chapterStart`, `故事阶段必须连续覆盖；期望从第 ${expectedStart} 章开始，实际从第 ${segment.chapterStart} 章开始`);
      }
      if (segment.chapterEnd < segment.chapterStart || segment.chapterEnd > state.targetTotalChapters) {
        issue(issues, "roadmap_range", "story_architecture", `${path}.chapterEnd`, `故事阶段范围 ${segment.chapterStart}-${segment.chapterEnd} 无效或超出全书范围`);
      }
      segment.storyArcIds.forEach((id, child) => expect(id, "story_arc", "story_architecture", `${path}.storyArcIds[${child}]`));
      expectedStart = segment.chapterEnd + 1;
    });
    if (segments.length > 0 && expectedStart !== state.targetTotalChapters + 1) {
      issue(issues, "roadmap_coverage", "story_architecture", "novelOutline.roadmapSegments", `故事阶段只覆盖到第 ${expectedStart - 1} 章，目标为 ${state.targetTotalChapters} 章`);
    }
    state.narrativePlan?.payoffSchedule.forEach((item, index) => {
      const range = parseChapterRange(item.chapterRange);
      if (!range || range.end > state.targetTotalChapters) {
        issue(issues, "payoff_range", "narrative_planning", `narrativePlan.payoffSchedule[${index}].chapterRange`, `兑现阶段范围 ${item.chapterRange} 无效或超出全书范围`);
      }
    });
  } else {
    const chapters = state.novelOutline?.chapterOutlines ?? [];
    if (chapters.length !== state.targetTotalChapters) issue(issues, "chapter_count", "outline_planning", "novelOutline.chapterOutlines", `期望 ${state.targetTotalChapters} 章，实际 ${chapters.length} 章`);
    const secrets = new Map((state.relationshipMap?.secrets ?? []).map((item) => [item.secretId, item]));
    const establishedFacts = new Map(state.narrativeFacts.map((item) => [item.factId, item]));
    const foreshadowings = new Map((state.narrativePlan?.foreshadowingPlan ?? []).map((item) => [item.id, item]));
    const secretRevealChapters = new Map<string, number[]>();
    const foreshadowingPlantChapters = new Map<string, number[]>();
    const foreshadowingPayoffChapters = new Map<string, number[]>();
    chapters.forEach((chapter, index) => {
    const path = `novelOutline.chapterOutlines[${index}]`;
    if (chapter.chapterNumber !== index + 1) issue(issues, "chapter_sequence", "outline_planning", `${path}.chapterNumber`, `期望 ${index + 1}，实际 ${chapter.chapterNumber}`);
    expect(chapter.povCharacterId, "character", "outline_planning", `${path}.povCharacterId`);
    chapter.involvedCharacterIds?.forEach((id, child) => expect(id, "character", "outline_planning", `${path}.involvedCharacterIds[${child}]`));
    chapter.locationIds?.forEach((id, child) => expect(id, "location", "outline_planning", `${path}.locationIds[${child}]`));
    chapter.factionIds?.forEach((id, child) => expect(id, "faction", "outline_planning", `${path}.factionIds[${child}]`));
    chapter.requiredSystemIds?.forEach((id, child) => expect(id, "power_system", "outline_planning", `${path}.requiredSystemIds[${child}]`));
    chapter.requiredRuleIds?.forEach((id, child) => expect(id, "world_rule", "outline_planning", `${path}.requiredRuleIds[${child}]`));
    chapter.storyArcIds?.forEach((id, child) => expect(id, "story_arc", "outline_planning", `${path}.storyArcIds[${child}]`));
    chapter.causalPrerequisites?.forEach((prerequisite, child) => {
      if (!/^(?:fact_|ch\d+_fact_)/.test(prerequisite)) return;
      const established = establishedFacts.get(prerequisite);
      const planned = facts.get(prerequisite);
      if (!established && !planned) {
        issue(issues, "unknown_causal_fact", "outline_planning", `${path}.causalPrerequisites[${child}]`, `因果前提引用的事实 ID ${prerequisite} 不存在；未来条件必须写成具体自然语言`);
      } else if (established && established.establishedInChapter >= chapter.chapterNumber) {
        issue(issues, "causal_fact_not_established", "outline_planning", `${path}.causalPrerequisites[${child}]`, `${prerequisite} 在第 ${established.establishedInChapter} 章才成立，不能作为第 ${chapter.chapterNumber} 章的前提`);
      } else if (planned && planned.earliestChapter >= chapter.chapterNumber) {
        issue(issues, "causal_fact_not_established", "outline_planning", `${path}.causalPrerequisites[${child}]`, `${prerequisite} 最早在第 ${planned.earliestChapter} 章揭示，不能作为第 ${chapter.chapterNumber} 章的前提`);
      }
    });
    chapter.revealedSecretIds?.forEach((id, child) => {
      expect(id, "secret", "outline_planning", `${path}.revealedSecretIds[${child}]`);
      secretRevealChapters.set(id, [...(secretRevealChapters.get(id) ?? []), chapter.chapterNumber]);
      const secret = secrets.get(id);
      if (secret?.plannedRevealChapter && chapter.chapterNumber !== secret.plannedRevealChapter) issue(issues, "secret_reveal_mismatch", "outline_planning", `${path}.revealedSecretIds[${child}]`, `${id} 计划在第 ${secret.plannedRevealChapter} 章揭示`);
    });
    chapter.revealedFactIds?.forEach((id, child) => {
      expect(id, "fact", "outline_planning", `${path}.revealedFactIds[${child}]`);
      const fact = facts.get(id);
      if (fact && chapter.chapterNumber < fact.earliestChapter) issue(issues, "fact_revealed_early", "outline_planning", `${path}.revealedFactIds[${child}]`, `${id} 最早在第 ${fact.earliestChapter} 章揭示`);
    });
    chapter.foreshadowingToPlant.forEach((id, child) => {
      expect(id, "foreshadowing", "outline_planning", `${path}.foreshadowingToPlant[${child}]`);
      foreshadowingPlantChapters.set(id, [...(foreshadowingPlantChapters.get(id) ?? []), chapter.chapterNumber]);
      const plan = foreshadowings.get(id);
      if (plan && plan.plantChapter !== chapter.chapterNumber) issue(issues, "foreshadowing_plant_mismatch", "outline_planning", `${path}.foreshadowingToPlant[${child}]`, `${id} 计划在第 ${plan.plantChapter} 章埋设`);
    });
    chapter.foreshadowingToPayOff.forEach((id, child) => {
      expect(id, "foreshadowing", "outline_planning", `${path}.foreshadowingToPayOff[${child}]`);
      foreshadowingPayoffChapters.set(id, [...(foreshadowingPayoffChapters.get(id) ?? []), chapter.chapterNumber]);
      const plan = foreshadowings.get(id);
      if (plan && plan.payoffChapter !== chapter.chapterNumber) issue(issues, "foreshadowing_payoff_mismatch", "outline_planning", `${path}.foreshadowingToPayOff[${child}]`, `${id} 计划在第 ${plan.payoffChapter} 章回收`);
    });
    });
    secrets.forEach((secret, id) => {
      const revealChapters = secretRevealChapters.get(id) ?? [];
      if (revealChapters.length === 0) issue(issues, "missing_secret_reveal", "outline_planning", "novelOutline.chapterOutlines", `${id} 的揭示计划没有落实到任何章节`);
      if (revealChapters.length > 1) issue(issues, "duplicate_secret_reveal", "outline_planning", "novelOutline.chapterOutlines", `${id} 被多个章节重复标记为首次揭示`);
    });
    foreshadowings.forEach((plan, id) => {
      const plantChapters = foreshadowingPlantChapters.get(id) ?? [];
      const payoffChapters = foreshadowingPayoffChapters.get(id) ?? [];
      if (plantChapters.length !== 1 || plantChapters[0] !== plan.plantChapter) issue(issues, "foreshadowing_plant_missing", "outline_planning", "novelOutline.chapterOutlines", `${id} 必须且只能在第 ${plan.plantChapter} 章埋设一次`);
      if (payoffChapters.length !== 1 || payoffChapters[0] !== plan.payoffChapter) issue(issues, "foreshadowing_payoff_missing", "outline_planning", "novelOutline.chapterOutlines", `${id} 必须且只能在第 ${plan.payoffChapter} 章回收一次`);
    });
  }
  const baseline = state.continuityBaseline;
  if (baseline) {
    Object.entries(baseline.characterLocations).forEach(([characterId, locationId]) => {
      expect(characterId, "character", "continuity_baseline", `continuityBaseline.characterLocations.${characterId}`);
      expect(locationId, "location", "continuity_baseline", `continuityBaseline.characterLocations.${characterId}`);
    });
    Object.keys(baseline.characterConditions).forEach((id) => expect(id, "character", "continuity_baseline", `continuityBaseline.characterConditions.${id}`));
    Object.keys(baseline.resources).forEach((id) => expect(id, "character", "continuity_baseline", `continuityBaseline.resources.${id}`));
    baseline.initialKnowledge.forEach((item, index) => {
      expect(item.factId, "fact", "continuity_baseline", `continuityBaseline.initialKnowledge[${index}].factId`);
      expect(item.characterId, "character", "continuity_baseline", `continuityBaseline.initialKnowledge[${index}].characterId`);
      expect(item.sourceCharacterId, "character", "continuity_baseline", `continuityBaseline.initialKnowledge[${index}].sourceCharacterId`, item.sourceType !== "told");
    });
    const initialKnowledge = new Set(baseline.initialKnowledge.map((item) => `${item.factId}\u0000${item.characterId ?? ""}`));
    state.narrativePlan?.revelationPlan.forEach((item, index) => {
      item.knownInitiallyBy.forEach((characterId, child) => {
        if (!initialKnowledge.has(`${item.factId}\u0000${characterId}`)) {
          issue(issues, "initial_knowledge_missing", "continuity_baseline", "continuityBaseline.initialKnowledge", `${item.factId} 的初始知情角色 ${characterId} 缺少认知基线记录（来源：revelationPlan[${index}].knownInitiallyBy[${child}]）`);
        }
      });
    });
    baseline.initialKnowledge.forEach((item, index) => {
      const revelation = facts.get(item.factId);
      if (revelation && item.characterId && !revelation.knownInitiallyBy.includes(item.characterId)) {
        issue(issues, "initial_knowledge_mismatch", "continuity_baseline", `continuityBaseline.initialKnowledge[${index}].characterId`, `${item.characterId} 的初始认知未在 ${item.factId} 的 knownInitiallyBy 中声明`);
      }
    });
  }
  const report = {
    passed: issues.length === 0,
    summary: issues.length === 0 ? "Foundation Registry 引用与时间约束全部通过" : `发现 ${issues.length} 个确定性一致性问题`,
    issues,
    registryHash: registry.registryHash,
  };
  state.foundationValidation = report;
  return report;
}

export function createFoundationSnapshot(state: GraphNovelState, now = new Date().toISOString()): FoundationSnapshot {
  if (!state.foundationValidation?.passed || !state.foundationReview?.passed || !state.foundationRegistry) {
    throw new Error("Cannot snapshot an unvalidated Foundation");
  }
  const documentHashes = Object.fromEntries(FOUNDATION_DOCUMENT_ORDER.map((key) => {
    const manifest = state.foundationDocuments[key];
    if (!manifest || manifest.status !== "current") throw new Error(`Cannot snapshot stale Foundation document: ${key}`);
    return [key, manifest.outputHash];
  }));
  const version = (state.foundationSnapshot?.version ?? 0) + 1;
  const payload = { version, registryHash: state.foundationRegistry.registryHash, documentHashes, approvedAt: now };
  return { ...payload, snapshotHash: stableHash(payload) };
}

export function assertFoundationSnapshotCurrent(state: GraphNovelState): void {
  const snapshot = state.foundationSnapshot;
  if (!snapshot) return;
  const registry = buildFoundationRegistry(state);
  if (registry.registryHash !== snapshot.registryHash) {
    throw new Error("Approved Foundation Registry has changed; revalidation and approval are required");
  }
  for (const key of FOUNDATION_DOCUMENT_ORDER) {
    if (stableHash(foundationDocumentValue(state, key)) !== snapshot.documentHashes[key]) {
      throw new Error(`Approved Foundation document has changed: ${key}`);
    }
  }
  const payload = {
    version: snapshot.version,
    registryHash: snapshot.registryHash,
    documentHashes: snapshot.documentHashes,
    approvedAt: snapshot.approvedAt,
  };
  if (stableHash(payload) !== snapshot.snapshotHash) {
    throw new Error("Approved Foundation snapshot hash is invalid");
  }
}

function issue(issues: FoundationValidationIssue[], code: string, target: FoundationRewriteTarget, path: string, message: string): void {
  issues.push({ code, target, path, message });
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

function foundationDocumentValue(state: GraphNovelState, key: FoundationDocumentKey): unknown {
  if (key === "creative_charter") return state.creativeCharter;
  if (key === "world_building") return state.worldSetting;
  if (key === "character_design") return state.characters;
  if (key === "relationship_design") return state.relationshipMap;
  if (key === "story_architecture") return state.storyArchitecture;
  if (key === "narrative_planning") return state.narrativePlan;
  if (key === "outline_planning") return state.novelOutline;
  if (key === "style_design") return state.styleGuide;
  return state.continuityBaseline;
}
