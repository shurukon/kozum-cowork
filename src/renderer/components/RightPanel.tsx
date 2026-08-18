import { useState, type ReactNode } from "react";
import { Bot, ChevronDown, ChevronRight, ListTodo, Plug } from "lucide-react";
import type { AgentTask, McpServerConfig, Mode } from "@shared/types.ts";
import type { SubagentView } from "../store/sessionTypes.ts";
import { TaskList } from "./TaskList.tsx";
import { SubagentCard } from "./SubagentCard.tsx";
import { UsageSummary } from "./UsageSummary.tsx";
import styles from "./RightPanel.module.css";

interface SectionProps {
  title: string;
  icon: typeof ListTodo;
  defaultOpen?: boolean;
  children: ReactNode;
}

function Section({ title, icon: Icon, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`${styles.section} kz-glass`}>
      <button
        className={styles.sectionHeader}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        type="button"
      >
        <Icon size={12} className={styles.sectionIcon} aria-hidden="true" />
        <span className={styles.sectionTitle}>{title}</span>
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

export interface RightPanelProps {
  mode: Mode;
  tasks: AgentTask[];
  subagents: Record<string, SubagentView>;
  mcpServers: McpServerConfig[];
  toolsUsed: string[];
  skillsUsed: string[];
  projectName: string | null;
  workingFolder: string | null;
}

export function RightPanel({
  mode,
  tasks,
  subagents,
  mcpServers,
  toolsUsed,
  skillsUsed,
  projectName,
  workingFolder,
}: RightPanelProps) {
  const subagentEntries = Object.values(subagents);
  const hasRunningSubagents = subagentEntries.some((subagent) => subagent.status === "running");
  const hasProgress = tasks.length > 0 || toolsUsed.length > 0 || skillsUsed.length > 0 || Boolean(projectName) || mcpServers.length > 0;

  if (mode === "cowork") {
    return (
      <aside className={`${styles.panel} ${styles.coworkPanel}`} aria-label="Cowork progress panel">
        <div className={styles.panelIntro}>
          <span className={styles.panelEyebrow}>WORKSPACE</span>
          <span className={styles.panelHint}>Live progress</span>
        </div>

        <Section title="Progress" icon={ListTodo} defaultOpen={tasks.length > 0}>
          <TaskList tasks={tasks} />
        </Section>

        <Section title="Context" icon={Plug} defaultOpen={hasProgress}>
          <UsageSummary
            tools={toolsUsed}
            project={projectName ? { name: projectName, folder: workingFolder } : null}
            skills={skillsUsed}
            mcpServers={mcpServers}
          />
        </Section>
      </aside>
    );
  }

  return (
    <aside className={styles.panel} aria-label="Side panel">
      <Section title="Progress" icon={ListTodo} defaultOpen={tasks.length > 0}>
        <TaskList tasks={tasks} />
      </Section>

      <Section title="Context" icon={Plug} defaultOpen={hasProgress}>
        <UsageSummary
          tools={toolsUsed}
          project={projectName ? { name: projectName, folder: workingFolder } : null}
          skills={skillsUsed}
          mcpServers={mcpServers}
        />
      </Section>

      <Section
        title="Subagents"
        icon={Bot}
        defaultOpen={subagentEntries.length > 0 || hasRunningSubagents}
      >
        {subagentEntries.length === 0 ? (
          <p className={styles.empty}>No subagent runs yet.</p>
        ) : (
          <div className={styles.subagentList}>
            {subagentEntries.map((view) => (
              <SubagentCard key={view.id} view={view} />
            ))}
          </div>
        )}
      </Section>
    </aside>
  );
}
