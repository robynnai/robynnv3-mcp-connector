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

  function renderFindingsCards(items, emptyMessage) {
    const findings = normalizeObjectArray(items);
    if (!findings.length) {
      return '<div class="empty-state">' + escapeHtml(emptyMessage) + '</div>';
    }

    return '<div class="list-stack">' + findings.map((item) => {
      const meta = [
        item && item.priority ? '<span>' + escapeHtml(item.priority) + '</span>' : '',
        item && item.page ? '<span>' + escapeHtml(item.page) + '</span>' : '',
      ].filter(Boolean).join('');

      return '<article class="list-card">' +
        '<h4>' + escapeHtml(item && item.title ? item.title : 'Finding') + '</h4>' +
        (meta ? '<div class="meta-row">' + meta + '</div>' : '') +
        (item && item.detail ? '<p>' + escapeHtml(item.detail) + '</p>' : '') +
        (item && item.evidence ? '<p class="muted">' + escapeHtml(item.evidence) + '</p>' : '') +
      '</article>';
    }).join('') + '</div>';
  }

  function renderSimpleListSection(title, items, emptyMessage) {
    const values = normalizeList(items);
    const body = values.length
      ? '<div class="list-stack">' + values.map((item) => '<article class="list-card"><p>' + escapeHtml(item) + '</p></article>').join('') + '</div>'
      : '<div class="empty-state">' + escapeHtml(emptyMessage) + '</div>';

    return '<section class="report-section">' +
      '<div class="section-head"><h3>' + escapeHtml(title) + '</h3></div>' +
      body +
    '</section>';
  }

  function renderBrandBookStatusReport(result) {
    const sections = normalizeObjectArray(result && result.sections);
    const missingItems = normalizeObjectArray(result && result.missing_items);

    const sectionCards = sections.length
      ? '<div class="score-grid">' + sections.map((section) => {
          const total = typeof section.total_items === 'number' ? section.total_items : 0;
          const completed = typeof section.completed_items === 'number' ? section.completed_items : 0;
          return '<article class="score-card">' +
            '<span class="score-label">' + escapeHtml(section && section.name ? section.name : 'Section') + '</span>' +
            '<span class="score-value">' + escapeHtml(total ? Math.round((completed / total) * 100) + '%' : '—') + '</span>' +
            '<span class="score-subtle">' + escapeHtml(completed + ' of ' + total + ' items complete') + '</span>' +
          '</article>';
        }).join('') + '</div>'
      : '<div class="empty-state">No brand-book sections were returned.</div>';

    return '<section class="report-section">' +
        '<div class="section-head"><h3>Brand-book coverage</h3></div>' +
        '<div class="summary-grid">' +
          summaryValue('Completeness', escapeHtml(String(result && result.completeness_score !== undefined ? result.completeness_score + '%' : '—')), 'success') +
          summaryValue('Sections', formatNumber(sections.length), 'neutral') +
          summaryValue('Missing items', formatNumber(missingItems.length), 'warning') +
        '</div>' +
        '<p class="hero-summary">' + escapeHtml(result && result.readiness_summary ? result.readiness_summary : 'No readiness summary was returned.') + '</p>' +
      '</section>' +
      '<section class="report-section">' +
        '<div class="section-head"><h3>Section health</h3></div>' +
        sectionCards +
      '</section>' +
      '<section class="report-section">' +
        '<div class="section-head"><h3>Missing items</h3></div>' +
        renderFindingsCards(missingItems.map((item) => ({
          title: item.item || 'Missing item',
          detail: item.detail,
          priority: item.priority,
          page: item.section,
        })), 'No missing brand-book items were returned.') +
      '</section>';
  }

  function renderBrandBookStrategyReport(result) {
    const priorities = normalizeObjectArray(result && result.strategic_priorities);
    const priorityCards = priorities.length
      ? '<div class="action-grid">' + priorities.map((item) => {
          return '<article class="action-card">' +
            '<div class="action-title-row"><h4>' + escapeHtml(item && item.title ? item.title : 'Priority') + '</h4>' +
            (item && item.priority ? '<span class="pill">' + escapeHtml(item.priority) + '</span>' : '') +
            '</div>' +
            (item && item.rationale ? '<p>' + escapeHtml(item.rationale) + '</p>' : '') +
          '</article>';
        }).join('') + '</div>'
      : '<div class="empty-state">No strategic priorities were returned.</div>';

    return '<section class="report-section">' +
        '<div class="section-head"><h3>Strategic priorities</h3></div>' +
        priorityCards +
      '</section>' +
      renderSimpleListSection('Positioning recommendations', result && result.positioning_recommendations, 'No positioning recommendations were returned.') +
      renderSimpleListSection('Voice recommendations', result && result.voice_recommendations, 'No voice recommendations were returned.') +
      renderSimpleListSection('Competitive recommendations', result && result.competitive_recommendations, 'No competitive recommendations were returned.') +
      renderSimpleListSection('Proof recommendations', result && result.proof_recommendations, 'No proof recommendations were returned.');
  }

  function renderWebsiteAuditReport(result) {
    return '<section class="report-section">' +
        '<div class="section-head"><h3>Website summary</h3></div>' +
        '<div class="summary-grid">' +
          summaryValue('Website', result && result.website_url ? result.website_url : '—', 'neutral') +
          summaryValue('Messaging findings', formatNumber(Array.isArray(result && result.messaging_findings) ? result.messaging_findings.length : 0), 'neutral') +
          summaryValue('SEO findings', formatNumber(Array.isArray(result && result.seo_findings) ? result.seo_findings.length : 0), 'neutral') +
        '</div>' +
      '</section>' +
      '<section class="report-section"><div class="section-head"><h3>Messaging findings</h3></div>' + renderFindingsCards(result && result.messaging_findings, 'No messaging findings were returned.') + '</section>' +
      '<section class="report-section"><div class="section-head"><h3>Conversion findings</h3></div>' + renderFindingsCards(result && result.conversion_findings, 'No conversion findings were returned.') + '</section>' +
      '<section class="report-section"><div class="section-head"><h3>SEO findings</h3></div>' + renderFindingsCards(result && result.seo_findings, 'No SEO findings were returned.') + '</section>' +
      '<section class="report-section"><div class="section-head"><h3>GEO findings</h3></div>' + renderFindingsCards(result && result.geo_findings, 'No GEO findings were returned.') + '</section>' +
      '<section class="report-section"><div class="section-head"><h3>Competitive findings</h3></div>' + renderFindingsCards(result && result.competitor_findings, 'No competitor findings were returned.') + '</section>';
  }

  function renderWebsiteStrategyReport(result) {
    const priorities = normalizeObjectArray(result && result.priority_plan);
    const pageRecommendations = normalizeObjectArray(result && result.page_level_recommendations);
    const measurementPlan = normalizeObjectArray(result && result.measurement_plan);

    const priorityCards = priorities.length
      ? '<div class="action-grid">' + priorities.map((item) => {
          return '<article class="action-card">' +
            '<div class="action-title-row"><h4>' + escapeHtml(item && item.title ? item.title : 'Priority') + '</h4>' +
            (item && item.priority ? '<span class="pill">' + escapeHtml(item.priority) + '</span>' : '') +
            '</div>' +
            (item && item.rationale ? '<p>' + escapeHtml(item.rationale) + '</p>' : '') +
          '</article>';
        }).join('') + '</div>'
      : '<div class="empty-state">No priority plan was returned.</div>';

    const pageCards = pageRecommendations.length
      ? '<div class="list-stack">' + pageRecommendations.map((item) => {
          return '<article class="list-card">' +
            '<div class="action-title-row"><h4>' + escapeHtml(item && item.page ? item.page : 'Page') + '</h4>' +
            (item && item.priority ? '<span class="pill">' + escapeHtml(item.priority) + '</span>' : '') +
            '</div>' +
            (item && item.recommendation ? '<p>' + escapeHtml(item.recommendation) + '</p>' : '') +
            (item && item.rationale ? '<p class="muted">' + escapeHtml(item.rationale) + '</p>' : '') +
          '</article>';
        }).join('') + '</div>'
      : '<div class="empty-state">No page-level recommendations were returned.</div>';

    const measurementCards = measurementPlan.length
      ? '<div class="list-stack">' + measurementPlan.map((item) => {
          return '<article class="list-card">' +
            '<h4>' + escapeHtml(item && item.metric ? item.metric : 'Metric') + '</h4>' +
            (item && item.target ? '<div class="meta-row"><span>Target</span><strong>' + escapeHtml(item.target) + '</strong></div>' : '') +
            (item && item.rationale ? '<p>' + escapeHtml(item.rationale) + '</p>' : '') +
          '</article>';
        }).join('') + '</div>'
      : '<div class="empty-state">No measurement plan was returned.</div>';

    return '<section class="report-section">' +
        '<div class="section-head"><h3>Priority plan</h3></div>' +
        priorityCards +
      '</section>' +
      '<section class="report-section"><div class="section-head"><h3>Page-level recommendations</h3></div>' + pageCards + '</section>' +
      renderSimpleListSection('Messaging changes', result && result.messaging_changes, 'No messaging changes were returned.') +
      renderSimpleListSection('SEO and GEO changes', result && result.seo_geo_changes, 'No SEO or GEO changes were returned.') +
      '<section class="report-section"><div class="section-head"><h3>Measurement plan</h3></div>' + measurementCards + '</section>';
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

  function buildBrandBookStatusForm(args) {
    return '<div class="form-grid">' +
      '<label class="checkbox-row"><input type="checkbox" name="include_recent_reflections"' + (args && args.include_recent_reflections ? ' checked' : '') + ' /><span>Include recent reflection count</span></label>' +
    '</div>';
  }

  function buildBrandBookStrategyForm(args) {
    const goals = normalizeList(args && args.goals).join('\n');
    const focusAreas = normalizeList(args && args.focus_areas).join('\n');
    return '<div class="form-grid">' +
      '<label class="full"><span>Goals (one per line)</span><textarea name="goals">' + escapeHtml(goals) + '</textarea></label>' +
      '<label class="full"><span>Focus areas (one per line)</span><textarea name="focus_areas">' + escapeHtml(focusAreas) + '</textarea></label>' +
      '<label class="checkbox-row"><input type="checkbox" name="include_intelligence_signals"' + (args && args.include_intelligence_signals ? ' checked' : '') + ' /><span>Include GEO, SEO, and battlecard follow-ups</span></label>' +
    '</div>';
  }

  function buildWebsiteAuditForm(args) {
    const goals = normalizeList(args && args.goals).join('\n');
    const competitors = normalizeList(args && args.competitors).join('\n');
    const analysisDepth = args && args.analysis_depth ? args.analysis_depth : 'standard';
    return '<div class="form-grid">' +
      '<label><span>Website URL</span><input name="website_url" value="' + escapeHtml(args && args.website_url ? args.website_url : '') + '" /></label>' +
      '<label><span>Analysis depth</span><select name="analysis_depth">' +
        '<option value="standard"' + (analysisDepth === 'standard' ? ' selected' : '') + '>Standard</option>' +
        '<option value="deep"' + (analysisDepth === 'deep' ? ' selected' : '') + '>Deep</option>' +
      '</select></label>' +
      '<label class="full"><span>Goals (one per line)</span><textarea name="goals">' + escapeHtml(goals) + '</textarea></label>' +
      '<label class="full"><span>Competitors (one per line)</span><textarea name="competitors">' + escapeHtml(competitors) + '</textarea></label>' +
    '</div>';
  }

  function buildWebsiteStrategyForm(args) {
    const constraints = normalizeList(args && args.constraints).join('\n');
    const priorityPages = normalizeList(args && args.priority_pages).join('\n');
    return '<div class="form-grid">' +
      '<label><span>Website URL</span><input name="website_url" value="' + escapeHtml(args && args.website_url ? args.website_url : '') + '" /></label>' +
      '<label><span>Primary goal</span><input name="primary_goal" value="' + escapeHtml(args && args.primary_goal ? args.primary_goal : '') + '" /></label>' +
      '<label class="full"><span>Constraints (one per line)</span><textarea name="constraints">' + escapeHtml(constraints) + '</textarea></label>' +
      '<label class="full"><span>Priority pages (one per line)</span><textarea name="priority_pages">' + escapeHtml(priorityPages) + '</textarea></label>' +
    '</div>';
  }

  function renderRerunForm() {
    const args = state.toolArgs || {};
    let body = '';
    if (config.reportType === 'geo') {
      body = buildGeoForm(args);
    } else if (config.reportType === 'seo') {
      body = buildSeoForm(args);
    } else if (config.reportType === 'battlecard') {
      body = buildBattlecardForm(args);
    } else if (config.reportType === 'brandBookStatus') {
      body = buildBrandBookStatusForm(args);
    } else if (config.reportType === 'brandBookStrategy') {
      body = buildBrandBookStrategyForm(args);
    } else if (config.reportType === 'websiteAudit') {
      body = buildWebsiteAuditForm(args);
    } else {
      body = buildWebsiteStrategyForm(args);
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

    if (config.reportType === 'battlecard') {
      return {
        competitor_name: String(formData.get('competitor_name') || '').trim(),
        company_name: String(formData.get('company_name') || '').trim() || undefined,
        focus_areas: parseLines(formData.get('focus_areas')),
        include_objections: formData.get('include_objections') === 'on',
      };
    }

    if (config.reportType === 'brandBookStatus') {
      return {
        include_recent_reflections: formData.get('include_recent_reflections') === 'on',
      };
    }

    if (config.reportType === 'brandBookStrategy') {
      return {
        goals: parseLines(formData.get('goals')),
        focus_areas: parseLines(formData.get('focus_areas')),
        include_intelligence_signals: formData.get('include_intelligence_signals') === 'on',
      };
    }

    if (config.reportType === 'websiteAudit') {
      return {
        website_url: String(formData.get('website_url') || '').trim() || undefined,
        analysis_depth: String(formData.get('analysis_depth') || 'standard'),
        goals: parseLines(formData.get('goals')),
        competitors: parseLines(formData.get('competitors')),
      };
    }

    return {
      website_url: String(formData.get('website_url') || '').trim() || undefined,
      primary_goal: String(formData.get('primary_goal') || '').trim() || undefined,
      constraints: parseLines(formData.get('constraints')),
      priority_pages: parseLines(formData.get('priority_pages')),
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
    if (config.reportType === 'battlecard') return renderBattlecardReport(state.result);
    if (config.reportType === 'brandBookStatus') return renderBrandBookStatusReport(state.result);
    if (config.reportType === 'brandBookStrategy') return renderBrandBookStrategyReport(state.result);
    if (config.reportType === 'websiteAudit') return renderWebsiteAuditReport(state.result);
    return renderWebsiteStrategyReport(state.result);
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
        appInfo: { name: 'Robynn Report App', version: APP_VERSION },
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
import { APP_VERSION } from "../version";
