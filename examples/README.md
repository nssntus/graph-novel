# GraphNovel 示例项目

`xunhuan-zhi-wai/` 是旧 Python State v8 格式的完整公开示例，包含世界观、人物、五章已批准正文、Narrative State、伏笔、角色认知来源、一次受控重写记录和全局终审报告。它不会被新 Checkpoint Store 直接加载，需要先迁移。

在仓库根目录运行：

```bash
npm run cli -- migration-preview \
  --source examples/xunhuan-zhi-wai/xunhuan-zhi-wai_state.json

npm run cli -- migration-write \
  --source examples/xunhuan-zhi-wai/xunhuan-zhi-wai_state.json \
  --dir /tmp/graphnovel-example

GRAPH_NOVEL_DIR=/tmp/graphnovel-example npm run dev
```

打开 `http://127.0.0.1:5500`，选择《循环之外》。上述迁移会在目标目录同时保留旧 JSON 备份，不会覆盖仓库中的源文件。

示例内容为本项目原创演示数据，不代表真实模型输出质量。示例状态文件同时可作为旧存档迁移和兼容性测试夹具。
