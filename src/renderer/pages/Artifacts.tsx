/**
 * Kozum Cowork — Artifacts page.
 */

import { useState } from "react";
import { Shapes, Search, Plus } from "lucide-react";
import { Empty } from "../components/Empty.tsx";
import styles from "./Artifacts.module.css";

interface ArtifactItem {
  id: string;
  name: string;
  type: string;
  sessionId: string;
  createdAt: number;
}

interface Props {
  artifacts: ArtifactItem[];
  onOpen: (id: string) => void;
}

export function Artifacts({ artifacts, onOpen }: Props) {
  const [search, setSearch] = useState("");

  const filtered = artifacts.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Artifacts</h1>
      </div>

      <div className={styles.searchRow}>
        <Search size={14} className={styles.searchIcon} />
        <input
          className={styles.search}
          placeholder="Search artifacts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search artifacts"
        />
      </div>

      {filtered.length === 0 ? (
        <div className={styles.emptyWrap}>
          <Empty
            icon={<Shapes size={24} />}
            title={search ? "No matching artifacts" : "No artifacts yet"}
            description={
              search
                ? "Try a different search term."
                : "Files, documents, and other outputs your agent creates will appear here."
            }
          />
        </div>
      ) : (
        <ul className={styles.list}>
          {filtered.map((a) => (
            <li key={a.id}>
              <button className={styles.card} onClick={() => onOpen(a.id)}>
                <div className={styles.cardIcon}>
                  <Plus size={15} />
                </div>
                <div className={styles.cardInfo}>
                  <span className={styles.cardName}>{a.name}</span>
                  <span className={styles.cardMeta}>
                    {a.type} · {new Date(a.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
