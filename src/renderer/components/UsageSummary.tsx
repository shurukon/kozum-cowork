import { type ReactNode } from "react";
import {
  Cable,
  FolderOpen,
  Wrench,
  Zap,
} from "lucide-react";
import type { McpServerConfig } from "@shared/types.ts";
import styles from "./RightPanel.module.css";

export interface UsageProject {
  name: string;
  folder?: string | null;
}

export interface UsageSummaryProps {
  tools: string[];
  project: UsageProject | null;
  skills: string[];
  mcpServers: McpServerConfig[];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function UsageBlock({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: typeof Wrench;
  children: ReactNode;
}) {
  return (
    <div className={styles.usageBlock}>
      <div className={styles.usageLabel}>
        <Icon size={13} aria-hidden="true" />
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

export function UsageSummary({ tools, project, skills, mcpServers }: UsageSummaryProps) {
  const toolNames = unique(tools);
  const skillNames = unique(skills);
  const servers = Array.from(
    new Map(mcpServers.map((server) => [server.id, server])).values(),
  );

  const hasUsage = Boolean(project) || toolNames.length > 0 || skillNames.length > 0 || servers.length > 0;
  if (!hasUsage) return null;

  return (
    <div className={styles.usageSummary} aria-label="Run resources">
      <div className={styles.usageHeading}>Used in this run</div>

      {project && (
        <UsageBlock label="Project" icon={FolderOpen}>
          <div className={styles.usageValue} title={project.folder ?? project.name}>
            {project.name}
          </div>
        </UsageBlock>
      )}

      {toolNames.length > 0 && (
        <UsageBlock label="Tools" icon={Wrench}>
          <div className={styles.usageChips}>
            {toolNames.map((name) => (
              <span className={styles.usageChip} key={name}>
                {name}
              </span>
            ))}
          </div>
        </UsageBlock>
      )}

      {skillNames.length > 0 && (
        <UsageBlock label="Skills" icon={Zap}>
          <div className={styles.usageChips}>
            {skillNames.map((name) => (
              <span className={styles.usageChip} key={name}>
                {name}
              </span>
            ))}
          </div>
        </UsageBlock>
      )}

      {servers.length > 0 && (
        <UsageBlock label="MCP servers" icon={Cable}>
          <div className={styles.usageChips}>
            {servers.map((server) => (
              <span className={styles.usageChip} key={server.id} title={server.status}>
                {server.name}
              </span>
            ))}
          </div>
        </UsageBlock>
      )}
    </div>
  );
}
