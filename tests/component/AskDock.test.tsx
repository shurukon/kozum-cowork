/**
 * Component tests for AskDock (Task 10).
 *
 * The dock must render exactly ONE pending item at a time with an "n of m"
 * counter, and answering the visible item removes it and reveals the next
 * queued one — permissions first, questions after.
 */

import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

// No global i18n instance exists under vitest; provide the exact strings the
// dock renders so role-based queries match the real UI.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        "askDock.title": "Action required",
        "askDock.needsApproval": "needs your approval",
        "askDock.allowOnce": "Allow once",
        "askDock.allowAlways": "Allow always this session",
        "askDock.expandInput": "Show full input",
        "askDock.collapseInput": "Collapse input",
        "askDock.queued": `${opts?.count ?? 0} more queued`,
        "common.deny": "Deny",
      };
      return dict[key] ?? key;
    },
  }),
}));

import { AskDock, type AskDockDecision } from "../../src/renderer/components/AskDock.tsx";
import type { PendingPermission, PendingQuestion } from "../../src/renderer/store/sessionTypes.ts";

const permA: PendingPermission = {
  requestId: "perm-a",
  toolName: "file_delete",
  input: { path: "/tmp/a.txt" },
  reason: "The agent wants to delete a file.",
};
const permB: PendingPermission = {
  requestId: "perm-b",
  toolName: "shell_exec",
  input: { command: "rm -rf /tmp/b" },
  reason: "The agent wants to run a command.",
};
const questionA: PendingQuestion = {
  requestId: "q-a",
  question: "Which framework should I use?",
  options: [
    { label: "React", value: "react" },
    { label: "Vue", value: "vue" },
  ],
  multiSelect: false,
};

/** Harness mirroring ChatView's optimistic-resolve wiring. */
function Harness({
  initialPermissions,
  initialQuestions,
}: {
  initialPermissions: PendingPermission[];
  initialQuestions: PendingQuestion[];
}) {
  const [permissions, setPermissions] = useState(initialPermissions);
  const [questions, setQuestions] = useState(initialQuestions);
  return (
    <AskDock
      permissions={permissions}
      questions={questions}
      onPermissionDecision={(requestId: string, _decision: AskDockDecision) => {
        setPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
      }}
      onQuestionAnswer={(requestId: string, values: string[]) => {
        void values;
        setQuestions((prev) => prev.filter((q) => q.requestId !== requestId));
      }}
    />
  );
}

describe("AskDock", () => {
  it("renders nothing when nothing is pending", () => {
    const { container } = render(<AskDock
      permissions={[]}
      questions={[]}
      onPermissionDecision={vi.fn()}
      onQuestionAnswer={vi.fn()}
    />);
    expect(container.firstChild).toBeNull();
  });

  it("shows exactly one card plus an 'n of m' counter for queued items", () => {
    render(<Harness initialPermissions={[permA, permB]} initialQuestions={[questionA]} />);

    // First permission is fully rendered…
    expect(screen.getByText(/file_delete/)).toBeTruthy();
    expect(screen.getByText(/delete a file/)).toBeTruthy();
    // …with full-width decision rows.
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow always this session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();

    // The counter shows the queue depth; queued items are hidden.
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.queryByText(/shell_exec/)).toBeNull();
    expect(screen.queryByText(/Which framework/)).toBeNull();
  });

  it("shows a compact monospace preview of the pending input", () => {
    render(<Harness initialPermissions={[permB]} initialQuestions={[]} />);
    expect(screen.getByText(/\$ rm -rf \/tmp\/b/)).toBeTruthy();
  });

  it("answering a permission reveals the next queued permission and updates the counter", () => {
    render(<Harness initialPermissions={[permA, permB]} initialQuestions={[questionA]} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    // Second permission surfaces immediately; counter decremented.
    expect(screen.getByText(/shell_exec/)).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.queryByText(/file_delete/)).toBeNull();
  });

  it("questions queue behind permissions and surface once permissions clear", () => {
    render(<Harness initialPermissions={[permA]} initialQuestions={[questionA]} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow always this session" }));

    // Question card now visible with its selectable option rows.
    expect(screen.getByText("Which framework should I use?")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "React" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });

  it("a lone item renders without a counter", () => {
    render(<Harness initialPermissions={[permA]} initialQuestions={[]} />);
    expect(screen.queryByText(/ of /)).toBeNull();
  });
});
