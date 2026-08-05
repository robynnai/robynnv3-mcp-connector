import { describe, expect, it } from "vitest";

import { buildCmoAguiTextFallback } from "./cmo-text";

describe("buildCmoAguiTextFallback", () => {
  it("lists decision questions when clarify_pending", () => {
    const text = buildCmoAguiTextFallback({
      output: "Need a quick choice.",
      clarify_pending: true,
      has_decision_cards: true,
      response_blocks: [
        {
          id: "d1",
          type: "decision_card",
          decisionId: "d1",
          question: "Which channel first?",
          options: [
            { id: "linkedin", label: "LinkedIn" },
            { id: "email", label: "Email" },
          ],
        },
      ],
    });
    expect(text).toContain("Which channel first?");
    expect(text).toContain("LinkedIn");
    expect(text).toContain("decision_card");
  });

  it("falls back to output when no blocks", () => {
    expect(
      buildCmoAguiTextFallback({
        output: "Launch plan ready.",
        clarify_pending: false,
        has_decision_cards: false,
        response_blocks: [],
      }),
    ).toBe("Launch plan ready.");
  });
});
