import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginManager } from "../src/main/plugins/manager.ts";

const repo = "tsgx1990/openmontage-plugin";
const zipUrl = `https://codeload.github.com/${repo}/zip/refs/heads/main`;
const root = await mkdtemp(join(tmpdir(), "kozum-plugin-live-"));
const reportPath = process.env.KOZUM_PLUGIN_REPORT ?? join(process.cwd(), "artifacts", "openmontage-plugin-live.json");

try {
  const githubManager = new PluginManager(join(root, "github-plugins"));
  const githubPlugin = await githubManager.installFromGitHub(repo);

  const response = await fetch(zipUrl);
  if (!response.ok) throw new Error(`GitHub zipball returned HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  const zipManager = new PluginManager(join(root, "zip-plugins"));
  const zipPlugin = await zipManager.installFromZip(zip, "openmontage-plugin-main.zip");

  const report = {
    ok: true,
    repository: `https://github.com/${repo}`,
    githubInstall: {
      name: githubPlugin.name,
      version: githubPlugin.version,
      source: githubPlugin.source,
      pathExists: githubPlugin.path.length > 0,
      skills: githubPlugin.skills,
      agents: githubPlugin.agents,
      commands: githubPlugin.commands,
      mcpServers: githubPlugin.mcpServers,
      hasHooks: githubPlugin.hasHooks,
    },
    zipInstall: {
      name: zipPlugin.name,
      version: zipPlugin.version,
      source: zipPlugin.source,
      skills: zipPlugin.skills,
      agents: zipPlugin.agents,
      commands: zipPlugin.commands,
      mcpServers: zipPlugin.mcpServers,
      hasHooks: zipPlugin.hasHooks,
    },
    archiveBytes: zip.length,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
