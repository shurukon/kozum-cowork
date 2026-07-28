/**
 * Kozum Cowork — Projects page.
 */

import { useState } from "react";
import { FolderOpen, Plus, Search } from "lucide-react";
import type { Project } from "@shared/types.ts";
import { Empty } from "../components/Empty.tsx";
import styles from "./Projects.module.css";

interface Props {
  projects: Project[];
  onNew: () => void;
  onOpen: (id: string) => void;
}

export function Projects({ projects, onNew, onOpen }: Props) {
  const [search, setSearch] = useState("");

  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Projects</h1>
        <button className={styles.newBtn} onClick={onNew}>
          <Plus size={14} />
          <span>New project</span>
        </button>
      </div>

      <div className={styles.searchRow}>
        <Search size={14} className={styles.searchIcon} />
        <input
          className={styles.search}
          placeholder="Search projects…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search projects"
        />
      </div>

      {filtered.length === 0 ? (
        <div className={styles.emptyWrap}>
          <Empty
            icon={<FolderOpen size={24} />}
            title={search ? "No matching projects" : "Create your first project"}
            description={
              search
                ? "Try a different search term."
                : "Projects keep related tasks, files, and context together."
            }
            action={
              !search ? (
                <button className={styles.emptyBtn} onClick={onNew}>
                  <Plus size={14} />
                  <span>New project</span>
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ul className={styles.grid}>
          {filtered.map((p) => (
            <li key={p.id}>
              <button className={styles.card} onClick={() => onOpen(p.id)}>
                <div className={styles.cardIcon}>
                  {p.icon ? (
                    <span className={styles.iconEmoji}>{p.icon}</span>
                  ) : (
                    <FolderOpen size={18} />
                  )}
                </div>
                <div className={styles.cardInfo}>
                  <span className={styles.cardName}>{p.name}</span>
                  {p.folder && (
                    <span className={styles.cardFolder}>{p.folder}</span>
                  )}
                </div>
                <span className={styles.cardMode}>{p.mode}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
