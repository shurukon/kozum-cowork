/**
 * Kozum Cowork — Code-mode home screen.
 *
 * Shows a personalised greeting and a stats overview card matching the
 * reference product: Sessions / Messages / Total tokens / Active days /
 * Current streak / Longest streak / Peak hour / Favourite model,
 * plus a 52-week activity heat-grid.
 *
 * Accepts a `stats` prop (CodeHomeStats). All values default to zero/empty
 * and render an honest empty state rather than invented numbers.
 *
 * NOT wired into App.tsx yet — import it and swap the Code-mode HomeView for
 * this component when App.tsx is updated.
 */

import styles from "./CodeHome.module.css";

// ── Stats shape ────────────────────────────────────────────────────────────

/**
 * Statistics shown on the Code home screen.
 * All fields are optional so callers can pass partial data safely.
 */
export interface CodeHomeStats {
  /** Total number of Code sessions ever started. */
  sessions?: number;
  /** Total number of messages sent across all Code sessions. */
  messages?: number;
  /** Cumulative token count (input + output) across all sessions. */
  totalTokens?: number;
  /** Number of calendar days with at least one session. */
  activeDays?: number;
  /** Consecutive days ending today with at least one session. */
  currentStreak?: number;
  /** Longest ever consecutive-day streak. */
  longestStreak?: number;
  /**
   * Hour of the day (0–23) when most sessions start.
   * Undefined when there is no data yet.
   */
  peakHour?: number;
  /** modelId of the model used most often. */
  favouriteModel?: string;
  /**
   * 364 integers (52 weeks × 7 days) representing session counts per day,
   * oldest first. Values above 0 are bucketed into heat levels 1–4.
   * Pass an empty array or omit to render an empty grid.
   */
  activityGrid?: number[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n === 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatHour(h: number | undefined): string {
  if (h === undefined) return "—";
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ampm}`;
}

function heatLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

// Build a guaranteed 52×7 grid (364 cells) from the activityGrid array.
function buildWeeks(raw: number[]): number[][] {
  const cells = [...raw];
  // Pad / truncate to exactly 364 entries.
  while (cells.length < 364) cells.unshift(0);
  const trimmed = cells.slice(-364);

  const weeks: number[][] = [];
  for (let w = 0; w < 52; w++) {
    weeks.push(trimmed.slice(w * 7, w * 7 + 7));
  }
  return weeks;
}

// ── Sub-components ─────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  isEmpty?: boolean;
}

function StatCard({ label, value, sub, isEmpty }: StatCardProps) {
  return (
    <div className={styles.statCard}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${isEmpty ? styles.statValueEmpty : ""}`}>
        {isEmpty ? "—" : value}
      </span>
      {sub && <span className={styles.statSub}>{sub}</span>}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  userName: string;
  stats: CodeHomeStats;
}

export function CodeHome({ userName, stats }: Props) {
  const {
    sessions = 0,
    messages = 0,
    totalTokens = 0,
    activeDays = 0,
    currentStreak = 0,
    longestStreak = 0,
    peakHour,
    favouriteModel,
    activityGrid = [],
  } = stats;

  const hasAnyData = sessions > 0 || messages > 0;
  const weeks = buildWeeks(activityGrid);

  const heading = userName
    ? `What's up next, ${userName}?`
    : "What are we building?";

  return (
    <div className={`${styles.wrap} kz-dotfield kz-dotfield-fade`}>
      <div className={styles.inner}>
        {/* Greeting */}
        <h1 className={styles.heading}>
          <img
            src="./icons/mark-32.png"
            alt=""
            width={26}
            height={26}
            className={styles.mark}
          />
          <span>{heading}</span>
        </h1>

        {/* Stats overview */}
        <div className={styles.statsGrid}>
          <StatCard
            label="Sessions"
            value={sessions}
            isEmpty={sessions === 0}
          />
          <StatCard
            label="Messages"
            value={messages}
            isEmpty={messages === 0}
          />
          <StatCard
            label="Total tokens"
            value={formatTokens(totalTokens)}
            isEmpty={totalTokens === 0}
          />
          <StatCard
            label="Active days"
            value={activeDays}
            isEmpty={activeDays === 0}
          />
          <StatCard
            label="Current streak"
            value={currentStreak}
            sub={currentStreak === 1 ? "day" : "days"}
            isEmpty={currentStreak === 0}
          />
          <StatCard
            label="Longest streak"
            value={longestStreak}
            sub={longestStreak === 1 ? "day" : "days"}
            isEmpty={longestStreak === 0}
          />
          <StatCard
            label="Peak hour"
            value={formatHour(peakHour)}
            isEmpty={peakHour === undefined}
          />
          <StatCard
            label="Favourite model"
            value={favouriteModel ?? "—"}
            isEmpty={!favouriteModel}
          />
        </div>

        {/* Activity heat-grid */}
        <div className={styles.heatSection}>
          <span className={styles.heatTitle}>Activity — last 52 weeks</span>

          {!hasAnyData ? (
            <p className={styles.emptyHint}>
              Your coding activity will appear here after your first session.
            </p>
          ) : (
            <>
              <div className={styles.heatGrid} aria-label="Activity heat grid">
                {weeks.map((week, wi) => (
                  <div key={wi} className={styles.heatWeek}>
                    {week.map((count, di) => {
                      const level = heatLevel(count);
                      return (
                        <div
                          key={di}
                          className={`${styles.heatCell} ${
                            level === 1
                              ? styles.heatLevel1
                              : level === 2
                                ? styles.heatLevel2
                                : level === 3
                                  ? styles.heatLevel3
                                  : level === 4
                                    ? styles.heatLevel4
                                    : ""
                          }`}
                          title={`${count} session${count !== 1 ? "s" : ""}`}
                          aria-label={`${count} session${count !== 1 ? "s" : ""}`}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* Legend */}
              <div className={styles.heatLegend}>
                <span className={styles.heatLegendLabel}>Less</span>
                <div className={styles.heatLegendCells}>
                  {([0, 1, 2, 3, 4] as const).map((lvl) => (
                    <div
                      key={lvl}
                      className={`${styles.heatCell} ${
                        lvl === 1
                          ? styles.heatLevel1
                          : lvl === 2
                            ? styles.heatLevel2
                            : lvl === 3
                              ? styles.heatLevel3
                              : lvl === 4
                                ? styles.heatLevel4
                                : ""
                      }`}
                    />
                  ))}
                </div>
                <span className={styles.heatLegendLabel}>More</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
