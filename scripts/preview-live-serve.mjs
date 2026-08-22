import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalPreviewServer } from "../src/main/preview/server.ts";

const root = join(process.cwd(), "artifacts", "preview-demo");
const htmlPath = join(root, "index.html");
const output = process.env.KOZUM_PREVIEW_URL ?? join(process.cwd(), "artifacts", "preview-live-url.txt");
const server = new LocalPreviewServer();
const handle = await server.open(htmlPath);
await writeFile(output, `${handle.url}\n`, "utf8");
console.log(handle.url);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
setInterval(() => {}, 60_000);
