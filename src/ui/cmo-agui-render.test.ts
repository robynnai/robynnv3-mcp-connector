import { describe, expect, it } from "vitest";

import { renderCmoAguiBlocks } from "./cmo-agui-render";

describe("renderCmoAguiBlocks", () => {
  it("renders table headers and rows", () => {
    const { html } = renderCmoAguiBlocks([
      {
        id: "t1",
        type: "table",
        columns: [{ key: "channel", label: "Channel" }],
        rows: [{ channel: "LinkedIn" }],
      },
    ]);

    expect(html).toContain("Channel");
    expect(html).toContain("LinkedIn");
  });

  it("renders chart, metric_card, priority_list, progress_pipeline, status_checklist", () => {
    const { html } = renderCmoAguiBlocks([
      {
        id: "c1",
        type: "chart",
        title: "Share",
        chartType: "bar",
        data: [{ label: "A", value: 10 }],
      },
      { id: "m1", type: "metric_card", label: "Score", value: 82 },
      {
        id: "p1",
        type: "priority_list",
        items: [{ id: "i1", label: "Fix CTA", priority: "high" }],
      },
      {
        id: "g1",
        type: "progress_pipeline",
        stages: [{ id: "s1", label: "Research", status: "active" }],
      },
      {
        id: "k1",
        type: "status_checklist",
        items: [{ id: "x1", label: "Brand voice loaded", checked: true }],
      },
    ]);

    expect(html).toContain("Share");
    expect(html).toContain("Score");
    expect(html).toContain("Fix CTA");
    expect(html).toContain("Research");
    expect(html).toContain("Brand voice loaded");
  });

  it("renders decision_card read-only and skips unknown types with footer count", () => {
    const { html, skippedTypes } = renderCmoAguiBlocks([
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
      { id: "u1", type: "tone_picker", options: [] },
    ]);

    expect(html).toContain("Which channel first?");
    expect(html).toContain("LinkedIn");
    expect(html).toContain("Read-only");
    expect(skippedTypes).toContain("tone_picker");
    expect(html).toMatch(/Skipped:\s*1/i);
  });

  it("escapes HTML in user-provided values", () => {
    const { html } = renderCmoAguiBlocks([
      {
        id: "t1",
        type: "table",
        columns: [{ key: "name", label: "Name" }],
        rows: [{ name: "<script>alert(1)</script>" }],
      },
    ]);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
