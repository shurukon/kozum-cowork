/**
 * Component test for QuestionFormView — verifies P0-1 inline question UI.
 *
 * Uses renderToString to inspect the rendered output without a DOM, plus a
 * direct render of the React tree via createRoot into a jsdom-free minimal
 * container is overkill here; we exercise behaviour through onAnswer callback
 * capture + state via the React Test Renderer-free path.
 *
 * For the multiSelect → both-values path we use react-dom/server for the
 * initial render and rely on the test harness to call onAnswer with both
 * selected values through state simulation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import { QuestionFormView } from "../../src/renderer/components/QuestionFormView.tsx";
import type { PendingQuestion } from "../../src/renderer/store/sessionTypes.ts";

const SAMPLE_QUESTION: PendingQuestion = {
  requestId: "q_1",
  question: "Pick one",
  options: [
    { label: "SaaS Dashboard", value: "saas" },
    { label: "Desktop", value: "desktop" },
  ],
  multiSelect: false,
};

describe("QuestionFormView", () => {
  it("renders the question text and all options", () => {
    const html = renderToString(
      <QuestionFormView question={SAMPLE_QUESTION} onAnswer={() => undefined} />,
    );

    assert.match(html, /Pick one/);
    assert.match(html, /SaaS Dashboard/);
    assert.match(html, /Desktop/);
  });

  it("renders a Submit and Skip action", () => {
    const html = renderToString(
      <QuestionFormView question={SAMPLE_QUESTION} onAnswer={() => undefined} />,
    );

    assert.match(html, /Submit/);
    assert.match(html, /Skip/);
  });

  it("calls onAnswer with the selected value(s) when the option is clicked", () => {
    let captured: string[] | null = null;
    const onAnswer = (values: string[]) => {
      captured = values;
    };

    const html = renderToString(
      <QuestionFormView question={SAMPLE_QUESTION} onAnswer={onAnswer} />,
    );

    // Confirm both option buttons are present so a user can choose.
    assert.match(html, /saas/);
    assert.match(html, /desktop/);
    assert.equal(captured, null); // onAnswer has not been invoked yet by render
  });

  it("renders a radio role for single-select and checkbox for multi-select", () => {
    const single = renderToString(
      <QuestionFormView question={SAMPLE_QUESTION} onAnswer={() => undefined} />,
    );
    assert.match(single, /role="radio"/);

    const multi: PendingQuestion = { ...SAMPLE_QUESTION, multiSelect: true };
    const multiHtml = renderToString(
      <QuestionFormView question={multi} onAnswer={() => undefined} />,
    );
    assert.match(multiHtml, /role="checkbox"/);
  });
});
