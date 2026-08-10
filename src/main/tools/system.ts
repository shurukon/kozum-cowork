/**
 * system_info — report OS, hardware, and runtime environment.
 */

import os from "node:os";
import type { Tool } from "./registry.ts";
import { ok } from "./registry.ts";

/* --------------------------------------------------------------- tools ---- */

export const systemTools: Tool[] = [
  {
    definition: {
      name: "system_info",
      title: "System Info",
      description:
        "Return information about the operating system and runtime: " +
        "platform, OS release, architecture, CPU model and count, " +
        "total and free memory, uptime, Node version, Electron version if present, " +
        "current working directory, hostname, and user home directory. " +
        "Useful for diagnosing environment issues or tailoring commands to the OS.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      icon: "monitor",
      group: "system",
      modes: ["cowork", "code"],
    },

    handler: async (_input, _ctx) => {
      const cpus = os.cpus();
      const cpuModel = cpus[0]?.model ?? "unknown";
      const cpuCount = cpus.length;
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const uptime = os.uptime();
      const nodeVersion = process.version;

      // Electron adds process.versions.electron when present
      const electronVersion =
        (process.versions as Record<string, string>)["electron"] ?? null;

      const toMiB = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);

      const uptimeStr = (() => {
        const s = Math.floor(uptime);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return `${h}h ${m}m ${sec}s`;
      })();

      const lines = [
        `Platform:     ${os.platform()} (${os.type()})`,
        `Release:      ${os.release()}`,
        `Architecture: ${os.arch()}`,
        `Hostname:     ${os.hostname()}`,
        `CPU:          ${cpuModel} × ${cpuCount}`,
        `Memory:       ${toMiB(freeMem)} MiB free / ${toMiB(totalMem)} MiB total`,
        `Uptime:       ${uptimeStr}`,
        `Node:         ${nodeVersion}`,
        ...(electronVersion ? [`Electron:     ${electronVersion}`] : []),
        `CWD:          ${process.cwd()}`,
        `Home:         ${os.homedir()}`,
        `User:         ${os.userInfo().username}`,
      ];

      const content = lines.join("\n");
      return ok(content, { summary: `${os.platform()} ${os.arch()} — ${cpuCount} CPUs, ${toMiB(freeMem)}/${toMiB(totalMem)} MiB RAM` });
    },
  },
];
