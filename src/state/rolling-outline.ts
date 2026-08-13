import type {
  ChapterOutline,
  NarrativePlan,
  NovelOutline,
  PayoffScheduleItem,
  StoryArc,
  StoryRoadmapSegment,
} from "./foundation.js";
import type { GraphNovelState } from "./state.js";

export interface ChapterRange {
  start: number;
  end: number;
}

export function isRollingOutline(outline: NovelOutline | null): boolean {
  return outline?.planningMode === "rolling";
}

export function parseChapterRange(value: string): ChapterRange | null {
  const numbers = value.match(/\d+/g)?.map(Number) ?? [];
  if (numbers.length === 0) return null;
  const start = numbers[0]!;
  const end = numbers[1] ?? start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

export function buildRollingNovelOutline(state: GraphNovelState): NovelOutline {
  const total = state.targetTotalChapters;
  const arcs = state.storyArchitecture?.storyArcs ?? [];
  const payoffSchedule = state.narrativePlan?.payoffSchedule ?? [];
  const roadmapSegments = arcs.map((arc, index) => buildRoadmapSegment(arc, index, payoffSchedule, total));
  return {
    genre: state.creativeGenre,
    premise: state.creativePremise,
    theme: state.creativeTheme,
    targetLength: `${total}章`,
    planningMode: "rolling",
    roadmapSegments,
    chapterOutlines: [],
  };
}

export function buildRollingNarrativePlan(state: GraphNovelState): NarrativePlan {
  const arcs = state.storyArchitecture?.storyArcs ?? [];
  const secrets = state.relationshipMap?.secrets ?? [];
  const characters = state.characters.map((character) => character.characterId).filter((id): id is string => Boolean(id));
  const secretContents = new Map(
    state.characters.flatMap((character) => character.secrets ?? [])
      .map((secret) => [secret.secretId, secret.content]),
  );
  return {
    pacingPrinciples: [
      "每章必须产生可验证的状态变化，并承接已批准章节留下的行动与信息",
      "阶段转折只在所属故事阶段后段兑现，前段负责目标、阻力与证据铺垫",
      "秘密、事实和伏笔严格按照确定性排期执行，不得提前揭示或重复首次揭示",
      ...arcs.map((arc) => `${arc.chapterRange}「${arc.name}」：围绕“${arc.objective}”逐步升级“${arc.opposition}”带来的压力`),
    ],
    payoffSchedule: arcs.map((arc) => ({
      chapterRange: arc.chapterRange,
      type: "故事阶段兑现",
      setup: `${arc.objective}；主要阻力：${arc.opposition}`,
      payoff: arc.outcome,
    })),
    foreshadowingPlan: secrets.flatMap((secret) => {
      const payoffChapter = secret.plannedRevealChapter;
      if (!payoffChapter || payoffChapter <= 1) return [];
      const plantChapter = Math.max(1, payoffChapter - Math.max(2, Math.ceil(state.targetTotalChapters * 0.03)));
      const midpoint = plantChapter + Math.floor((payoffChapter - plantChapter) / 2);
      const information = secretContents.get(secret.secretId) ?? secret.plannedReveal;
      return [{
        id: `foreshadow_${secret.secretId}`,
        description: `围绕“${information}”留下可追溯但不提前揭底的线索`,
        plantChapter,
        reinforceChapters: midpoint > plantChapter && midpoint < payoffChapter ? [midpoint] : [],
        payoffChapter,
        payoff: secret.plannedReveal,
      }];
    }),
    revelationPlan: secrets.map((secret) => {
      const holders = unique(secret.holders);
      const outsideRecipients = unique(secret.affectedCharacters.filter((id) => !holders.includes(id)));
      const revealTo = outsideRecipients.length > 0
        ? outsideRecipients
        : unique([...secret.affectedCharacters, ...characters]).slice(0, 1);
      return {
        factId: `fact_${secret.secretId}`,
        information: secretContents.get(secret.secretId) ?? secret.plannedReveal,
        knownInitiallyBy: holders,
        revealTo: revealTo.length > 0 ? revealTo : holders,
        earliestChapter: secret.plannedRevealChapter ?? state.targetTotalChapters,
        method: secret.plannedReveal,
      };
    }),
  };
}

export function buildRollingChapterOutline(
  state: GraphNovelState,
  chapterNumber: number,
): ChapterOutline | null {
  if (!isRollingOutline(state.novelOutline)) return null;
  const segment = state.novelOutline?.roadmapSegments?.find(
    (item) => chapterNumber >= item.chapterStart && chapterNumber <= item.chapterEnd,
  );
  if (!segment) return null;

  const exactSecrets = (state.relationshipMap?.secrets ?? []).filter(
    (item) => item.plannedRevealChapter === chapterNumber,
  );
  const exactFacts = (state.narrativePlan?.revelationPlan ?? []).filter(
    (item) => item.earliestChapter === chapterNumber,
  );
  const plants = (state.narrativePlan?.foreshadowingPlan ?? []).filter(
    (item) => item.plantChapter === chapterNumber,
  );
  const reinforcements = (state.narrativePlan?.foreshadowingPlan ?? []).filter(
    (item) => item.reinforceChapters.includes(chapterNumber),
  );
  const payoffs = (state.narrativePlan?.foreshadowingPlan ?? []).filter(
    (item) => item.payoffChapter === chapterNumber,
  );
  const protagonist = state.characters.find((item) => /protagonist|主角/i.test(item.role)) ?? state.characters[0];
  const location = resolveCurrentLocationId(state, protagonist?.characterId, protagonist?.name);
  const phase = phaseInstruction(segment, chapterNumber);
  const involvedCharacterIds = unique([
    protagonist?.characterId,
    ...(state.storyArchitecture?.characterArcMilestones ?? []).map((item) => item.characterId),
    ...exactSecrets.flatMap((item) => [...item.holders, ...item.affectedCharacters]),
    ...exactFacts.flatMap((item) => [...item.knownInitiallyBy, ...item.revealTo]),
  ]);
  const keyEvents = [
    phase,
    ...(reinforcements.length ? [`强化伏笔：${reinforcements.map((item) => item.description).join("；")}`] : []),
    ...(exactFacts.length ? [`以可追溯方式揭示：${exactFacts.map((item) => item.information).join("；")}`] : []),
  ];
  const activePayoff = payoffAtChapter(state.narrativePlan?.payoffSchedule ?? [], chapterNumber);
  return {
    chapterNumber,
    title: `第${chapterNumber}章 · ${segment.name}`,
    summary: `在“${segment.name}”阶段执行“${phase}”，应对“${segment.opposition}”，并让局势朝“${segment.outcome}”产生可验证变化。`,
    keyEvents,
    foreshadowingToPlant: plants.map((item) => item.id),
    foreshadowingToReinforce: reinforcements.map((item) => item.id),
    foreshadowingToPayOff: payoffs.map((item) => item.id),
    povCharacter: protagonist?.name ?? "主视角角色",
    povCharacterId: protagonist?.characterId,
    chapterGoal: phase,
    conflict: segment.opposition,
    causalPrerequisites: [],
    turningPoint: segment.turningPoint,
    payoff: activePayoff?.payoff ?? segment.outcome,
    chapterHook: `把局势推向“${segment.turningPoint}”或下一项阶段义务。`,
    involvedCharacterIds,
    locationIds: unique([location]),
    factionIds: [],
    requiredSystemIds: [],
    requiredRuleIds: (state.worldSetting?.rules ?? []).map((item) => item.ruleId),
    storyArcIds: [...segment.storyArcIds],
    revealedSecretIds: exactSecrets.map((item) => item.secretId),
    revealedFactIds: exactFacts.map((item) => item.factId),
  };
}

function phaseInstruction(segment: StoryRoadmapSegment, chapterNumber: number): string {
  const length = Math.max(1, segment.chapterEnd - segment.chapterStart + 1);
  const progress = (chapterNumber - segment.chapterStart + 1) / length;
  if (progress <= 0.2) return `建立“${segment.objective}”的具体目标、阻力与可验证前置条件`;
  if (progress <= 0.55) return `扩大“${segment.opposition}”造成的压力，并用行动推进“${segment.objective}”`;
  if (progress <= 0.85) return `逼近“${segment.turningPoint}”，收束必要条件但不得提前兑现阶段结果`;
  return `完成通往“${segment.outcome}”的阶段转折，并为下一故事段留下可承接状态`;
}

function buildRoadmapSegment(
  arc: StoryArc,
  index: number,
  payoffSchedule: PayoffScheduleItem[],
  total: number,
): StoryRoadmapSegment {
  const range = parseChapterRange(arc.chapterRange) ?? fallbackRange(index, total);
  const payoffs = payoffSchedule
    .filter((item) => rangesOverlap(range, parseChapterRange(item.chapterRange)))
    .map((item) => `${item.type}：${item.payoff}`);
  return {
    segmentId: arc.arcId ?? `roadmap_segment_${index + 1}`,
    chapterStart: range.start,
    chapterEnd: range.end,
    storyArcIds: arc.arcId ? [arc.arcId] : [],
    name: arc.name,
    objective: arc.objective,
    opposition: arc.opposition,
    turningPoint: arc.turningPoint,
    outcome: arc.outcome,
    payoffTargets: payoffs,
  };
}

function fallbackRange(index: number, total: number): ChapterRange {
  return index === 0 ? { start: 1, end: total } : { start: total + 1, end: total + 1 };
}

function payoffAtChapter(items: PayoffScheduleItem[], chapterNumber: number): PayoffScheduleItem | undefined {
  return items.find((item) => {
    const range = parseChapterRange(item.chapterRange);
    return range?.end === chapterNumber;
  });
}

function rangesOverlap(left: ChapterRange, right: ChapterRange | null): boolean {
  return Boolean(right && left.start <= right.end && right.start <= left.end);
}

function resolveCurrentLocationId(
  state: GraphNovelState,
  characterId: string | undefined,
  characterName: string | undefined,
): string | undefined {
  const locations = state.worldSetting?.keyLocations ?? [];
  const current = (characterId && state.continuity.characterLocations[characterId])
    || (characterName && state.continuity.characterLocations[characterName]);
  const matched = locations.find((item) => item.locationId === current || item.name === current);
  return matched?.locationId ?? locations[0]?.locationId;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
