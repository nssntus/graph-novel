export function enhancedFoundationResponses(options: {
  totalChapters?: number;
  reviewPassed?: boolean;
  reviewTarget?: string;
} = {}): string[] {
  const totalChapters = options.totalChapters ?? 12;
  const reviewPassed = options.reviewPassed ?? true;
  const reviewTarget = options.reviewTarget ?? "outline_planning";
  return [
    JSON.stringify({
      targetAudience: "喜欢都市科幻悬疑的移动端读者",
      genrePromise: "以可追溯线索推进海上城阴谋",
      coreAppeal: "维修员用工程思维破解城市秘密",
      emotionalPromise: "持续获得发现真相和反制强权的满足",
      themes: ["真相与责任"],
      contentBoundaries: ["关键能力不能无代价升级"],
      successCriteria: ["每个重大揭示都有前置证据"],
    }),
    JSON.stringify({
      era: "近未来", location: "海上城", magicSystem: "潮汐协议",
      technologyLevel: "高科技", socialStructure: "城邦联盟",
      rulesAndLaws: "协议必须由两名见证者确认", history: "海平面上升后建立",
      keyLocations: [{ locationId: "loc_old_port", name: "旧港", roleInStory: "异常信号起点", distinguishingFeatures: "废弃潮汐塔", accessConstraints: "维修权限" }],
      factions: [{ factionId: "faction_city_admin", name: "城务署", goal: "维持秩序", resources: "监控与执法队", relationshipToProtagonist: "先合作后对立" }],
      powerSystem: { systemId: "system_tidal_protocol", source: "潮汐核心", capabilities: "读取协议回声", limitations: "仅在潮位变化时生效", costs: "过度使用造成失忆", progression: "通过修复旧节点扩展权限" },
      rules: [{ ruleId: "rule_dual_witness", statement: "关键协议必须由两名见证者确认", consequence: "单人提交会被系统拒绝并记录" }],
    }),
    JSON.stringify([{
      characterId: "char_lin_che", name: "林澈", role: "protagonist", background: "港口维修员",
      personality: "谨慎执拗", motivation: "查清父亲失踪真相", arcDescription: "从独行到承担责任",
      fear: "自己的调查连累同伴", secrets: [{ secretId: "secret_father_card", content: "私藏父亲的旧权限卡" }],
      strengths: ["工程推理"], weaknesses: ["不信任权威"], abilities: ["修复潮汐节点"],
      voice: "短句、克制、习惯用设备比喻", firstAppearance: "在警报中逆向修复失控闸门",
    }]),
    JSON.stringify({
      relationships: [],
      secrets: [{ secretId: "secret_father_card", holders: ["char_lin_che"], affectedCharacters: ["char_lin_che"], plannedReveal: "终章由城务署档案证实", plannedRevealChapter: totalChapters }],
    }),
    JSON.stringify({
      centralConflict: "林澈追查异常信号并对抗掩盖真相的城务署",
      stakes: "失败将使海上城在下一次大潮中失控",
      endingDirection: "公开协议真相并重建透明治理",
      storyArcs: [{ arcId: "arc_anomaly_echo", name: "异常回声", chapterRange: `1-${totalChapters}`, objective: "定位信号源", opposition: "城务署封锁", turningPoint: "权限卡打开核心档案", outcome: "真相被公开" }],
      characterArcMilestones: [{ characterId: "char_lin_che", startingState: "独自调查", milestones: ["接受同伴协助"], endingState: "承担公共责任" }],
    }),
    JSON.stringify({
      pacingPrinciples: ["每章推进一个可验证线索"],
      payoffSchedule: [{ chapterRange: `1-${totalChapters}`, type: "真相兑现", setup: "异常信号", payoff: "揭露协议来源" }],
      foreshadowingPlan: [{ id: "old_badge", description: "父亲留下的旧徽章", plantChapter: 1, reinforceChapters: [], payoffChapter: totalChapters, payoff: "解锁核心档案" }],
      revelationPlan: [{ factId: "fact_signal_exists", information: "旧港存在异常信号", knownInitiallyBy: [], revealTo: ["char_lin_che"], earliestChapter: 1, method: "亲自监听并保存频段" }],
    }),
    JSON.stringify({
      genre: "都市科幻", premise: "维修员追查海上城秘密", theme: "真相与责任",
      targetLength: `${totalChapters}章`,
      chapterOutlines: Array.from({ length: totalChapters }, (_, index) => ({
        chapterNumber: index + 1,
        title: `第${index + 1}章 潮汐回声`,
        summary: `林澈推进第${index + 1}阶段调查`,
        povCharacter: "林澈",
        povCharacterId: "char_lin_che",
        involvedCharacterIds: ["char_lin_che"],
        locationIds: ["loc_old_port"],
        factionIds: ["faction_city_admin"],
        requiredSystemIds: ["system_tidal_protocol"],
        requiredRuleIds: ["rule_dual_witness"],
        storyArcIds: ["arc_anomaly_echo"],
        chapterGoal: `确认第${index + 1}条线索`,
        conflict: "城务署阻止调查",
        causalPrerequisites: index === 0 ? [] : [`第${index}章留下的线索`],
        keyEvents: ["追踪信号"],
        turningPoint: "发现新的协议记录",
        payoff: "确认一项前置推断",
        chapterHook: "新的频段再次响起",
        foreshadowingToPlant: index === 0 ? ["old_badge"] : [],
        foreshadowingToPayOff: index === totalChapters - 1 ? ["old_badge"] : [],
        revealedSecretIds: index === totalChapters - 1 ? ["secret_father_card"] : [],
        revealedFactIds: index === 0 ? ["fact_signal_exists"] : [],
      })),
    }),
    JSON.stringify({
      pointOfView: "第三人称限知，固定跟随林澈", tense: "过去时", tone: "克制紧张",
      proseStyle: "短段落，以动作和可观察细节推进", dialogueStyle: "对话简洁且各角色有独立措辞",
      pacing: "每章一个调查目标和一次局势变化", chapterOpening: "从正在发生的异常或行动开始",
      chapterEnding: "以新证据或不可逆决定收束", forbiddenPatterns: ["禁止无来源的全知信息"],
    }),
    JSON.stringify({
      storyTime: "第一日清晨", characterLocations: { char_lin_che: "loc_old_port" },
      characterConditions: { char_lin_che: "健康但睡眠不足" }, resources: { char_lin_che: "维修工具和旧权限卡" },
      initialFacts: [{ factId: "fact_father_missing", statement: "林澈的父亲三年前失踪", category: "backstory", visibility: "林澈已知" }],
      initialKnowledge: [{ factId: "fact_father_missing", characterId: "char_lin_che", knowledgeLevel: "confirmed", sourceType: "public", sourceCharacterId: "", evidence: "官方失踪记录" }],
    }),
    JSON.stringify(reviewPassed ? {
      passed: true, score: 92, summary: "文档一致且因果链完整", issues: [], rewriteTargets: [],
    } : {
      passed: false, score: 68, summary: "章节因果仍需补强",
      issues: [{ target: reviewTarget, severity: "major", message: "关键转折缺少前置条件" }],
      rewriteTargets: [reviewTarget],
    }),
  ];
}
