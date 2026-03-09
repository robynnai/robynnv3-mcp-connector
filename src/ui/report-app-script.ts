export const REPORT_APP_SCRIPT = String.raw`
(() => {
  const configNode = document.getElementById('__robynn-report-config');
  const root = document.getElementById('robynn-report-root');
  const config = configNode ? JSON.parse(configNode.textContent || '{}') : {};

  const state = {
    hostContext: null,
    toolArgs: null,
    result: null,
    loading: false,
    error: null,
    filters: {
      geoModel: 'all',
      seoSort: 'opportunity_score',
      battlecardTab: 'comparison',
    },
  };

  let requestId = 1;
  const pending = new Map();

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function applyHostContext() {
    const hostContext = state.hostContext || {};
    if (hostContext.theme) {
      document.documentElement.setAttribute('data-theme', hostContext.theme);
      document.documentElement.style.colorScheme = hostContext.theme;
    }

    const variables = hostContext.styles && hostContext.styles.variables;
    if (isObject(variables)) {
      Object.entries(variables).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          document.documentElement.style.setProperty(key, String(value));
        }
      });
    }

    const hostFonts = hostContext.styles && hostContext.styles.css && hostContext.styles.css.fonts;
    if (hostFonts && !document.getElementById('__robynn-host-fonts')) {
      const style = document.createElement('style');
      style.id = '__robynn-host-fonts';
      style.textContent = hostFonts;
      document.head.appendChild(style);
    }
  }

  function postMessage(message) {
    window.parent.postMessage(message, '*');
  }

  function request(method, params) {
    const id = requestId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      postMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  function notify(method, params) {
    postMessage({ jsonrpc: '2.0', method, params });
  }

  function extractText(content) {
    if (!Array.isArray(content)) return '';
    return content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
  }

  function tryParseTextResult(result) {
    const text = extractText(result && result.content);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function applyCallResult(result) {
    state.loading = false;

    if (result && result.isError) {
      state.error = extractText(result.content) || 'The report request failed.';
      state.result = null;
      render();
      return;
    }

    const structured = result && result.structuredContent
      ? result.structuredContent
      : tryParseTextResult(result);

    if (!structured) {
      state.error = 'The report returned no structured data.';
      state.result = null;
      render();
      return;
    }

    state.error = null;
    state.result = structured;
    render();
  }

  function normalizeList(value) {
    if (Array.isArray(value)) return value.filter(Boolean).map(String);
    return [];
  }

  function normalizeObjectArray(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => isObject(item));
  }

  function formatNumber(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return '—';
    return new Intl.NumberFormat().format(value);
  }

  function summaryValue(label, value, tone) {
    return '<div class="summary-card' + (tone ? ' tone-' + tone : '') + '">' +
      '<div class="summary-label">' + escapeHtml(label) + '</div>' +
      '<div class="summary-value">' + escapeHtml(value) + '</div>' +
    '</div>';
  }

  function recommendedActions(actions) {
    const items = Array.isArray(actions) ? actions : [];
    if (!items.length) {
      return '<div class="empty-state">No recommended actions were returned for this run.</div>';
    }

    return '<div class="action-grid">' + items.map((action) => {
      const priority = action && action.priority ? '<span class="pill">' + escapeHtml(action.priority) + '</span>' : '';
      const rationale = action && action.rationale ? '<p>' + escapeHtml(action.rationale) + '</p>' : '';
      return '<article class="action-card">' +
        '<div class="action-title-row"><h4>' + escapeHtml(action && action.title ? action.title : 'Recommended action') + '</h4>' + priority + '</div>' +
        rationale +
      '</article>';
    }).join('') + '</div>';
  }

  function renderGeoReport(result) {
    const scores = normalizeObjectArray(result && result.visibility_scores);
    const selectedModel = state.filters.geoModel === 'all'
      ? null
      : scores.find((score) => score && score.llm === state.filters.geoModel) || null;

    const breakdown = result && isObject(result.citation_breakdown) ? result.citation_breakdown : {};
    const queryGaps = Array.isArray(result && result.query_gaps) ? result.query_gaps : [];

    const cards = scores.length
      ? '<div class="score-grid">' + scores.map((score) => {
          const llm = score && score.llm ? String(score.llm) : 'Unknown';
          const active = state.filters.geoModel === llm ? ' active' : '';
          return '<button class="score-card' + active + '" type="button" data-geo-model="' + escapeHtml(llm) + '">' +
            '<span class="score-label">' + escapeHtml(llm) + '</span>' +
            '<span class="score-value">' + escapeHtml(String(score && score.score !== undefined ? score.score : '—')) + '</span>' +
            '<span class="score-subtle">' + escapeHtml(formatNumber(score && score.citations)) + ' citations</span>' +
          '</button>';
        }).join('') + '</div>'
      : '<div class="empty-state">No visibility scores were returned.</div>';

    const selectedDetails = selectedModel
      ? '<div class="detail-card"><h4>' + escapeHtml(selectedModel.llm) + ' details</h4>' +
          '<div class="detail-row"><span>Mentions</span><strong>' + escapeHtml(formatNumber(selectedModel.mentions)) + '</strong></div>' +
          '<div class="detail-row"><span>Citations</span><strong>' + escapeHtml(formatNumber(selectedModel.citations)) + '</strong></div>' +
          '<div class="detail-row"><span>Visibility score</span><strong>' + escapeHtml(String(selectedModel.score ?? '—')) + '</strong></div>' +
        '</div>'
      : '';

    const gapItems = queryGaps.length
      ? '<div class="list-stack">' + queryGaps.map((gap) => {
          return '<article class="list-card">' +
            '<h4>' + escapeHtml(gap && gap.query ? gap.query : 'Untitled query gap') + '</h4>' +
            (gap && gap.gap_type ? '<div class="muted">' + escapeHtml(gap.gap_type) + '</div>' : '') +
            (gap && gap.detail ? '<p>' + escapeHtml(gap.detail) + '</p>' : '') +
          '</article>';
        }).join('') + '</div>'
      : '<div class="empty-state">No query gaps were identified.</div>';

    return '<section class="report-section">' +
        '<div class="section-head"><h3>Visibility by model</h3><button type="button" class="ghost-button" data-geo-model="all">Show all</button></div>' +
        cards +
        selectedDetails +
      '</section>' +
      '<section class="report-section">' +
        '<div class="section-head"><h3>Citation mix</h3></div>' +
        '<div class="summary-grid">' +
          summaryValue('Your brand', formatNumber(breakdown.target_company), 'success') +
          summaryValue('Competitors', formatNumber(breakdown.competitor), 'warning') +
          summaryValue('Other sources', formatNumber(breakdown.other), 'neutral') +
        '</div>' +
      '</section>' +
      '<section class="report-section">' +
        '<div class="section-head"><h3>Query gaps</h3></div>' +
        gapItems +
      '</section>';
  }

  function compareOpportunity(a, b, field) {
    const left = typeof (a && a[field]) === 'number' ? a[field] : -Infinity;
    const right = typeof (b && b[field]) === 'number' ? b[field] : -Infinity;
    return right - left;
  }

  function renderSeoReport(result) {
    const opportunities = Array.isArray(result && result.opportunities) ? [...result.opportunities] : [];
    const keywordGaps = Array.isArray(result && result.keyword_gaps) ? result.keyword_gaps : [];
    const comparison = Array.isArray(result && result.competitor_comparison) ? result.competitor_comparison : [];

    opportunities.sort((left, right) => compareOpportunity(left, right, state.filters.seoSort));

    const opportunityRows = opportunities.length
      ? '<div class="table-shell"><table><thead><tr><th>Keyword</th><th>Opportunity</th><th>Volume</th><th>Difficulty</th><th>Competitor rank</th></tr></thead><tbody>' +
          opportunities.map((item) => {
            return '<tr>' +
              '<td>' + escapeHtml(item && item.keyword ? item.keyword : 'Untitled') + '</td>' +
              '<td>' + escapeHtml(formatNumber(item && item.opportunity_score)) + '</td>' +
              '<td>' + escapeHtml(formatNumber(item && item.search_volume)) + '</td>' +
              '<td>' + escapeHtml(formatNumber(item && item.difficulty)) + '</td>' +
              '<td>' + escapeHtml(formatNumber(item && item.competitor_rank)) + '</td>' +
            '</tr>';
          }).join('') +
        '</tbody></table></div>'
      : '<div class="empty-state">No SEO opportunities were returned.</div>';

    const gapCards = keywordGaps.length
      ? '<div class="list-stack">' + keywordGaps.map((item) => {
          return '<article class="list-card">' +
            '<h4>' + escapeHtml(item && item.keyword ? item.keyword : 'Untitled keyword') + '</h4>' +
            '<div class="meta-row">' +
              '<span>Opportunity ' + escapeHtml(formatNumber(item && item.opportunity_score)) + '</span>' +
              '<span>Volume ' + escapeHtml(formatNumber(item && item.search_volume)) + '</span>' +
              '<span>Difficulty ' + escapeHtml(formatNumber(item && item.difficulty)) + '</span>' +
            '</div>' +
          '</article>';
        }).join('') + '</div>'
      : '<div class="empty-state">No keyword gaps were identified.</div>';

    const comparisonCards = comparison.length
      ? '<div class="comparison-grid">' + comparison.map((item) => {
          const entries = isObject(item)
            ? Object.entries(item)
                .filter(([key]) => key !== 'competitor')
                .map(([key, value]) => '<div class="detail-row"><span>' + escapeHtml(key) + '</span><strong>' + escapeHtml(formatNumber(typeof value === 'number' ? value : value)) + '</strong></div>')
                .join('')
            : '';
          const label = item && item.competitor ? item.competitor : 'Competitor';
          return '<article class="detail-card"><h4>' + escapeHtml(label) + '</h4>' + entries + '</article>';
        }).join('') + '</div>'
      : '<div class="empty-state">No competitor comparison data was returned.</div>';

    return '<section class="report-section">' +
        '<div class="section-head"><h3>Opportunity leaderboard</h3>' +
          '<label class="inline-control">Sort by ' +
            '<select id="seo-sort">' +
              '<option value="opportunity_score"' + (state.filters.seoSort === 'opportunity_score' ? ' selected' : '') + '>Opportunity score</option>' +
              '<option value="search_volume"' + (state.filters.seoSort === 'search_volume' ? ' selected' : '') + '>Search volume</option>' +
              '<option value="difficulty"' + (state.filters.seoSort === 'difficulty' ? ' selected' : '') + '>Difficulty</option>' +
            '</select>' +
          '</label>' +
        '</div>' +
        opportunityRows +
      '</section>' +
      '<section class="report-section">' +
        '<div class="section-head"><h3>Keyword gaps</h3></div>' +
        gapCards +
      '</section>' +
      '<section class="report-section">' +
        '<div class="section-head"><h3>Competitor comparison</h3></div>' +
        comparisonCards +
      '</section>';
  }

  function renderBattlecardReport(result) {
    const tabs = [
      { id: 'comparison', label: 'Comparison' },
      { id: 'objections', label: 'Objections' },
      { id: 'differentiators', label: 'Differentiators' },
      { id: 'risks', label: 'Risks' },
    ];

    const selectedTab = tabs.some((tab) => tab.id === state.filters.battlecardTab)
      ? state.filters.battlecardTab
      : 'comparison';

    const tabsHtml = '<div class="tab-row">' + tabs.map((tab) => {
      const active = selectedTab === tab.id ? ' active' : '';
      return '<button class="tab-button' + active + '" type="button" data-battlecard-tab="' + escapeHtml(tab.id) + '">' + escapeHtml(tab.label) + '</button>';
    }).join('') + '</div>';

    let body = '';
    if (selectedTab === 'comparison') {
      const sections = Array.isArray(result && result.comparison) ? result.comparison : [];
      body = sections.length
        ? '<div class="list-stack">' + sections.map((section) => {
            const bullets = normalizeList(section && section.bullets);
            return '<article class="list-card"><h4>' + escapeHtml(section && section.title ? section.title : 'Comparison area') + '</h4><ul class="bullet-list">' +
              bullets.map((bullet) => '<li>' + escapeHtml(bullet) + '</li>').join('') +
            '</ul></article>';
          }).join('') + '</div>'
        : '<div class="empty-state">No comparison sections were returned.</div>';
    } else {
      const items = normalizeList(result && result[selectedTab]);
      body = items.length
        ? '<div class="list-stack">' + items.map((item) => '<article class="list-card"><p>' + escapeHtml(item) + '</p></article>').join('') + '</div>'
        : '<div class="empty-state">No ' + escapeHtml(selectedTab) + ' were returned.</div>';
    }

    return '<section class="report-section">' +
      '<div class="section-head"><h3>Battlecard views</h3></div>' +
      tabsHtml +
      body +
    '</section>';
  }

  function buildGeoForm(args) {
    const questions = normalizeList(args && args.questions).join('\n');
    const competitors = normalizeList(args && args.competitors).join('\n');
    const analysisDepth = args && args.analysis_depth ? args.analysis_depth : 'standard';
    return '<div class="form-grid">' +
      '<label><span>Company name</span><input name="company_name" value="' + escapeHtml(args && args.company_name ? args.company_name : '') + '" required /></label>' +
      '<label><span>Category</span><input name="category" value="' + escapeHtml(args && args.category ? args.category : '') + '" /></label>' +
      '<label><span>Analysis depth</span><select name="analysis_depth">' +
        '<option value="standard"' + (analysisDepth === 'standard' ? ' selected' : '') + '>Standard</option>' +
        '<option value="deep"' + (analysisDepth === 'deep' ? ' selected' : '') + '>Deep</option>' +
      '</select></label>' +
      '<label class="full"><span>Questions (one per line)</span><textarea name="questions">' + escapeHtml(questions) + '</textarea></label>' +
      '<label class="full"><span>Competitors (one per line)</span><textarea name="competitors">' + escapeHtml(competitors) + '</textarea></label>' +
    '</div>';
  }

  function buildSeoForm(args) {
    const competitors = normalizeList(args && args.competitors).join('\n');
    const keywords = normalizeList(args && args.keywords).join('\n');
    return '<div class="form-grid">' +
      '<label><span>Company name</span><input name="company_name" value="' + escapeHtml(args && args.company_name ? args.company_name : '') + '" required /></label>' +
      '<label><span>Company URL</span><input name="company_url" value="' + escapeHtml(args && args.company_url ? args.company_url : '') + '" /></label>' +
      '<label class="full"><span>Competitors (one per line)</span><textarea name="competitors">' + escapeHtml(competitors) + '</textarea></label>' +
      '<label class="full"><span>Keywords (one per line)</span><textarea name="keywords">' + escapeHtml(keywords) + '</textarea></label>' +
      '<label class="full"><span>Market context</span><textarea name="market_context">' + escapeHtml(args && args.market_context ? args.market_context : '') + '</textarea></label>' +
    '</div>';
  }

  function buildBattlecardForm(args) {
    const focusAreas = normalizeList(args && args.focus_areas).join('\n');
    return '<div class="form-grid">' +
      '<label><span>Competitor</span><input name="competitor_name" value="' + escapeHtml(args && args.competitor_name ? args.competitor_name : '') + '" required /></label>' +
      '<label><span>Company name</span><input name="company_name" value="' + escapeHtml(args && args.company_name ? args.company_name : '') + '" /></label>' +
      '<label class="full"><span>Focus areas (one per line)</span><textarea name="focus_areas">' + escapeHtml(focusAreas) + '</textarea></label>' +
      '<label class="checkbox-row"><input type="checkbox" name="include_objections"' + (args && args.include_objections ? ' checked' : '') + ' /><span>Include objection handling</span></label>' +
    '</div>';
  }

  function renderRerunForm() {
    const args = state.toolArgs || {};
    let body = '';
    if (config.reportType === 'geo') {
      body = buildGeoForm(args);
    } else if (config.reportType === 'seo') {
      body = buildSeoForm(args);
    } else {
      body = buildBattlecardForm(args);
    }

    return '<section class="report-section">' +
      '<div class="section-head"><h3>Rerun this report</h3><button type="button" class="ghost-button" id="request-fullscreen">Expand</button></div>' +
      '<form id="rerun-form">' +
        body +
        '<div class="form-actions"><button class="primary-button" type="submit">' + (state.loading ? 'Running…' : 'Run updated report') + '</button></div>' +
      '</form>' +
    '</section>';
  }

  function parseLines(value) {
    return String(value || '')
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function getFormArguments() {
    const form = document.getElementById('rerun-form');
    if (!form) return {};
    const formData = new FormData(form);

    if (config.reportType === 'geo') {
      return {
        company_name: String(formData.get('company_name') || '').trim(),
        category: String(formData.get('category') || '').trim() || undefined,
        analysis_depth: String(formData.get('analysis_depth') || 'standard'),
        questions: parseLines(formData.get('questions')),
        competitors: parseLines(formData.get('competitors')),
      };
    }

    if (config.reportType === 'seo') {
      return {
        company_name: String(formData.get('company_name') || '').trim(),
        company_url: String(formData.get('company_url') || '').trim() || undefined,
        competitors: parseLines(formData.get('competitors')),
        keywords: parseLines(formData.get('keywords')),
        market_context: String(formData.get('market_context') || '').trim() || undefined,
      };
    }

    return {
      competitor_name: String(formData.get('competitor_name') || '').trim(),
      company_name: String(formData.get('company_name') || '').trim() || undefined,
      focus_areas: parseLines(formData.get('focus_areas')),
      include_objections: formData.get('include_objections') === 'on',
    };
  }

  function topSummary() {
    const result = state.result || {};
    const status = result && result.status ? String(result.status) : 'pending';
    const artifacts = result && isObject(result.artifacts) ? result.artifacts : {};
    const artifactCount = Object.keys(artifacts).length;

    return '<section class="hero-card">' +
      '<div class="hero-meta"><span class="eyebrow">Robynn intelligence report</span><span class="status-badge">' + escapeHtml(status) + '</span></div>' +
      '<h1>' + escapeHtml(config.title || 'Robynn report') + '</h1>' +
      '<p class="hero-summary">' + escapeHtml(result && result.summary ? result.summary : 'Waiting for report results…') + '</p>' +
      '<div class="summary-grid">' +
        summaryValue('Report type', config.reportType ? String(config.reportType).toUpperCase() : 'Report', 'neutral') +
        summaryValue('Artifacts', formatNumber(artifactCount), 'neutral') +
        summaryValue('Actions', formatNumber(Array.isArray(result && result.recommended_actions) ? result.recommended_actions.length : 0), 'neutral') +
      '</div>' +
    '</section>';
  }

  function reportBody() {
    if (state.error) {
      return '<section class="report-section"><div class="error-card"><h3>Report unavailable</h3><p>' + escapeHtml(state.error) + '</p></div></section>';
    }

    if (!state.result) {
      return '<section class="report-section"><div class="empty-state">Run a report from Claude to see the interactive view here.</div></section>';
    }

    if (config.reportType === 'geo') return renderGeoReport(state.result);
    if (config.reportType === 'seo') return renderSeoReport(state.result);
    return renderBattlecardReport(state.result);
  }

  function render() {
    if (!root) return;
    root.innerHTML = topSummary() + renderRerunForm() + reportBody() +
      '<section class="report-section"><div class="section-head"><h3>Recommended actions</h3></div>' +
      recommendedActions(state.result && state.result.recommended_actions) +
      '</section>';

    bindEvents();
  }

  function bindEvents() {
    const form = document.getElementById('rerun-form');
    if (form) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        state.loading = true;
        state.error = null;
        render();

        try {
          const args = getFormArguments();
          state.toolArgs = args;
          const result = await request('tools/call', {
            name: config.toolName,
            arguments: args,
          });
          applyCallResult(result);
        } catch (error) {
          state.loading = false;
          state.error = error instanceof Error ? error.message : 'The report could not be rerun.';
          render();
        }
      });
    }

    const sortControl = document.getElementById('seo-sort');
    if (sortControl) {
      sortControl.addEventListener('change', (event) => {
        state.filters.seoSort = event.target.value;
        render();
      });
    }

    root.querySelectorAll('[data-geo-model]').forEach((button) => {
      button.addEventListener('click', () => {
        state.filters.geoModel = button.getAttribute('data-geo-model') || 'all';
        render();
      });
    });

    root.querySelectorAll('[data-battlecard-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        state.filters.battlecardTab = button.getAttribute('data-battlecard-tab') || 'comparison';
        render();
      });
    });

    const fullscreenButton = document.getElementById('request-fullscreen');
    if (fullscreenButton) {
      fullscreenButton.addEventListener('click', async () => {
        try {
          await request('ui/request-display-mode', { mode: 'fullscreen' });
        } catch {
          /* Ignore hosts that do not support display mode changes. */
        }
      });
    }
  }

  function handleHostMessage(message) {
    if (!message || message.jsonrpc !== '2.0') return;

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const callbacks = pending.get(message.id);
      if (!callbacks) return;
      pending.delete(message.id);
      if (message.error) {
        callbacks.reject(new Error(message.error.message || 'Request failed'));
        return;
      }
      callbacks.resolve(message.result);
      return;
    }

    if (message.method === 'ui/notifications/tool-input') {
      state.loading = true;
      state.toolArgs = message.params && isObject(message.params.arguments)
        ? message.params.arguments
        : {};
      render();
      return;
    }

    if (message.method === 'ui/notifications/tool-result') {
      applyCallResult(message.params);
      return;
    }

    if (message.method === 'ui/notifications/tool-cancelled') {
      state.loading = false;
      state.error = message.params && message.params.reason
        ? String(message.params.reason)
        : 'This report run was cancelled.';
      render();
      return;
    }

    if (message.method === 'ui/notifications/host-context-changed') {
      state.hostContext = Object.assign({}, state.hostContext || {}, message.params || {});
      applyHostContext();
      render();
    }
  }

  async function connect() {
    window.addEventListener('message', (event) => handleHostMessage(event.data));

    try {
      const init = await request('ui/initialize', {
        appInfo: { name: 'Robynn Report App', version: '0.1.0' },
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
        protocolVersion: '2026-01-26',
      });

      state.hostContext = init && init.hostContext ? init.hostContext : null;
      applyHostContext();
      notify('ui/notifications/initialized', {});

      if (window.ResizeObserver) {
        let pendingResize = false;
        const sendSize = () => {
          if (pendingResize) return;
          pendingResize = true;
          window.requestAnimationFrame(() => {
            pendingResize = false;
            const rect = document.documentElement.getBoundingClientRect();
            notify('ui/notifications/size-changed', {
              width: Math.ceil(rect.width),
              height: Math.ceil(rect.height),
            });
          });
        };

        const observer = new ResizeObserver(sendSize);
        observer.observe(document.documentElement);
        observer.observe(document.body);
        sendSize();
      }

      state.loading = false;
      render();
    } catch (error) {
      state.loading = false;
      state.error = error instanceof Error ? error.message : 'Failed to initialize the Robynn report app.';
      render();
    }
  }

  render();
  connect();
})();
`;
