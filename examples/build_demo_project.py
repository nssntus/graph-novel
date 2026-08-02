"""Build the public GraphNovel demo project without calling an LLM."""

import sys
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from graph_novel.state import (
    ApprovalStatus,
    ArcStage,
    Chapter,
    ChapterOutline,
    Character,
    CharacterArc,
    Foreshadowing,
    GraphNovelState,
    KnowledgeRecord,
    NarrativeFact,
    NodeStatus,
    NovelOutline,
    WorldSetting,
)


PROJECT_ID = "xunhuan-zhi-wai"
PROJECT_DIR = Path(__file__).resolve().parent / PROJECT_ID


def _outline(
    number: int,
    title: str,
    summary: str,
    events: List[str],
    hook: str,
    beat: str,
) -> ChapterOutline:
    return ChapterOutline(
        chapter_number=number,
        title=title,
        summary=summary,
        pov_character="林夏",
        key_events=events,
        foreshadowing_to_plant=["失踪的第七码"] if number == 1 else [],
        foreshadowing_to_pay_off=["失踪的第七码"] if number == 5 else [],
        shuangdian_beat=beat,
        chapter_hook_idea=hook,
    )


def _chapter(
    outline: ChapterOutline,
    body: str,
    hook: str,
    facts: List[Dict[str, Any]],
    knowledge: List[Dict[str, Any]],
    time_label: str,
    location: str,
) -> Chapter:
    number = outline.chapter_number
    return Chapter(
        chapter_number=number,
        title=outline.title,
        outline=outline,
        plan={
            "chapter_goal": outline.summary,
            "causal_chain": [
                "承接上一章已批准事实",
                "通过现场行动取得新证据",
                "以可验证的新信息推动下一章",
            ],
            "required_fact_ids": [fact["id"] for fact in facts[:-1]],
            "planned_facts": facts,
            "information_flow": knowledge,
            "opening_bridge": "从上一章结尾的直接后果切入。",
        },
        draft=body,
        consistency_report={
            "overall_score": 9,
            "issues": [],
            "continuity_passed": True,
            "summary": "人物认知、时间线和因果链均与已批准状态一致。",
        },
        polished_draft=body,
        approval=ApprovalStatus.APPROVED,
        human_feedback="保留克制的悬疑感，避免提前解释循环原理。",
        word_count=len(body.replace("\n", "")),
        chapter_hook=hook,
        shuangdian_type=outline.shuangdian_beat,
        generation_meta={
            "context_mode": "previous_chapter_plus_narrative_state",
            "contract_validated": True,
        },
        narrative_delta={
            "chapter_summary": outline.summary,
            "facts_established": facts,
            "knowledge_changes": knowledge,
            "continuity_changes": {
                "time": time_label,
                "character_locations": {"林夏": location},
                "character_conditions": {"林夏": "清醒，轻度疲惫"},
                "resources": {"倒计时余量": max(0, 72 - number * 12)},
            },
        },
        continuity_checkpoint={
            "time": time_label,
            "location": location,
            "open_questions": [hook],
        },
        rewrite_counters={"plan": 0, "writing": 1 if number == 3 else 0, "polish": 0},
        revision_count=1 if number == 3 else 0,
        revision_history=(
            [{
                "scope": "writing",
                "reason": "初稿让周砚提前知道第七码，触发角色认知越权检查。",
                "result": "删除越权信息，改为由林夏展示证据后再建立认知记录。",
            }]
            if number == 3
            else []
        ),
        side_effects_committed=True,
    )


def build_demo_state() -> GraphNovelState:
    outlines = [
        _outline(
            1,
            "雨停在零点之前",
            "档案修复师林夏收到一段来自明天的求救录音，并发现城市档案中缺失了第七码。",
            ["收到未来录音", "核对时间戳", "发现第七码缺失"],
            "录音末尾，传来林夏自己的声音。",
            "强钩子",
        ),
        _outline(
            2,
            "不存在的站台",
            "林夏依照录音抵达废弃地铁站，在封闭站台找到仍在运行的城市记忆终端。",
            ["潜入旧站", "启动终端", "读取零点重置记录"],
            "终端显示：本轮循环只剩六十小时。",
            "小爽点",
        ),
        _outline(
            3,
            "记得昨天的人",
            "林夏与失眠调查员周砚交换证据，系统拦截周砚不应提前知道的第七码信息。",
            ["交换证据", "验证角色认知来源", "定位档案馆暗门"],
            "暗门权限的登记人，是三年前已经去世的林夏父亲。",
            "反转",
        ),
        _outline(
            4,
            "城市的备份",
            "两人进入记忆备份层，确认循环不是灾难本身，而是阻止某个选择被执行的安全机制。",
            ["进入备份层", "发现循环用途", "遭遇守门人纪衡"],
            "纪衡摘下面具，和录音中的林夏拥有同一张脸。",
            "大爽点",
        ),
        _outline(
            5,
            "循环之外",
            "林夏利用第七码恢复被删除的选择记录，在保留城市记忆与终止循环之间作出第三种选择。",
            ["恢复第七码", "公开选择记录", "终止强制重置"],
            "零点过后，雨第一次继续落下。",
            "高潮",
        ),
    ]

    bodies = [
        """零点前十二分钟，雨忽然停在半空。

林夏隔着档案馆的落地窗看见这一幕时，修复台上的旧录音机自己亮了。磁带轮轴缓慢转动，一个女人压着呼吸说：“别让他们删掉第七码。”

声音到这里断了。时间戳却清清楚楚：明天，00:07。

林夏没有立刻相信。她调出城市灾备目录，从一号检索到八号。六号之后直接跳到了八号，像有人从整座城市的记忆里剪走了一格。

她把录音导入离线终端。波形末端藏着第二层声轨，背景是档案馆每天零点才会响起的钟声。

最后两秒，一个熟悉得令她手指发冷的声音贴着麦克风响起。

“林夏，如果你听见这段话，说明我又失败了一次。”

那是她自己的声音。""",
        """旧地铁十七号线封闭了九年，地图上已经找不到入口。

林夏按照录音里的四组杂音定位，在雨水泵房后找到一扇没有编号的铁门。门锁不认工牌，只认她从第七码目录里抄下的校验串。

站台下方没有轨道，只有一排仍在呼吸般明灭的服务器。屏幕醒来时，灰尘里亮出一行字：城市记忆备份，第六百四十一次重置完成。

她逐条检查日志。每次重置都发生在周日零点，每次都删除同一个选择记录。更异常的是，日志把她列为“未授权维护者”，却连续十二次记录了她的死亡。

终端忽然切换为红色。

距离下一次强制重置：59:59:58。

林夏拔下数据片，站台尽头随即传来脚步。有人在黑暗里说：“这一次，你比上一次早到了七分钟。”""",
        """来人叫周砚，市政事故调查处的停职调查员。

他没有说自己知道什么，只把一张纸质验尸记录推到灯下。死者姓名栏写着林夏，死亡时间却是两天后。

林夏先展示未来录音，再展示终端日志。直到她把“第七码”三个字写在纸上，周砚才第一次重复这个编号。

“所以它不是传闻，”他说，“是你刚刚给我的证据。”

两人的信息由此对齐。周砚提供事故现场的封锁记录，林夏用档案权限反查签发者。路径最终指向档案馆地下三层，一扇从未出现在建筑图纸上的暗门。

权限登记人：林成川。

林夏盯着父亲的名字。三年前，她亲手整理过他的死亡档案。

暗门从里面被敲了三下。""",
        """门后不是房间，而是一座被压缩的城市。

无数透明街区悬在黑暗中，每一扇窗都保存着某个市民在重置前最后一分钟的记忆。林夏看见六百四十个版本的自己走向不同结局，却都在零点归于空白。

周砚从备份索引里找到了循环的原始用途：它不是为了躲避灾难，而是为了阻止城市执行一项不可撤回的集体选择。有人把“保护”改写成了永远不允许选择发生。

守门人纪衡站在主控桥上，要求他们交出数据片。他说循环让所有人活着，记忆只是可以支付的成本。

林夏拒绝。纪衡抬手摘下面具。

那张脸与她一模一样，只是更疲惫，眼角多了一道烧伤。

“我是第七码留下的你，”纪衡说，“也是第一次按下重置的人。”""",
        """第七码保存的不是答案，而是被删除的投票过程。

林夏终于明白，纪衡一次次重置城市，是因为她无法接受任何包含牺牲的结果。可抹去选择并没有消除代价，只是让所有人被困在没有明天的安全里。

她没有关闭备份，也没有继续循环。她把六百四十次重置记录发送到每一个仍亮着的终端，让整座城市共同看见被隐瞒的成本。

主控桥上的倒计时归零，却没有自动重置。系统等待新的授权。

周砚提交公开表决，林夏则把最终密钥拆成千万份，交给每一个拥有城市记忆的人。再也没有谁能独自替所有人选择。

零点过去一分钟，悬在空中的雨滴落在玻璃上。

林夏听见城市久违的雨声。档案终端生成了一个从未出现过的日期：星期一。

循环之外，明天终于开始了。""",
    ]

    fact_sets = [
        [{"id": "F001", "statement": "林夏收到时间戳来自明天的求救录音", "category": "evidence"}],
        [{"id": "F002", "statement": "城市已完成六百四十一次记忆重置", "category": "world"}],
        [{"id": "F003", "statement": "周砚在林夏展示证据后得知第七码", "category": "knowledge"}],
        [{"id": "F004", "statement": "循环用于阻止城市执行集体选择", "category": "causality"}],
        [{"id": "F005", "statement": "城市终止强制重置并公开保存选择权", "category": "resolution"}],
    ]
    knowledge_sets = [
        [{"fact_id": "F001", "character": "林夏", "knowledge_level": "confirmed", "source_type": "recording", "evidence": "亲自播放录音"}],
        [{"fact_id": "F002", "character": "林夏", "knowledge_level": "confirmed", "source_type": "terminal", "evidence": "读取重置日志"}],
        [{"fact_id": "F003", "character": "周砚", "knowledge_level": "confirmed", "source_type": "shared_evidence", "source_character": "林夏", "evidence": "林夏展示录音与日志"}],
        [{"fact_id": "F004", "character": "林夏", "knowledge_level": "confirmed", "source_type": "archive", "evidence": "读取循环原始用途"}],
        [{"fact_id": "F005", "character": "林夏", "knowledge_level": "confirmed", "source_type": "direct_action", "evidence": "亲自拆分最终密钥"}],
    ]

    state = GraphNovelState(
        project_id=PROJECT_ID,
        novel_title="循环之外",
        save_dir=Path("examples") / PROJECT_ID,
        target_platform="general",
        creative_genre="近未来悬疑",
        creative_premise="一名档案修复师收到来自明天的求救录音，并发现整座城市被困在每周重置的记忆循环中。",
        creative_theme="真正的安全来自共同承担选择，而不是替所有人抹去代价。",
        genre_tags=["近未来", "悬疑", "时间循环", "群像"],
        target_total_words=120000,
        target_total_chapters=5,
        creative_notes="公开演示项目。展示连续性、人物认知来源、人工 Gate 和受控重写。",
        world_setting=WorldSetting(
            era="近未来",
            location="沿海记忆城市临川",
            technology_level="城市公共系统可备份部分集体记忆",
            social_structure="由市政记忆委员会管理公共档案和灾备系统",
            key_locations=[
                {"name": "临川档案馆", "description": "林夏工作的公共记忆修复中心。"},
                {"name": "十七号线旧站", "description": "隐藏城市记忆备份终端的废弃站台。"},
                {"name": "备份层", "description": "保存历次重置前最后一分钟记忆的虚拟空间。"},
            ],
            rules_and_laws="任何记忆修改必须保留来源、授权人和可撤销记录；第七码是被系统抹除的例外。",
            history="三年前的城市级事故后，临川开始执行未公开的周期性记忆重置。",
            notes="雨在零点冻结，是循环即将重置的可见征兆。",
        ),
        characters=[
            Character(
                name="林夏",
                role="protagonist",
                background="城市档案馆修复师，父亲曾参与记忆灾备系统设计。",
                personality="克制、敏锐，对没有来源的结论保持警惕。",
                motivation="找回被删除的公共选择记录，让城市重新拥有明天。",
                arc=CharacterArc("林夏", "从独自修复真相到把选择权交还所有人。", ArcStage.RESOLUTION),
                relationships={"周砚": "共同调查者", "纪衡": "循环中分化出的另一个自己"},
            ),
            Character(
                name="周砚",
                role="supporting",
                background="因追查重复事故而被停职的市政调查员。",
                personality="务实、耐心，只接受可以追溯来源的证据。",
                motivation="证明事故记录被系统性修改。",
                arc=CharacterArc("周砚", "从孤立调查到成为公开选择的推动者。", ArcStage.RESOLUTION),
                relationships={"林夏": "互相校验证据的盟友"},
            ),
            Character(
                name="纪衡",
                role="antagonist",
                background="第一次循环中幸存的林夏，以守门人身份维护重置。",
                personality="冷静、疲惫，把不失去任何人视为唯一正确答案。",
                motivation="通过重复重置避免城市作出有代价的选择。",
                arc=CharacterArc("纪衡", "从控制所有人的安全到接受共同承担。", ArcStage.RESOLUTION),
                relationships={"林夏": "同源但选择相反"},
            ),
        ],
        novel_outline=NovelOutline(
            genre="近未来悬疑",
            premise="档案修复师追查一段来自明天的录音，揭开城市记忆循环。",
            theme="选择权与安全的边界",
            target_length="公开演示短篇 / 5 章",
            target_platform="general",
            shuangdian_map=[
                {"chapter_range": "1-2", "type": "谜面", "description": "未来录音与城市重置日志连续抛出证据。"},
                {"chapter_range": "3-4", "type": "验证与反转", "description": "角色认知有来源，守门人身份反转。"},
                {"chapter_range": "5", "type": "高潮", "description": "恢复第七码并终止强制重置。"},
            ],
            chapter_outlines=outlines,
        ),
        foundation_approval=ApprovalStatus.APPROVED,
        workflow_phase="done",
        active_task={
            "id": "demo-global-review",
            "kind": "global_review",
            "status": "completed",
            "current_node": "done",
            "finished_at": "2026-08-02T20:12:00+08:00",
        },
        current_chapter=5,
        total_chapters=5,
        created_at="2026-08-02T18:00:00+08:00",
    )

    state.chapters = [
        _chapter(
            outlines[index],
            bodies[index],
            outlines[index].chapter_hook_idea,
            fact_sets[index],
            knowledge_sets[index],
            f"周日 {index * 12 + 1:02d}:00",
            ["临川档案馆", "十七号线旧站", "档案馆地下三层", "城市记忆备份层", "临川主控桥"][index],
        )
        for index in range(5)
    ]
    state.character_arc_tracker = {
        character.name: character.arc
        for character in state.characters
        if character.arc is not None
    }
    state.foreshadowing_tracker = [
        Foreshadowing(
            id="FS001",
            description="城市档案中失踪的第七码",
            planted_in_chapter=1,
            payoff_chapter=5,
            payoff_description="第七码恢复被删除的集体选择记录。",
            status="paid_off",
        ),
        Foreshadowing(
            id="FS002",
            description="录音中与林夏相同的声音",
            planted_in_chapter=1,
            payoff_chapter=4,
            payoff_description="声音来自第一次循环中成为守门人的纪衡。",
            status="paid_off",
        ),
    ]
    state.narrative_facts = [
        NarrativeFact(
            id=fact[0]["id"],
            statement=fact[0]["statement"],
            category=fact[0]["category"],
            established_in_chapter=index + 1,
            visibility="public" if index == 4 else "private",
        )
        for index, fact in enumerate(fact_sets)
    ]
    state.character_knowledge = [
        KnowledgeRecord(
            fact_id=record[0]["fact_id"],
            character=record[0]["character"],
            knowledge_level=record[0]["knowledge_level"],
            learned_in_chapter=index + 1,
            source_type=record[0]["source_type"],
            source_character=record[0].get("source_character", ""),
            evidence=record[0]["evidence"],
        )
        for index, record in enumerate(knowledge_sets)
    ]
    state.continuity_state = {
        "time": "星期一 00:01",
        "character_locations": {"林夏": "临川主控桥", "周砚": "临川主控桥", "纪衡": "城市记忆备份层"},
        "character_conditions": {"林夏": "清醒", "周砚": "轻伤", "纪衡": "解除守门权限"},
        "resources": {"强制重置权限": 0, "公开密钥分片": 10000000},
    }
    state.chapter_hooks = [outline.chapter_hook_idea for outline in outlines]
    state.shuangdian_schedule = state.novel_outline.shuangdian_map
    state.node_status = {
        "world_building": NodeStatus.COMPLETED,
        "character_design": NodeStatus.COMPLETED,
        "outline_planning": NodeStatus.COMPLETED,
        "human_approval_foundation": NodeStatus.COMPLETED,
        "global_review": NodeStatus.COMPLETED,
    }
    for number in range(1, 6):
        for node in ("chapter_planning", "writing", "style_polish", "consistency_review", "human_approval"):
            state.node_status[f"{node}_{number}"] = NodeStatus.COMPLETED
    state.global_review_report = {
        "overall_score": 9,
        "ready_for_platform": True,
        "golden_three_analysis": {
            "ch1_quality": "未来录音快速建立冲突",
            "ch2_quality": "重置日志升级谜面",
            "ch3_quality": "认知来源与父亲身份形成反转",
            "estimated_ch3_retention": "高",
        },
        "shuangdian_analysis": {"density": "均衡", "small_beats_count": 2, "big_beats_count": 2, "issues": []},
        "hook_analysis": {"strong": 5, "weak": 0, "missing": 0, "problem_chapters": []},
        "ai_disease_summary": {"total_found": 0, "overall_risk": "低", "high_risk_chapters": []},
        "algorithm_fitness": {
            "estimated_ch10_retention": "演示短篇不适用",
            "estimated_10w_retention": "演示短篇不适用",
            "estimated_follow_rate": "高",
            "shouxiu_ready": True,
        },
        "platform_competitiveness": {
            "strength": "谜面集中、角色认知来源清晰、每章结尾均推动下一步行动。",
            "weakness": "公开演示篇幅较短，尚未验证长线支线承载能力。",
            "differentiation": "通过 Narrative State 明确追踪事实、认知和连续性。",
        },
        "final_recommendations": [
            "扩写时保持第七码与循环用途的证据逐级揭示。",
            "新增角色前先声明其可见事实与信息来源。",
        ],
    }
    state.execution_events = [
        {"event": "checkpoint_saved", "node": "human_approval_foundation", "timestamp": "2026-08-02T18:10:00+08:00"},
        {"event": "gate_decision", "gate": "foundation", "decision": "approved", "timestamp": "2026-08-02T18:12:00+08:00"},
        {"event": "rewrite_requested", "node": "writing_3", "reason": "character_knowledge_violation", "timestamp": "2026-08-02T19:05:00+08:00"},
        {"event": "route_selected", "source": "writing_3", "target": "writing_3", "timestamp": "2026-08-02T19:05:01+08:00"},
        {"event": "gate_decision", "gate": "chapter:5", "decision": "approved", "timestamp": "2026-08-02T20:00:00+08:00"},
        {"event": "route_selected", "source": "global_review", "target": "done", "timestamp": "2026-08-02T20:12:00+08:00"},
    ]
    return state


def main() -> None:
    state = build_demo_state()
    path = state.save(PROJECT_DIR / f"{PROJECT_ID}_state.json")
    print(path)


if __name__ == "__main__":
    main()
