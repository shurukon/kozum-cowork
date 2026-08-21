import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuestionFormView } from "../../src/renderer/components/QuestionFormView.tsx";
import { PermissionBanner } from "../../src/renderer/components/PermissionBanner.tsx";
import type { PendingQuestion } from "../../src/renderer/store/sessionTypes.ts";

const freeformQuestion: PendingQuestion = {
  requestId: "question-1",
  question: "What should I call the project?",
  options: [],
  multiSelect: false,
  allowFreeform: true,
};

describe("QuestionFormView", () => {
  it("renders a freeform field and submits the user's answer", () => {
    const onAnswer = vi.fn();
    render(<QuestionFormView question={freeformQuestion} onAnswer={onAnswer} />);

    expect(screen.getByText("What should I call the project?")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Answer" });
    fireEvent.change(input, { target: { value: "Kozum workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onAnswer).toHaveBeenCalledOnce();
    expect(onAnswer).toHaveBeenCalledWith(["Kozum workspace"]);
    expect(screen.getByRole("status")).toHaveTextContent("Kozum workspace");
  });

  it("does not submit an empty freeform answer", () => {
    const onAnswer = vi.fn();
    render(<QuestionFormView question={freeformQuestion} onAnswer={onAnswer} />);

    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("PermissionBanner", () => {
  it("exposes the three session permission decisions", () => {
    const onDecision = vi.fn();
    render(
      <PermissionBanner
        toolName="shell_exec"
        reason="The agent wants to run a command."
        onDecision={onDecision}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow always" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(onDecision.mock.calls).toEqual([
      ["allow_once"],
      ["allow_always"],
      ["deny"],
    ]);
  });
});
