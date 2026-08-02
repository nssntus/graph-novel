# GraphNovel 示例项目

`xunhuan-zhi-wai/` 是一个不调用真实模型的完整公开示例，包含世界观、人物、五章已批准正文、Narrative State、伏笔、角色认知来源、一次受控重写记录和全局终审报告。

在仓库根目录运行：

```bash
GRAPH_NOVEL_DIR=examples python3 web_server.py
```

打开 `http://127.0.0.1:5500`，选择《循环之外》。

重新生成示例状态：

```bash
python3 examples/build_demo_project.py
```

示例内容为本项目原创演示数据，不代表真实模型输出质量。
