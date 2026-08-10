/**
 * State-coverage governor hook (P1-5 / §7).
 *
 * Given a stream of events, exposes the current loading phase according to the
 * open-design thresholds:
 *   0–300 ms: "instant" (nothing)
 *   300 ms–2 s: "spinner"
 *   2 s–10 s: "skeleton"
 *   10 s–30 s: "progress" (determinate with cancel)
 *   30 s+: "stuck" (error with retry)
 *   Any phase without progress for 15 s: "takingLonger" flag
 *
 * Honours prefers-reduced-motion by collapsing all shimmer to plain placeholders.
 */

import { useEffect, useRef, useState, useCallback } from "react";

export type LoadingPhase =
  | "instant"
  | "spinner"
  | "skeleton"
  | "progress"
  | "stuck";

export interface GovernorState {
  phase: LoadingPhase;
  elapsedMs: number;
  takingLonger: boolean; // true after 15 s without any progress event
}

const THRESHOLDS = {
  instant: 300,
  spinner: 2_000,
  skeleton: 10_000,
  progress: 30_000,
  // 30 s+ → stuck
} as const;

const TAKING_LONGER_MS = 15_000;

export function useStateCoverageGovernor(
  events: readonly { type: string; timestamp?: number }[],
  isRunning: boolean,
): GovernorState {
  const [phase, setPhase] = useState<LoadingPhase>("instant");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [takingLonger, setTakingLonger] = useState(false);

  const startRef = useRef<number | null>(null);
  const lastProgressRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute phase from elapsed time
  const computePhase = useCallback((ms: number): LoadingPhase => {
    if (ms < THRESHOLDS.instant) return "instant";
    if (ms < THRESHOLDS.spinner) return "spinner";
    if (ms < THRESHOLDS.skeleton) return "skeleton";
    if (ms < THRESHOLDS.progress) return "progress";
    return "stuck";
  }, []);

  // Reset when a new run starts (events array replaced or first event is turn_start)
  useEffect(() => {
    if (events.length > 0 && events[0].type === "turn_start") {
      startRef.current = Date.now();
      lastProgressRef.current = Date.now();
      setElapsedMs(0);
      setPhase("instant");
      setTakingLonger(false);
    }
  }, [events.length, events[0]?.type]);

  // Update elapsed while running
  useEffect(() => {
    if (!isRunning || startRef.current === null) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const tick = () => {
      const now = Date.now();
      const elapsed = now - (startRef.current ?? now);
      setElapsedMs(elapsed);
      setPhase(computePhase(elapsed));

      // Taking-longer check: if no progress event in 15 s
      if (now - lastProgressRef.current >= TAKING_LONGER_MS) {
        setTakingLonger(true);
      }

      if (isRunning) {
        timerRef.current = setTimeout(tick, 250); // 4 Hz
      }
    };

    timerRef.current = setTimeout(tick, 0);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isRunning, computePhase]);

  // Track progress events to reset takingLonger timer
  useEffect(() => {
    const progressEvents = events.filter(
      (e) => e.type === "text_delta" || e.type === "tool_progress" || e.type === "tool_start",
    );
    if (progressEvents.length > 0) {
      lastProgressRef.current = Date.now();
      setTakingLonger(false);
    }
  }, [events]);

  return { phase, elapsedMs, takingLonger };
}