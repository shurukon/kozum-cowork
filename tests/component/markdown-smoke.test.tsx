import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "../../src/renderer/components/Markdown.tsx";

describe("Markdown component smoke", () => {
  it("renders a paragraph", () => {
    render(<Markdown content="hello world" />);
    expect(screen.getByText("hello world")).toBeTruthy();
  });
});
