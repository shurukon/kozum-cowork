import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Message } from "../../src/renderer/components/Message.tsx";

describe("user message actions", () => {
  it("passes the exact message id and text to retry", () => {
    const onRetryMessage = vi.fn();
    render(
      <Message
        mode="cowork"
        message={{
          id: "user-turn-42",
          role: "user",
          content: [{ type: "text", text: "retry this request" }],
          createdAt: 0,
        }}
        isStreaming={false}
        toolCards={new Map()}
        onRetryMessage={onRetryMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry message" }));
    expect(onRetryMessage).toHaveBeenCalledWith("user-turn-42", "retry this request");
  });

  it("keeps edit and retry controls separated on the right edge", () => {
    render(
      <Message
        mode="code"
        message={{
          id: "user-turn-43",
          role: "user",
          content: [{ type: "text", text: "edit this request" }],
          createdAt: 0,
        }}
        isStreaming={false}
        toolCards={new Map()}
        onEditMessage={() => undefined}
        onRetryMessage={() => undefined}
      />,
    );

    const actions = screen.getByLabelText("Message actions");
    expect(actions.className).toMatch(/userMessageActions/);
    expect(screen.getByRole("button", { name: "Edit message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry message" })).toBeInTheDocument();
  });
});
