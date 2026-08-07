export function renderCmoAguiBlocks(blocks: Array<Record<string, unknown>>): {
  html: string;
  skippedTypes: string[];
} {
  function escapeHtml(value: unknown): string {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function asString(value: unknown): string {
    return value === null || value === undefined ? "" : String(value);
  }

  function blockTitle(block: Record<string, unknown>): string {
    return block.title ? `<h4>${escapeHtml(block.title)}</h4>` : "";
  }

  function renderTable(block: Record<string, unknown>): string {
    const columns = Array.isArray(block.columns)
      ? block.columns.filter((column) => column && typeof column === "object")
      : [];
    const rows = Array.isArray(block.rows) ? block.rows : [];
    const header =
      columns.length > 0
        ? `<thead><tr>${columns
            .map((column) => {
              const col = column as Record<string, unknown>;
              return `<th>${escapeHtml(col.label ?? col.key ?? "")}</th>`;
            })
            .join("")}</tr></thead>`
        : "";
    const body = rows
      .map((row) => {
        if (!row || typeof row !== "object") return "";
        const record = row as Record<string, unknown>;
        return `<tr>${columns
          .map((column) => {
            const col = column as Record<string, unknown>;
            const key = asString(col.key);
            return `<td>${escapeHtml(record[key])}</td>`;
          })
          .join("")}</tr>`;
      })
      .join("");
    const footer = block.footer
      ? `<p class="muted">${escapeHtml(block.footer)}</p>`
      : "";

    return (
      `<article class="list-card agui-block agui-table">` +
      blockTitle(block) +
      `<div class="table-shell"><table>${header}<tbody>${body}</tbody></table></div>` +
      footer +
      `</article>`
    );
  }

  function renderChart(block: Record<string, unknown>): string {
    const data = Array.isArray(block.data) ? block.data : [];
    const chartType = asString(block.chartType || "bar");
    const bars = data
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const point = item as Record<string, unknown>;
        const value = typeof point.value === "number" ? point.value : Number(point.value) || 0;
        const width = Math.max(4, Math.min(100, value));
        return (
          `<div class="detail-row">` +
          `<span>${escapeHtml(point.label)}</span>` +
          `<strong>${escapeHtml(value)}</strong>` +
          `<div style="height:8px;border-radius:999px;background:var(--robynn-accent-soft);margin-top:6px;">` +
          `<div style="width:${width}%;max-width:100%;height:100%;border-radius:999px;background:var(--robynn-accent);"></div>` +
          `</div>` +
          `</div>`
        );
      })
      .join("");
    const caption = block.caption
      ? `<p class="muted">${escapeHtml(block.caption)}</p>`
      : "";

    return (
      `<article class="detail-card agui-block agui-chart">` +
      blockTitle(block) +
      `<div class="pill">${escapeHtml(chartType)}</div>` +
      `<div class="list-stack">${bars || '<div class="empty-state">No chart data.</div>'}</div>` +
      caption +
      `</article>`
    );
  }

  function renderMetric(block: Record<string, unknown>): string {
    const trend = block.trend ? `<span class="pill">${escapeHtml(block.trend)}</span>` : "";
    const trendValue = block.trendValue
      ? `<span class="muted">${escapeHtml(block.trendValue)}</span>`
      : "";
    const unit = block.unit ? `<span class="muted">${escapeHtml(block.unit)}</span>` : "";

    return (
      `<article class="summary-card agui-block agui-metric">` +
      `<div class="summary-label">${escapeHtml(block.label)}</div>` +
      `<div class="summary-value">${escapeHtml(block.value)} ${unit}</div>` +
      `<div class="meta-row">${trend}${trendValue}</div>` +
      `</article>`
    );
  }

  function renderPriorityList(block: Record<string, unknown>): string {
    const items = Array.isArray(block.items) ? block.items : [];
    const list = items
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const entry = item as Record<string, unknown>;
        const priority = entry.priority
          ? `<span class="pill">${escapeHtml(entry.priority)}</span>`
          : "";
        const status = entry.status
          ? `<span class="muted">${escapeHtml(entry.status)}</span>`
          : "";
        const description = entry.description
          ? `<p>${escapeHtml(entry.description)}</p>`
          : "";
        return (
          `<article class="action-card">` +
          `<div class="action-title-row"><h4>${escapeHtml(entry.label)}</h4>${priority}</div>` +
          `<div class="meta-row">${status}</div>` +
          description +
          `</article>`
        );
      })
      .join("");

    return (
      `<section class="agui-block agui-priority-list">` +
      blockTitle(block) +
      `<div class="list-stack">${list || '<div class="empty-state">No priority items.</div>'}</div>` +
      `</section>`
    );
  }

  function renderProgress(block: Record<string, unknown>): string {
    const stages = Array.isArray(block.stages) ? block.stages : [];
    const pipeline = stages
      .map((stage) => {
        if (!stage || typeof stage !== "object") return "";
        const entry = stage as Record<string, unknown>;
        const status = asString(entry.status || "pending");
        const detail = entry.detail ? `<p class="muted">${escapeHtml(entry.detail)}</p>` : "";
        return (
          `<article class="detail-card">` +
          `<div class="action-title-row"><h4>${escapeHtml(entry.label)}</h4><span class="pill">${escapeHtml(status)}</span></div>` +
          detail +
          `</article>`
        );
      })
      .join("");

    return (
      `<section class="agui-block agui-progress-pipeline">` +
      blockTitle(block) +
      `<div class="list-stack">${pipeline || '<div class="empty-state">No pipeline stages.</div>'}</div>` +
      `</section>`
    );
  }

  function renderChecklist(block: Record<string, unknown>): string {
    const items = Array.isArray(block.items) ? block.items : [];
    const list = items
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const entry = item as Record<string, unknown>;
        const checked = Boolean(entry.checked);
        const priority = entry.priority
          ? `<span class="pill">${escapeHtml(entry.priority)}</span>`
          : "";
        const detail = entry.detail ? `<p class="muted">${escapeHtml(entry.detail)}</p>` : "";
        return (
          `<article class="list-card">` +
          `<div class="action-title-row"><h4>${checked ? "✓ " : "○ "}${escapeHtml(entry.label)}</h4>${priority}</div>` +
          detail +
          `</article>`
        );
      })
      .join("");

    return (
      `<section class="agui-block agui-status-checklist">` +
      blockTitle(block) +
      `<div class="list-stack">${list || '<div class="empty-state">No checklist items.</div>'}</div>` +
      `</section>`
    );
  }

  function renderDecisionCard(block: Record<string, unknown>): string {
    const options = Array.isArray(block.options) ? block.options : [];
    const optionList = options
      .map((option) => {
        if (!option || typeof option !== "object") return "";
        const entry = option as Record<string, unknown>;
        const description = entry.description
          ? `<p class="muted">${escapeHtml(entry.description)}</p>`
          : "";
        return (
          `<article class="detail-card">` +
          `<h4>${escapeHtml(entry.label)}</h4>` +
          description +
          `</article>`
        );
      })
      .join("");

    return (
      `<section class="agui-block agui-decision-card">` +
      `<div class="section-head"><h3>${escapeHtml(block.question)}</h3><span class="pill">Read-only</span></div>` +
      `<p class="muted">Decision cards are shown for context. Continue the conversation in chat to choose an option.</p>` +
      `<div class="list-stack">${optionList}</div>` +
      `</section>`
    );
  }

  const parts: string[] = [];
  const skippedTypes: string[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      skippedTypes.push("unknown");
      continue;
    }

    switch (block.type) {
      case "table":
        parts.push(renderTable(block));
        break;
      case "chart":
        parts.push(renderChart(block));
        break;
      case "metric_card":
        parts.push(renderMetric(block));
        break;
      case "priority_list":
        parts.push(renderPriorityList(block));
        break;
      case "progress_pipeline":
        parts.push(renderProgress(block));
        break;
      case "status_checklist":
        parts.push(renderChecklist(block));
        break;
      case "decision_card":
        parts.push(renderDecisionCard(block));
        break;
      default:
        skippedTypes.push(asString(block.type || "unknown"));
    }
  }

  if (skippedTypes.length) {
    parts.push(
      `<p class="muted">Skipped: ${skippedTypes.length} unsupported block(s)</p>`,
    );
  }

  return { html: parts.join("\n"), skippedTypes };
}
