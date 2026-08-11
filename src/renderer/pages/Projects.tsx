/**
 * Kozum Cowork — Projects page.
 *
 * Grid of project cards with archive/delete actions and rich detail
 * (created/updated timestamps, archived badge, mode badge, folder path).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, FolderOpen, Plus, Search, Trash2, ArchiveRestore } from "lucide-react";
import type { Project } from "@shared/types.ts";
import { Empty } from "../components/Empty.tsx";
import styles from "./Projects.module.css";

interface Props {
  projects: Project[];
  onNew: () => void;
  onOpen: (id: string) => void;
  /** Archive or unarchive a project. */
  onArchive?: (id: string) => void;
  /** Hard-delete a project. */
  onDelete?: (id: string) => void;
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return "";
  }
}

export function Projects({ projects, onNew, onOpen, onArchive, onDelete }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  const filtered = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.folder ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t("projects.title")}</h1>
        <button className={styles.newBtn} onClick={onNew}>
          <Plus size={14} />
          <span>{t("projects.newProject")}</span>
        </button>
      </div>

      <div className={styles.searchRow}>
        <Search size={14} className={styles.searchIcon} />
        <input
          className={styles.search}
          placeholder={t("projects.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t("projects.search")}
        />
      </div>

      {filtered.length === 0 ? (
        <div className={styles.emptyWrap}>
          <Empty
            icon={<FolderOpen size={24} />}
            title={search ? t("projects.empty") : t("projects.empty")}
            description={search ? t("projects.empty") : t("projects.empty")}
            action={
              !search ? (
                <button className={styles.emptyBtn} onClick={onNew}>
                  <Plus size={14} />
                  <span>{t("projects.newProject")}</span>
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ul className={styles.grid}>
          {filtered.map((p) => (
            <li key={p.id}>
              <div className={styles.card}>
                <button
                  className={styles.cardHeader}
                  onClick={() => onOpen(p.id)}
                  title={t("projects.open")}
                >
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
                      <span className={styles.cardFolder} title={p.folder}>
                        {p.folder}
                      </span>
                    )}
                    <span className={styles.cardDates}>
                      {t("projects.created")}: {formatDate(p.createdAt)}
                      {p.updatedAt !== p.createdAt && ` · ${formatDate(p.updatedAt)}`}
                    </span>
                  </div>
                  <span className={styles.cardMode}>{p.mode}</span>
                  {p.archived && (
                    <span className={styles.archivedBadge}>{t("projects.archived")}</span>
                  )}
                </button>
                <div className={styles.cardActions}>
                  {onArchive && (
                    <button
                      className={styles.cardActionBtn}
                      onClick={() => onArchive(p.id)}
                      title={p.archived ? t("projects.unarchive") : t("projects.archive")}
                      aria-label={p.archived ? t("projects.unarchive") : t("projects.archive")}
                    >
                      {p.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                    </button>
                  )}
                  {onDelete && (
                    <button
                      className={`${styles.cardActionBtn} ${styles.cardActionDanger}`}
                      onClick={() => {
                        if (confirm(t("projects.deleteConfirm"))) onDelete(p.id);
                      }}
                      title={t("projects.delete")}
                      aria-label={t("projects.delete")}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
