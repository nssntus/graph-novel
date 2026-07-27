# GraphNovel Handover

**项目**：番茄小说工坊 — 基于图引擎的 AI 辅助网文写作系统
**创建日期**：2026-07-25
**最后修改**：2026-07-26

---

## 1. 项目概述

这是一个用 9 个 AI Agent 节点协作写中文网络小说的系统，目标平台为番茄小说。
核心架构：**有向无环图 (DAG)**，每个节点是专用 Agent，State 贯穿全图。

### 三阶段流程

**Phase 1 — Foundation（生成世界观 + 人物 + 大纲，需人类审批）**
- 节点 1: `world_building` → 生成世界观（含金手指）
- 节点 2: `character_design` → 生成角色阵容（含弧线）
- 节点 3: `outline_planning` → 生成章节大纲 + 爽点排期表
- 节点 8: `human_approval` → 人类审批卡点

**Phase 2 — 逐章管线**
- 节点 4: `chapter_planning` → 章节情节规划
- 节点 5: `writing` → 写正文 (2000-2500 字/章)
- 节点 6: `consistency_review` → 毒舌审稿 (OOC/AI病/钩子质量)
- 节点 7: `style_polish` → 消除 AI 味 + 网感润色
- 节点 8: `human_approval` → 人类审批

**Phase 3 — 全局终审**
- 节点 9: `global_review` → 全书评估 + 算法适配

---

## 2. 技术栈

| 组件 | 选择 |
|------|------|
| 语言 | Python 3.9 (注意类型注解兼容) |
| LLM | DeepSeek v4-pro (OpenAI SDK, base_url: api.deepseek.com/v1) |
| Web | Flask 3.x + Jinja2 模板 |
| 数据 | dataclass + JSON 序列化 |
| 测试 | unittest.mock, Flask test client |

### 关键文件清单

```
GraphNovel/
├── web_server.py              # 启动入口: python3 web_server.py → :5500
├── requirements.txt           # openai, flask, pydantic, python-dotenv
├── .env                       # DEEPSEEK_API_KEY=sk-xxx (不要提交)
├── graph_novel/
│   ├── state.py               # 共享 State 数据模型 (GraphNovelState 等)
│   ├── engine.py              # DAG 编排引擎 (三阶段调度)
│   ├── llm.py                 # DeepSeek API 封装 (call_llm_sync)
│   ├── cli.py                 # CLI 入口
│   ├── nodes/                 # 9 个 Agent 节点
│   │   ├── world_building.py
│   │   ├── character_design.py
│   │   ├── outline_planning.py
│   │   ├── chapter_planning.py
│   │   ├── writing.py
│   │   ├── consistency_review.py
│   │   ├── style_polish.py
│   │   ├── human_approval.py
│   │   └── global_review.py
│   └── web/
│       ├── app.py             # Flask routes + API
│       ├── static/
│       │   ├── chat.js        # 浮动聊天助手「小番」
│       │   └── style.css
│       └── templates/         # 6 个页面模板
│           ├── index.html     # 项目列表
│           ├── create.html    # 创建新书
│           ├── foundation.html# Foundation 页面
│           ├── chapters.html  # 章节管理
│           ├── dashboard.html # 项目面板
│           └── review.html    # 全局终审
└── tests/
    └── test_integration.py    # 9 项集成测试
```

---

## 3. 启动方式

```bash
cd /Users/leo/Claude/Projects/GraphNovel
pip3 install -r requirements.txt   # macOS 不需要 --break-system-packages
python3 web_server.py               # 访问 http://localhost:5500
```

---

## 4. 数据模型关键点

### GraphNovelState（贯穿全图的共享状态）
- `world_setting`: WorldSetting | None（初始为 None，Foundation 后才有值）
- `characters`: list[Character]
- `novel_outline`: NovelOutline（含 shuangdian_map 爽点排期表）
- `chapters`: list[Chapter]（每章含 draft, polished_draft, chapter_hook, shuangdian_type）
- `character_arc_tracker`: dict 追踪弧线进展
- `foreshadowing_tracker`: list 追踪伏笔
- `creative_notes`: 用户在创建项目时输入的创作方向
- `genre_tags`: 题材标签列表

### 序列化注意
- `GraphNovelState.to_dict()` / `.to_json()` / `.save()` 用于存储
- API 返回 JSON 时用 `_serialize_dataclass()` 函数（定义在 web/app.py 中）
- 部分节点文件中的 `_serialize_dataclass()` 是独立定义的本地副本（因为 `state.py` 中的 `_serialize` 函数带有 `__model__` 标记，不适合 API JSON 输出）

---

## 5. 已知问题与修复记录

### Bug 1: Foundation 页面显示空卡片而非「生成」按钮 (已修复)
- **原因**：`create_project()` 创建了 `WorldSetting(era="", location="")` 空壳对象，模板 `{% if state.world_setting %}` 判定为真
- **修复**：`web/app.py` 中 `world_setting=None`；`foundation.html` 条件改为 `state.world_setting and state.world_setting.era`
- **附带修复**：用户的创作方向（notes）原来丢失了，现在存入 `state.creative_notes`

### Bug 2: Foundation API 返回 500 错误 (已修复)
- **原因**：`WorldSetting` 等 dataclass 没有 `.to_dict()` 方法（之前依赖 `from __future__ import annotations` 被移除后丢失）
- **修复**：在 `web/app.py` 中新增 `_serialize_dataclass()` 函数处理所有 dataclass + Enum + Path 类型
- **同时修复**：`character_design.py` 和 `outline_planning.py` 中各自添加了本地的 `_serialize_dataclass()`

---

## 6. 开发注意事项

### 类型注解（Python 3.9 兼容）
```python
# 正确 ✅
from typing import Optional, List, Dict
x: Optional[str] = None
items: List[Chapter] = []
mapping: Dict[str, int] = {}

# 错误 ❌（Python 3.10+ 语法）
x: str | None = None
items: list[Chapter] = []
```

### macOS 安装
```bash
pip3 install -r requirements.txt    # 不需要 --break-system-packages
```

### DeepSeek API
- Key 格式：`sk-xxx`（自动注入到 web_server.py 启动脚本）
- 支持模型：`deepseek-v4-pro`，`deepseek-v4-flash`

### 测试
```bash
python3 tests/test_integration.py
```
9 项测试覆盖：数据模型、序列化、图引擎路由、章节管线（mock LLM）、改写循环、全局审查、伏笔追踪、Web 配置、State API

---

## 7. 避免死循环的铁律

**本轮会话已确认的规则**：
1. 修复一旦被测试验证通过 + 模拟流程验证正确 → 立即交付结果，停止一切重复操作
2. 如果连续两次工具调用返回 "file unchanged" 或 "no matches" → 检查是否是早已完成的工作
3. 测试跑了通过就不要反复跑
4. 工具报错 "No such tool available" → 不要换写法反复尝试，已确认的操作保持终态
