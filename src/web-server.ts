import { CheckpointStore } from "./checkpoint/store.js";
import { createAgentDependenciesFromEnv, loadProjectEnv } from "./runtime/config.js";
import { createGraphNovelHttpServer } from "./web/server.js";
import { GraphNovelService } from "./web/service.js";

loadProjectEnv();
const rootDir = process.env.GRAPH_NOVEL_DIR ?? "./.graphnovel-data";
const port = Number(process.env.PORT ?? 5500);
const service = new GraphNovelService(new CheckpointStore(rootDir), createAgentDependenciesFromEnv());
const server = createGraphNovelHttpServer(service);

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`GraphNovel listening on http://127.0.0.1:${port}\n`);
});
