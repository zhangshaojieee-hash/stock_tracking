/* MACD 监控 Web UI 前端逻辑 */
"use strict";

let groups = [];
let searchTimer = null;
let newsPage = 1;
let newsPageSize = 30;
let newsTimer = null;
let newsRequest = 0;

/* ================= 通用 ================= */
/* 认证: 所有 /api/* 请求自动携带 Bearer token; 401/423 时弹登录框 */
let authToken = localStorage.getItem('auth_token') || '';

async function apiFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers);
  if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
  const r = await fetch(url, opts);
  if (r.status === 401 || r.status === 423) {
    let locked = 0;
    try { locked = (await r.clone().json()).locked || 0; } catch (e) { /* 忽略 */ }
    if (locked > 0) {
      toast(`尝试次数过多, 请${locked}秒后重试`);
    } else {
      showLogin(true);
    }
    throw new Error('unauthorized');
  }
  return r;
}

function showLogin(force) {
  const box = document.getElementById('loginBox');
  if (!box || (!force && box.style.display === 'flex')) return;
  box.style.display = 'flex';
  const input = document.getElementById('loginInput');
  input.value = authToken;
  input.focus();
  document.getElementById('loginErr').textContent = '';
}

async function submitLogin() {
  const input = document.getElementById('loginInput');
  const token = input.value.trim();
  const err = document.getElementById('loginErr');
  if (!token) { err.textContent = '请输入访问令牌'; return; }
  try {
    const r = await apiFetch('/api/auth/status', {
      headers: {'Authorization': 'Bearer ' + token}
    });
    const st = await r.json();
    if (!st.ok) { err.textContent = '令牌无效'; return; }
    authToken = token;
    localStorage.setItem('auth_token', token);
    document.getElementById('loginBox').style.display = 'none';
    // 重新拉取所有数据(loadWatch内部会重建SSE连接)
    loadIdxList(); loadEtfList(); loadWatch(); loadDivs(); loadRadar(); loadIntraday(); loadResonance(); refreshQuotes(); renderOverview(); startNewsView();
  } catch (e) {
    err.textContent = '网络错误, 请重试';
  }
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function pctClass(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
function fmtPct(v) { return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
function fmtYi(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return v.toFixed(0);
}
function fmtVol(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿手';
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万手';
  return v.toFixed(0) + '手';
}

/* ================= 主题 ================= */
function applyTheme(mode) {
  const dark = mode === 'dark' ||
    (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark', dark);
  if (window.__kchartReady) KChart.draw();  // KChart 定义前(初始化阶段)不绘制
  if (window.__kchartReady && window.ShareChart) ShareChart.draw();
  if (window.MacroView && document.getElementById('view-macro') &&
      document.getElementById('view-macro').classList.contains('active')) MacroView.redrawAll();
}
function setTheme(mode) {
  localStorage.setItem('theme', mode);
  document.getElementById('themeSel').value = mode;
  applyTheme(mode);
}
(function initTheme() {
  const mode = localStorage.getItem('theme') || 'auto';
  document.getElementById('themeSel').value = mode;
  applyTheme(mode);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme(localStorage.getItem('theme') || 'auto');
  });
})();

/* ================= 视图路由(侧边栏导航) ================= */
let curView = '';
let viewHistory = [];
const VIEWS = ['overview', 'sentiment', 'div', 'radar', 'chart', 'ai', 'macro', 'sys'];

function showView(viewId, fromBack = false) {
  if (!VIEWS.includes(viewId)) viewId = 'overview';
  if (curView && curView !== viewId && !fromBack) {
    viewHistory.push(curView);
    if (viewHistory.length > 20) viewHistory.shift();
  }
  curView = viewId;
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('active', v.id === 'view-' + viewId));
  document.querySelectorAll('.nav-item').forEach(a =>
    a.classList.toggle('active', a.dataset.view === viewId));
  stopAiTimer();   // 面板化的视图按需挂载/卸载数据定时器
  stopSysTimer();
  stopNewsTimer();
  if (viewId === 'overview') {
    renderOverview();
  } else if (viewId === 'sentiment') {
    startNewsView();
  } else if (viewId === 'radar') {
    loadRadar();
  } else if (viewId === 'chart') {
    /* 由隐藏变可见: 重新测量列表分页 + 重绘图表(隐藏时画布为0×0) */
    etfPage.size = 0;
    watchPage.size = 0;
    renderEtfList();
    renderWatchList();
    requestAnimationFrame(() => {
      if (window.__kchartReady) { KChart.draw(); ShareChart.draw(); }
    });
  } else if (viewId === 'ai') {
    startAiView();
  } else if (viewId === 'macro') {
    if (window.MacroView) MacroView.enter();
  } else if (viewId === 'sys') {
    startSysView();
  }
  try { localStorage.setItem('last_view', viewId); } catch (e) { /* 忽略 */ }
  window.scrollTo(0, 0);
  updateBrandControl();
}

function updateBrandControl() {
  const control = document.getElementById('brandControl');
  if (!control) return;
  const canGoBack = viewHistory.length > 0;
  control.classList.toggle('back-mode', canGoBack);
  control.setAttribute('aria-label', canGoBack ? '返回上一页' : 'MACD 监控首页');
  control.setAttribute('title', canGoBack ? '返回上一页' : 'MACD 监控首页');
}

function selectSection(viewId) {
  viewHistory = [];
  showView(viewId, true);
}

function goBackView() {
  const previous = viewHistory.pop();
  if (previous) showView(previous, true);
}

/* ================= 舆情资讯流 ================= */
function newsText(value) {
  return value == null || value === '' ? '--' : esc(value);
}

function newsTime(value) {
  if (!value) return '--';
  return String(value).replace('T', ' ').slice(0, 16);
}

function newsTag(label, kind) {
  if (!label) return '';
  return `<span class="news-tag ${kind || ''}">${esc(label)}</span>`;
}

function renderNewsSummary(payload) {
  const summary = payload.summary || {};
  const stats = payload.stats || {};
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value == null ? '--' : value; };
  set('newsTotal', summary.total || 0);
  set('newsPositive', summary.positive || 0);
  set('newsNegative', summary.negative || 0);
  set('newsNeutral', summary.neutral || 0);
  set('newsLatest', newsTime(stats.latest));
  const hint = document.getElementById('newsFilterHint');
  if (hint) hint.textContent = `当前筛选 ${payload.total || 0} 条 · 情绪均值 ${summary.score == null ? '--' : summary.score}`;
  const updated = document.getElementById('newsUpdated');
  if (updated) updated.textContent = payload.status && payload.status.last_ok ? `同步 ${new Date(payload.status.last_ok * 1000).toLocaleTimeString()}` : '等待后台同步';
  const live = document.getElementById('newsLive');
  if (live) {
    live.classList.toggle('ok', !!(payload.status && payload.status.last_ok));
    live.innerHTML = `<i></i>${payload.status && payload.status.last_error ? '部分来源异常' : (payload.status && payload.status.last_ok ? 'RSS 已连接' : '等待资讯同步')}`;
  }
}

function renderNewsRows(items) {
  const box = document.getElementById('newsList');
  if (!box) return;
  if (!items || !items.length) {
    box.innerHTML = '<div class="empty">暂无匹配资讯。请确认 RSS 源可访问，或调整筛选条件。</div>';
    return;
  }
  box.innerHTML = items.map(item => {
    const sentimentClass = item.sentiment_label === '利好' ? 'positive' : (item.sentiment_label === '利空' ? 'negative' : 'neutral');
    const entities = (item.tickers || []).map(t => newsTag(t.name || t.code, 'ticker')).join('');
    const industries = (item.industries || []).map(v => newsTag(v, 'industry')).join('');
    const events = (item.event_tags || []).map(v => newsTag(v, 'event')).join('');
    const source = newsTag(item.source, item.source_tier === 'gold' ? 'gold' : 'source');
    const score = item.sentiment_score == null ? '--' : (item.sentiment_score > 0 ? '+' : '') + Number(item.sentiment_score).toFixed(2);
    return `<article class="news-item ${sentimentClass}">
      <div class="news-item-main">
        <div class="news-item-meta"><span class="news-time mono">${newsText(newsTime(item.published_at))}</span>${source}${item.hour_label ? newsTag(item.hour_label, item.hour_tier) : ''}</div>
        <h3>${item.link ? `<a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">${newsText(item.title)}</a>` : newsText(item.title)}</h3>
        <p>${newsText(item.summary || item.content)}</p>
        <div class="news-tags">${entities}${industries}${events}${item.note ? `<span class="news-note">${esc(item.note)}</span>` : ''}</div>
      </div>
      <div class="news-sentiment"><b>${esc(item.sentiment_label || '中性')}</b><span>${score}</span><small>${item.sentiment_confidence == null ? '' : `置信 ${Math.round(item.sentiment_confidence * 100)}%`}</small></div>
    </article>`;
  }).join('');
}

function renderNewsPager(payload) {
  const box = document.getElementById('newsPager');
  if (!box) return;
  const pages = Math.max(1, Math.ceil((payload.total || 0) / (payload.page_size || newsPageSize)));
  if (pages <= 1) { box.innerHTML = ''; return; }
  box.innerHTML = `<button type="button" ${payload.page <= 1 ? 'disabled' : ''} onclick="loadNews(${payload.page - 1})">上一页</button><span class="pg-info">${payload.page} / ${pages}</span><button type="button" ${payload.page >= pages ? 'disabled' : ''} onclick="loadNews(${payload.page + 1})">下一页</button>`;
}

async function loadNews(page = newsPage) {
  if (!document.getElementById('view-sentiment')) return;
  newsPage = page;
  const request = ++newsRequest;
  const params = new URLSearchParams({page: String(page), page_size: String(newsPageSize)});
  const q = document.getElementById('newsQuery');
  const source = document.getElementById('newsSource');
  const sentiment = document.getElementById('newsSentiment');
  const ticker = document.getElementById('newsTicker');
  if (q && q.value.trim()) params.set('q', q.value.trim());
  if (source && source.value) params.set('source', source.value);
  if (sentiment && sentiment.value) params.set('sentiment', sentiment.value);
  if (ticker && ticker.value.trim()) params.set('ticker', ticker.value.trim());
  try {
    const response = await apiFetch('/api/news?' + params.toString());
    const payload = await response.json();
    if (request !== newsRequest) return;
    renderNewsSummary(payload);
    renderNewsRows(payload.items || []);
    renderNewsPager(payload);
  } catch (error) {
    if (error && error.message === 'unauthorized') return;
    const box = document.getElementById('newsList');
    if (box) box.innerHTML = '<div class="empty">资讯服务暂时不可用，请稍后重试。</div>';
  }
}

async function loadNewsSources() {
  try {
    const response = await apiFetch('/api/news/sources');
    const payload = await response.json();
    const select = document.getElementById('newsSource');
    if (select) {
      const current = select.value;
      select.innerHTML = '<option value="">全部来源</option>' + (payload.sources || []).map(item => `<option value="${esc(item.name)}">${esc(item.name)} (${item.count})</option>`).join('');
      select.value = current;
    }
  } catch (error) { /* API认证错误由apiFetch处理 */ }
}

async function refreshNews(force = false) {
  const refresh = document.querySelector('.news-refresh');
  if (refresh) refresh.disabled = true;
  try {
    if (force) await apiFetch('/api/news/refresh');
    await loadNews(newsPage);
    await loadNewsSources();
  } catch (error) { /* 页面保留已有缓存 */ }
  if (refresh) refresh.disabled = false;
}

function startNewsView() {
  loadNewsSources();
  loadNews(1);
  clearInterval(newsTimer);
  newsTimer = setInterval(() => loadNews(newsPage), 60000);
}

function stopNewsTimer() {
  clearInterval(newsTimer);
  newsTimer = null;
}

/* 图表列表导航: 从底背离列表打开时保留当前筛选/排序结果 */
let chartListRows = [];
let chartListIndex = -1;

function updateChartListNav() {
  const nav = document.getElementById('chartListNav');
  const label = document.getElementById('chartListLabel');
  const prev = document.getElementById('chartPrev');
  const next = document.getElementById('chartNext');
  if (!nav || !label || !prev || !next) return;
  const active = chartListRows.length > 0 && chartListIndex >= 0;
  nav.hidden = !active;
  if (!active) return;
  label.textContent = `底背离列表 ${chartListIndex + 1} / ${chartListRows.length}`;
  prev.disabled = chartListIndex <= 0;
  next.disabled = chartListIndex >= chartListRows.length - 1;
}

function clearChartListContext() {
  chartListRows = [];
  chartListIndex = -1;
  updateChartListNav();
}

function setChartListContext(rows, row) {
  chartListRows = Array.isArray(rows) ? rows.slice() : [];
  chartListIndex = chartListRows.findIndex(item => item === row);
  updateChartListNav();
}

function stepChartList(delta) {
  const nextIndex = chartListIndex + delta;
  if (nextIndex < 0 || nextIndex >= chartListRows.length) return;
  chartListIndex = nextIndex;
  updateChartListNav();
  viewDivRow(chartListRows[chartListIndex], chartListRows);
}

/* 跨视图打开标的: 跳到图表分析视图展示K线 */
let chartProfileRequest = 0;

function resetChartProfile() {
  const industry = document.getElementById('chartIndustry');
  const concept = document.getElementById('chartConcept');
  const concepts = document.getElementById('chartConcepts');
  const tip = document.getElementById('chartProfileTip');
  if (industry) industry.textContent = '--';
  if (concept) concept.textContent = '--';
  if (concepts) concepts.textContent = '--';
  if (tip) tip.textContent = '展示资料加载中…';
}

async function loadChartProfile(code, attempt = 0) {
  const request = ++chartProfileRequest;
  resetChartProfile();
  if (!code) return;
  try {
    const r = await apiFetch('/api/stock-profile?code=' + encodeURIComponent(code));
    const data = await r.json();
    if (request !== chartProfileRequest || curEtf !== code) return;
    const industry = data.industry || '--';
    const primary = data.primary_business || data.primary_concept || '--';
    const concepts = data.concepts || '--';
    document.getElementById('chartIndustry').textContent = industry;
    document.getElementById('chartConcept').textContent = primary;
    document.getElementById('chartConcepts').textContent = concepts;
    const tip = document.getElementById('chartProfileTip');
    const hasProfile = industry !== '--' || primary !== '--' || concepts !== '--';
    if (tip) tip.textContent = hasProfile ? '展示资料' : (attempt < 3 ? '资料加载中…' : '暂无板块资料');
    if (attempt < 3 && !hasProfile) {
      setTimeout(() => loadChartProfile(code, attempt + 1), 1800);
    }
  } catch (e) {
    if (request === chartProfileRequest) {
      const tip = document.getElementById('chartProfileTip');
      if (tip) tip.textContent = '资料暂不可用';
    }
  }
}

function openStockInChart(name, code, tag, listRows = null, listRow = null) {
  if (Array.isArray(listRows) && listRow) setChartListContext(listRows, listRow);
  else clearChartListContext();
  showView('chart');
  curEtf = code;
  document.getElementById('chName').textContent = name || code;
  document.getElementById('chCode').textContent = code;
  document.getElementById('chIndex').textContent = tag || '';
  const p = document.getElementById('chPrice');
  p.textContent = '--'; p.className = 'ch-price';
  const c = document.getElementById('chChg');
  c.textContent = ''; c.className = 'ch-chg';
  document.getElementById('chAmount').textContent = '--';
  document.getElementById('chShares').textContent = '--';
  loadChartProfile(code);
}

/* ================= 概览页 ================= */
let ovDivRows = [];
let ovAiRows = [];

async function renderOverview() {
  const m = document.getElementById('ovMeta');
  if (m) {
    m.textContent = new Date().toLocaleDateString('zh-CN',
        {month: 'long', day: 'numeric', weekday: 'long'}) +
      ' · ' + (isTradingNow() ? '交易时段' : '休市时段');
  }
  renderOvIdx();
  renderOvDivs();
  renderOvWatch();
  loadOvAi();
}

/* 指数卡片: 点击跳图表分析并选中该指数 */
function renderOvIdx() {
  const box = document.getElementById('ovIdxCards');
  if (!box) return;
  if (!idxData.length) {
    box.innerHTML = '<div class="empty" style="grid-column:1/-1">指数数据加载中…</div>';
    return;
  }
  box.innerHTML = idxData.map(i => `
    <div class="ov-idx ${pctClass(i.chg_pct)}" onclick="ovOpenIdx('${i.code}')">
      <div class="ov-idx-name">${esc(i.name)}</div>
      <div class="ov-idx-price ${pctClass(i.chg_pct)}">${i.price.toFixed(2)}</div>
      <div class="ov-idx-foot">
        <span class="ov-idx-chg ${pctClass(i.chg_pct)}">${fmtPct(i.chg_pct)}</span>
        <span class="ov-idx-amt">成交额 ${(i.amount / 1e4).toFixed(0)}亿</span>
      </div>
    </div>`).join('');
}

function ovOpenIdx(code) {
  showView('chart');
  selectIdx(code);
}

/* 最新底背离信号: 最新扫描日按确认日期倒序取前9条 */
function renderOvDivs() {
  const box = document.getElementById('ovDivs');
  if (!box) return;
  if (!divAll.length) {
    box.innerHTML = '<div class="empty">暂无底背离信号（交易日 16:00 自动扫描）</div>';
    ovDivRows = [];
    return;
  }
  const latest = [...new Set(divAll.map(r => r.scan))].sort().reverse()[0];
  ovDivRows = divAll.filter(r => r.scan === latest)
      .sort((a, b) => String(b.confirm || '').localeCompare(String(a.confirm || '')) ||
                       (b.ml_score || 0) - (a.ml_score || 0))
      .slice(0, 9);
  box.innerHTML = ovDivRows.length ? ovDivRows.map((r, i) => `
    <div class="ov-row" onclick="ovOpenDiv(${i})">
      <span class="ov-n"><b>${esc(r.name)}</b><i>${r.code} · ${r.tf_name}</i></span>
      ${r.ml_score != null ? `<span class="ov-tag">模型 ${r.ml_score.toFixed(0)}</span>` : ''}
      <span class="ov-num ${r.chg3 != null ? pctClass(r.chg3) : ''}">${r.chg3 != null ? fmtPct(r.chg3) : '--'}</span>
      <span class="ov-sub">${esc(r.confirm || r.date2)}</span>
    </div>`).join('') :
    '<div class="empty">最新扫描周期暂无信号</div>';
}

function ovOpenDiv(i) {
  viewDivRow(ovDivRows[i]);
}

/* 自选异动: 按当日涨跌幅绝对值排序取前9条 */
function renderOvWatch() {
  const box = document.getElementById('ovWatch');
  if (!box) return;
  if (!watchData.length) {
    box.innerHTML = '<div class="empty">暂无自选标的，请在「图表分析」中搜索添加</div>';
    return;
  }
  const rows = watchData
      .map(s => ({s, q: quoteMap[s.code]}))
      .filter(x => x.q && x.q.ok && x.q.chg_pct != null)
      .sort((a, b) => Math.abs(b.q.chg_pct) - Math.abs(a.q.chg_pct))
      .slice(0, 9);
  box.innerHTML = rows.length ? rows.map(x => `
    <div class="ov-row" onclick="ovOpenWatch('${esc(x.s.code)}')">
      <span class="ov-n"><b>${esc(x.s.name)}</b><i>${esc(x.s.code)} · ${esc(x.s.group || '自选')}</i></span>
      <span class="ov-num">${x.q.price.toFixed(2)}</span>
      <span class="ov-num ${pctClass(x.q.chg_pct)}">${fmtPct(x.q.chg_pct)}</span>
    </div>`).join('') :
    '<div class="empty">自选行情加载中…</div>';
}

function ovOpenWatch(code) {
  showView('chart');
  selectWatch(code);
}

/* AI 短线精选预览: 最新一期前5条 */
async function loadOvAi() {
  const box = document.getElementById('ovAi');
  if (!box) return;
  try {
    const r = await apiFetch('/api/ai/picks');
    const d = await r.json();
    const sub = document.getElementById('ovAiSub');
    if (sub && d.hour) sub.textContent = `涨停板策略 · 每交易日 ${d.hour}:00 自动运行`;
    ovAiRows = (d.rows || []).slice(0, 5);
    if (!d.date || !ovAiRows.length) {
      box.innerHTML = `<div class="empty">暂无选股结果${d.running ? '，选股运行中…' : ''}，点击右上角「进入 AI 选股」立即体验</div>`;
      return;
    }
    box.innerHTML = ovAiRows.map((r0, i) => {
      const e = r0.extra || {};
      return `
      <div class="ov-row" onclick="ovOpenAi(${i})">
        <span class="ov-n"><b>${esc(r0.name || r0.code)}</b><i>${r0.code} · ${esc(_zttjTxt(e))}</i></span>
        ${r0.score != null ? `<span class="ov-tag">动能 ${r0.score.toFixed(0)}</span>` : ''}
        <span class="ov-num">${esc(e.fbt_s || '--')}</span>
        <span class="ov-sub">${esc(e.hybk || '--')}</span>
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="empty">AI 选股数据获取失败</div>';
  }
}

function ovOpenAi(i) {
  const r = ovAiRows[i];
  if (!r) return;
  openStockInChart(r.name || r.code, r.code, 'AI选股 Top' + (i + 1));
  switchTf('day');
}

/* ================= 指数列表 ================= */
let idxData = [];
const IDX_PANEL_STORAGE_KEY = 'chart_index_panel_collapsed';

function setIdxPanelCollapsed(collapsed, persist = true) {
  const section = document.getElementById('idxSec');
  const toggle = document.getElementById('idxToggle');
  if (!section || !toggle) return;
  section.classList.toggle('collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  if (persist) {
    try { localStorage.setItem(IDX_PANEL_STORAGE_KEY, collapsed ? '1' : '0'); }
    catch (e) { /* 浏览器禁用存储时仍保留当前页面状态 */ }
  }
}

function toggleIdxPanel() {
  const section = document.getElementById('idxSec');
  if (!section) return;
  setIdxPanelCollapsed(!section.classList.contains('collapsed'));
}

function initIdxPanel() {
  let collapsed = true;
  try { collapsed = localStorage.getItem(IDX_PANEL_STORAGE_KEY) !== '0'; }
  catch (e) { /* 使用默认折叠状态 */ }
  setIdxPanelCollapsed(collapsed, false);
}

async function loadIdxList() {
  try {
    const r = await apiFetch('/api/index/list');
    idxData = await r.json();
    renderIdxList();
    ensureSSE();
  } catch (e) { /* 下轮重试 */ }
}

function renderIdxList() {
  const box = document.getElementById('idxList');
  if (!idxData.length) {
    box.innerHTML = '<div class="empty">暂无指数数据</div>';
    return;
  }
  box.innerHTML = idxData.map(i => `
    <div class="etf-item ${curEtf === i.code ? 'active' : ''}" onclick="selectIdx('${i.code}')">
      <span class="en">${esc(i.name)}</span>
      <span class="ep ${pctClass(i.chg_pct)}">${i.price.toFixed(2)}</span>
      <span class="epct ${pctClass(i.chg_pct)}">${fmtPct(i.chg_pct)}</span>
    </div>`).join('');
  renderOvIdx();
}

function selectIdx(code) {
  clearChartListContext();
  curEtf = code;
  loadChartProfile(code);
  renderIdxList();
  renderEtfList();
  const i = idxData.find(x => x.code === code);
  if (i) {
    document.getElementById('chName').textContent = i.name;
    document.getElementById('chCode').textContent = i.code;
    document.getElementById('chIndex').textContent = '指数';
    const p = document.getElementById('chPrice');
    p.textContent = i.price.toFixed(2);
    p.className = 'ch-price ' + pctClass(i.chg_pct);
    const c = document.getElementById('chChg');
    c.textContent = `${i.chg > 0 ? '+' : ''}${i.chg.toFixed(2)}  ${fmtPct(i.chg_pct)}`;
    c.className = 'ch-chg ' + pctClass(i.chg_pct);
    document.getElementById('chAmount').textContent = (i.amount / 1e4).toFixed(2) + '亿';
    document.getElementById('chShares').textContent = '--';
  }
  loadMainChart(code);
  renderWatchActive();
}

/* ================= 宽基ETF列表 ================= */
let etfData = [];
let curEtf = null;

async function loadEtfList() {
  try {
    const r = await apiFetch('/api/etf/list');
    etfData = await r.json();
    document.getElementById('etfUpd').textContent =
      new Date().toTimeString().slice(0, 5) + ' 更新';
    renderEtfList();
    if (!curEtf && etfData.length) selectEtf(etfData[0].code);
    ensureSSE();
  } catch (e) { /* 下轮重试 */ }
}

/* ================= 列表分页(左右栏固定高度, 超出分页, 不无限增长) ================= */
let etfPage = { n: 1, size: 0 };
let watchPage = { n: 1, size: 0 };

const etfItemHtml = e => `
    <div class="etf-item ${curEtf === e.code ? 'active' : ''}" onclick="selectEtf('${e.code}')">
      <span class="en">${esc(e.name)}</span>
      <span class="ep ${pctClass(e.chg_pct)}">${e.price.toFixed(3)}</span>
      <span class="ec">${esc(e.index)} · ${e.shares}亿份</span>
      <span class="epct ${pctClass(e.chg_pct)}">${fmtPct(e.chg_pct)}</span>
    </div>`;

/* 以左栏宽基ETF面板底边线为基准, 对齐右栏监控列表高度 */
function alignColumns() {
  const etfPanel = document.querySelector('.etf-panel');
  const watch = document.getElementById('watch');
  if (!etfPanel || !watch) return;
  const bottom = etfPanel.getBoundingClientRect().bottom;
  const top = watch.getBoundingClientRect().top;
  const cs = getComputedStyle(watch.closest('.monitor-panel'));
  const pagerH = document.getElementById('watchPager').offsetHeight || 32;
  const h = bottom - top - (parseFloat(cs.paddingBottom) || 0) - pagerH - 1;
  // h<120 视为堆叠布局: 清除内联高度回落到CSS默认, 避免残留宽屏时的旧高度
  watch.style.height = h >= 120 ? h + 'px' : '';
}

function renderPager(el, pg, pages) {
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML =
    `<button ${pg.n <= 1 ? 'disabled' : ''} onclick="turnPage('${el.id}',-1)">‹ 上一页</button>` +
    `<span class="pg-info">${pg.n} / ${pages} 页</span>` +
    `<button ${pg.n >= pages ? 'disabled' : ''} onclick="turnPage('${el.id}',1)">下一页 ›</button>`;
}

function turnPage(id, d) {
  if (id === 'etfPager') { etfPage.n += d; renderEtfList(); }
  else { watchPage.n += d; renderWatchList(); }
}

/* 窗口尺寸变化: 重算左右栏每页条数并重新对齐底边线 */
window.addEventListener('resize', () => {
  etfPage.size = 0;
  watchPage.size = 0;
  renderEtfList();
  renderWatchList();
});

function renderEtfList() {
  const box = document.getElementById('etfList');
  const pgEl = document.getElementById('etfPager');
  if (!etfData.length) {
    box.innerHTML = '<div class="empty">暂无符合条件的宽基ETF</div>';
    pgEl.innerHTML = '';
    return;
  }
  box.innerHTML = etfData.map(etfItemHtml).join('');   // 全量渲染一次以测量行高
  if (!box.clientHeight) { pgEl.innerHTML = ''; return; }   // 图表视图隐藏中, 显示后再分页
  if (!etfPage.size) {
    const item = box.querySelector('.etf-item');
    if (item) etfPage.size = Math.max(1, Math.floor(box.clientHeight / item.offsetHeight));
  }
  const pages = Math.max(1, Math.ceil(etfData.length / etfPage.size));
  etfPage.n = Math.min(Math.max(1, etfPage.n), pages);
  const start = (etfPage.n - 1) * etfPage.size;
  if (etfPage.size < etfData.length)
    box.innerHTML = etfData.slice(start, start + etfPage.size).map(etfItemHtml).join('');
  renderPager(pgEl, etfPage, pages);
}

function selectEtf(code) {
  clearChartListContext();
  curEtf = code;
  renderIdxList();
  renderEtfList();
  const e = etfData.find(x => x.code === code);
  if (e) {
    document.getElementById('chName').textContent = e.name;
    document.getElementById('chCode').textContent = e.code;
    document.getElementById('chIndex').textContent = e.index;
    const p = document.getElementById('chPrice');
    p.textContent = e.price.toFixed(3);
    p.className = 'ch-price ' + pctClass(e.chg_pct);
    const c = document.getElementById('chChg');
    c.textContent = `${e.chg > 0 ? '+' : ''}${e.chg.toFixed(3)}  ${fmtPct(e.chg_pct)}`;
    c.className = 'ch-chg ' + pctClass(e.chg_pct);
    document.getElementById('chAmount').textContent = (e.amount / 1e4).toFixed(2) + '亿';
    document.getElementById('chShares').textContent = e.shares + '亿份';
  }
  loadMainChart(code);
  renderWatchActive();
}

/* ================= K线图 ================= */
/* KChart/ShareChart 图表实现拆分至 chart.js(先于本文件加载) */
let curTf = 'day';

/* 按当前周期加载中栏主图(分时模式加载分时数据, 份额面板按日线口径) */
function loadMainChart(code) {
  if (curTf === 'min') {
    KChart.tf = 'min';              // 触发KChart.draw转发到分时图
    MinuteChart.load(code);
    ShareChart.load(code, 'day');
  } else {
    KChart.load(code, curTf);
    ShareChart.load(code, curTf);
  }
}

function switchTf(tf) {
  curTf = tf;
  document.querySelectorAll('.tf').forEach(b =>
    b.classList.toggle('active', b.dataset.tf === tf));
  // 分时模式隐藏K线窗口滑条(分时图固定全天视图)
  const slider = document.querySelector('.chart-slider');
  if (slider) slider.style.display = tf === 'min' ? 'none' : '';
  if (curEtf) loadMainChart(curEtf);
  else if (tf === 'min') {
    KChart.tf = 'min';
    MinuteChart.draw();
  }
}

/* ================= 选中标的交易时段实时刷新 =================
   分时模式: 8秒轮询当日分钟数据(仅当前选中标的一个请求);
   日K模式: 用最新行情tick更新最后一根K线(优先SSE缓存, 未订阅时单码拉取)。
   未选中的标的不发起任何请求。 */
function isTradingNow() {
  const d = new Date();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return (m >= 570 && m <= 690) || (m >= 780 && m <= 900);   // 9:30-11:30 / 13:00-15:00
}

async function liveTick() {
  if (!curEtf || !isTradingNow() || document.hidden) return;
  if (curTf === 'min') { MinuteChart.load(curEtf); return; }
  if (curTf !== 'day') return;               // 周K实时tick意义不大, 不刷新
  let q = quoteMap[curEtf];
  if (!q || !q.price) {
    // 选中标的不在SSE订阅集(如从底背离表格点开的股票), 单码拉取
    try {
      const r = await apiFetch('/api/quotes?codes=' + encodeURIComponent(curEtf));
      const arr = await r.json();
      if (Array.isArray(arr) && arr[0] && arr[0].ok) q = arr[0];
    } catch (e) { return; }
  }
  if (q && q.price) KChart.liveTick(q);
}
setInterval(liveTick, 8000);

/* ================= MACD 监控列表 ================= */
let watchData = [];   // 自选列表原始数据(名称/分组)
let quoteMap = {};    // code -> 最新行情(点击自选时填充中栏头部)

function renderWatchActive() {
  document.querySelectorAll('.watch-item').forEach(el =>
    el.classList.toggle('active', el.dataset.code === curEtf));
}

function selectWatch(code) {
  curEtf = code;
  renderIdxList();
  renderEtfList();
  renderWatchActive();
  const s = watchData.find(x => x.code === code);
  if (s) {
    document.getElementById('chName').textContent = s.name;
    document.getElementById('chCode').textContent = s.code;
    document.getElementById('chIndex').textContent = s.group || '自选';
  }
  const q = quoteMap[code];
  const p = document.getElementById('chPrice');
  const c = document.getElementById('chChg');
  if (q && q.ok) {
    p.textContent = q.price.toFixed(2);
    p.className = 'ch-price ' + pctClass(q.chg_pct);
    c.textContent = `${q.chg > 0 ? '+' : ''}${q.chg.toFixed(2)}  ${fmtPct(q.chg_pct)}`;
    c.className = 'ch-chg ' + pctClass(q.chg_pct);
    document.getElementById('chAmount').textContent = (q.amount / 1e4).toFixed(2) + '亿';
  } else {
    p.textContent = '--';
    p.className = 'ch-price';
    c.textContent = '';
    c.className = 'ch-chg';
    document.getElementById('chAmount').textContent = '--';
  }
  document.getElementById('chShares').textContent = '--';
  loadMainChart(code);
}

const watchItemHtml = (s, i) => `
    <div class="watch-item ${curEtf === s.code ? 'active' : ''}" data-code="${esc(s.code)}" onclick="selectWatch('${esc(s.code)}')">
      <span class="seq">${i + 1}</span>
      <span class="wname"><span class="n">${esc(s.name)}</span><span class="c">${esc(s.code)}</span></span>
      <span class="grp">${esc(s.group || '自选')}</span>
      <span class="spacer"></span>
      <span class="qcell qprice"><span class="p">--</span><span class="u">--</span></span>
      <span class="qcell qpct">--</span>
      <span class="qcell qflow"><span class="v">--</span><span class="l">--</span></span>
      <button class="del" onclick="event.stopPropagation();delStock('${esc(s.code)}')">删除</button>
    </div>`;

function renderWatchList() {
  const box = document.getElementById('watch');
  const pgEl = document.getElementById('watchPager');
  alignColumns();   // 先对齐左栏ETF面板底边线, 再按高度分页
  if (!watchData.length) {
    box.innerHTML = '<div class="empty">暂无监控标的，请在上方搜索添加</div>';
    pgEl.innerHTML = '';
    return;
  }
  box.innerHTML = watchData.map(watchItemHtml).join('');   // 全量渲染一次以测量行高
  if (!box.clientHeight) { pgEl.innerHTML = ''; return; }   // 图表视图隐藏中, 显示后再分页
  // 先补齐徽章再测高(带徽章的行更高), 否则分页按矮行计算, 徽章渲染后溢出裁掉末行
  updateIntradayBadges();
  updateResBadges();
  // 测量前把行"喂成最终形态": 回填行情(quoteMap缓存, 不发请求),
  // 保证测量行高=实际行高, 避免按"--"占位矮行算出的size偏大
  watchData.forEach(s => updateWatchRow(s.code));
  // 每次都按当前几何重算每页条数: 上方搜索结果框展开/收起会改变列表可用高度,
  // 若沿用旧size会导致当页行数超出高度, 末行被 overflow:hidden 裁掉(删除按钮显示不完全)
  let rowH = 0;
  box.querySelectorAll('.watch-item').forEach(el => {
    rowH = Math.max(rowH, el.offsetHeight);
  });
  if (rowH) watchPage.size =
    Math.max(1, Math.floor((box.clientHeight + 6) / (rowH + 6)));

  const renderPage = () => {
    const pages = Math.max(1, Math.ceil(watchData.length / watchPage.size));
    watchPage.n = Math.min(Math.max(1, watchPage.n), pages);
    const start = (watchPage.n - 1) * watchPage.size;
    const view = watchPage.size < watchData.length
      ? watchData.slice(start, start + watchPage.size) : watchData;
    box.innerHTML = view.map((s, i) => watchItemHtml(s, start + i)).join('');
    renderPager(pgEl, watchPage, pages);
    view.forEach(s => updateWatchRow(s.code));   // 行情来自quoteMap缓存, 不发请求
    updateIntradayBadges();
    updateResBadges();
  };
  renderPage();
  // 渲染后溢出自检: 行情回填/徽章等使行变高导致溢出时, 逐行减容量重渲染
  // (对测量后异步到达的数据也免疫), 最多回退3次防止死循环
  let guard = 0;
  while (box.scrollHeight > box.clientHeight && watchPage.size > 1 && guard++ < 3) {
    watchPage.size -= 1;
    renderPage();
  }
}

async function loadWatch() {
  const r = await apiFetch('/api/stocks');
  const stocks = await r.json();
  watchData = stocks;
  groups = [...new Set(stocks.map(s => s.group || '自选'))];
  document.getElementById('count').textContent = stocks.length;
  renderWatchList();
  renderOvWatch();
  refreshQuotes();
  ensureSSE();   // 自选变化后重连SSE(订阅代码集已变)
}

async function refreshQuotes() {
  try {
    const r = await apiFetch('/api/quotes');
    const data = await r.json();
    document.getElementById('upd').textContent =
      '更新 ' + new Date().toTimeString().slice(0, 5);
    for (const q of data) {
      quoteMap[q.code] = q;
      updateWatchRow(q.code);
    }
    renderOvWatch();
  } catch (e) { /* 下轮重试 */ }
}

/* 更新单只自选行的行情DOM(轮询与SSE共用) */
function updateWatchRow(code) {
  const q = quoteMap[code];
  const row = document.querySelector(`.watch-item[data-code="${CSS.escape(code)}"]`);
  if (!q || !row) return;
  const priceEl = row.querySelector('.qprice .p');
  const unitEl = row.querySelector('.qprice .u');
  const pctEl = row.querySelector('.qpct');
  const flowEl = row.querySelector('.qflow .v');
  const flowLbl = row.querySelector('.qflow .l');
  if (!q.ok) {
    priceEl.textContent = '--'; unitEl.textContent = '';
    pctEl.textContent = '--'; pctEl.className = 'qcell qpct';
    flowEl.textContent = '--'; flowLbl.textContent = '';
    return;
  }
  priceEl.textContent = q.price.toFixed(2);
  priceEl.className = 'p ' + pctClass(q.chg_pct);
  unitEl.textContent = (q.chg > 0 ? '+' : '') + q.chg.toFixed(2);
  pctEl.textContent = fmtPct(q.chg_pct);
  pctEl.className = 'qcell qpct ' + pctClass(q.chg_pct);
  if (q.is_index) {
    flowEl.textContent = fmtVol(q.volume);
    flowEl.className = 'v';
    flowLbl.textContent = '成交额 ' + (q.amount / 1e4).toFixed(1) + '亿';
  } else if (q.flow !== null && q.flow !== undefined) {
    flowEl.textContent = (q.flow > 0 ? '+' : '') + fmtYi(q.flow);
    flowEl.className = 'v ' + pctClass(q.flow);
    flowLbl.textContent = '主力净流入';
  } else {
    flowEl.textContent = (q.amount / 1e4).toFixed(1) + '亿';
    flowEl.className = 'v';
    flowLbl.textContent = '成交额';
  }
}

/* ================= SSE 实时推送 ================= */
/* 后端 /api/stream: 行情diff(3s) + 扫描进度 + 盘中背离预览事件。
   替代前端各自轮询: N个标签页只有1份出网请求; SSE断开时自动回退轮询 */
let es = null;
let sseOk = false;
let sseLastCodes = '';
let intradayMap = {};   // code -> {tf: 盘中预览信号}
let radarAll = [];
let radarFiltered = [];

function applyRadarFilters() {
  const tf = document.getElementById('radarTf')?.value || '';
  const priority = document.getElementById('radarPriority')?.value || '';
  const minRes = Number(document.getElementById('radarRes')?.value || 0);
  const minTfRes = Number(document.getElementById('radarTfRes')?.value || 0);
  const q = (document.getElementById('radarQ')?.value || '').trim().toLowerCase();
  radarFiltered = radarAll.filter(r =>
    (!tf || r.tf === tf) &&
    (!priority || r.radar_priority === priority) &&
    (r.score || 0) >= minRes &&
    (r.resonance_count || 0) >= minTfRes &&
    (!q || String(r.name || '').toLowerCase().includes(q) || String(r.code || '').includes(q)));
  renderRadar();
}

function renderRadar() {
  const box = document.getElementById('radarList');
  if (!box) return;
  const summary = document.getElementById('radarSummary');
  if (summary) summary.textContent = `${radarFiltered.length} / ${radarAll.length} 个候选`;
  if (!radarFiltered.length) {
    box.innerHTML = '<div class="empty">暂无符合条件的候选</div>';
    return;
  }
  const tfName = {day: '日线', week: '周线'};
  box.innerHTML = radarFiltered.map(r => {
    const p = r.price_now == null ? '--' : r.price_now.toFixed(2);
    const chg = r.chg_pct == null ? '--' : `<span class="${pctClass(r.chg_pct)}">${r.chg_pct > 0 ? '+' : ''}${r.chg_pct.toFixed(2)}%</span>`;
    const ml = r.ml_score == null ? '模型未训练' : `模型 ${r.ml_score.toFixed(0)}`;
    const res = `共振 ${r.score || 0}/9`;
    const tags = (r.tags || '').split(',').filter(Boolean).slice(0, 3).map(t =>
      `<span class="tagb">${TAG_LABELS[t] || t}</span>`).join('');
    const multi = r.multi_tf && r.multi_tf.length ? `<span class="radar-multi">${r.multi_tf.length}周期共振</span>` : '<span class="radar-multi muted">暂无多周期共振</span>';
    return `<button class="radar-row" onclick="viewRadarRow(${radarFiltered.indexOf(r)})">
      <span class="radar-main"><b>${esc(r.name)}</b><small>${r.code} · ${tfName[r.tf] || r.tf} · 确认 ${r.confirm || '--'}</small></span>
      <span class="radar-price"><b>${p}</b><small>${chg}</small></span>
      <span class="radar-score"><b>${r.ml_score == null ? res : `模型 ${r.ml_score.toFixed(0)}`}</b><small>${ml} · ${res}</small>${multi}${tags}</span>
    </button>`;
  }).join('');
}

async function loadRadar() {
  try {
    const r = await apiFetch('/api/radar');
    const d = await r.json();
    radarAll = d.rows || [];
    const el = document.getElementById('radarUpd');
    if (el) el.textContent = d.ts ? `更新 ${new Date(d.ts * 1000).toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'})}` : '等待扫描';
    applyRadarFilters();
  } catch (e) { /* 下轮重试 */ }
}

function setRadar(rows, ts) {
  radarAll = rows || [];
  const el = document.getElementById('radarUpd');
  if (el && ts) el.textContent = `更新 ${new Date(ts * 1000).toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'})}`;
  applyRadarFilters();
}

function viewRadarRow(i) {
  const r = radarFiltered[i];
  if (r) { openStockInChart(r.name, r.code, `${r.tf === 'day' ? '日线' : '周线'}底背离`); switchTf(r.tf); }
}

function sseCodes() {
  const codes = [];
  watchData.forEach(s => codes.push(s.code));
  idxData.forEach(i => codes.push(i.code));
  etfData.forEach(e => codes.push(e.code));
  return [...new Set(codes)].slice(0, 60).join(',');
}

function setSseUI(ok) {
  const dot = document.getElementById('sseDot');
  if (!dot) return;
  dot.className = 'sse-dot ' + (ok ? 'on' : 'off');
  dot.title = ok ? 'SSE 实时推送已连接' : 'SSE 未连接，行情走轮询';
}

/* 关注代码集变化(增删自选/左栏刷新)时重连SSE */
function ensureSSE() {
  const c = sseCodes();
  if (!c || !window.EventSource) return;
  if (es && c === sseLastCodes) return;
  sseLastCodes = c;
  try { es && es.close(); } catch (e) { /* 忽略 */ }
  let url = '/api/stream?codes=' + encodeURIComponent(c);
  if (authToken) url += '&token=' + encodeURIComponent(authToken);
  es = new EventSource(url);
  es.onopen = () => { sseOk = true; setSseUI(true); };
  es.onerror = () => { sseOk = false; setSseUI(false); };  // EventSource自动重连
  es.onmessage = ev => {
    try { handleSSE(JSON.parse(ev.data)); } catch (e) { /* 忽略坏帧 */ }
  };
}

function handleSSE(ev) {
  if (ev.type === 'quotes') {
    applyQuoteDiff(ev.data || {});
  } else if (ev.type === 'scan_progress') {
    document.getElementById('divUpd').textContent =
      `扫描中 ${ev.done}/${ev.total} (${ev.pct}%)`;
  } else if (ev.type === 'scan_done') {
    loadDivs();
    toast('底背离全市场扫描完成');
  } else if (ev.type === 'intraday') {
    setIntraday(ev.data || []);
  } else if (ev.type === 'resonance') {
    setResonance(ev.data || []);
  } else if (ev.type === 'radar') {
    setRadar(ev.data || [], ev.ts);
  }
}

/* 行情diff: 更新自选行/左栏列表/中栏头部 */
function applyQuoteDiff(diff) {
  let listDirty = false;
  for (const [code, q] of Object.entries(diff)) {
    if (!q || !q.price) continue;
    const i = idxData.find(x => x.code === code);
    if (i) {
      i.price = q.price; i.chg = q.chg; i.chg_pct = q.chg_pct; i.amount = q.amount;
      listDirty = true;
    }
    const e = etfData.find(x => x.code === code);
    if (e) {
      e.price = q.price; e.chg = q.chg; e.chg_pct = q.chg_pct; e.amount = q.amount;
      listDirty = true;
    }
    const prev = quoteMap[code];
    quoteMap[code] = Object.assign({}, prev, q, {
      ok: true,
      is_index: (prev && prev.is_index) || code.startsWith('sh000') || code.startsWith('sz399'),
    });
    updateWatchRow(code);
    if (code === curEtf) updateChartHeader(q);
  }
  if (listDirty) { renderIdxList(); renderEtfList(); }
  renderOvWatch();
}

function updateChartHeader(q) {
  const p = document.getElementById('chPrice');
  p.textContent = q.price.toFixed(2);
  p.className = 'ch-price ' + pctClass(q.chg_pct);
  const c = document.getElementById('chChg');
  c.textContent = `${q.chg > 0 ? '+' : ''}${q.chg.toFixed(2)}  ${fmtPct(q.chg_pct)}`;
  c.className = 'ch-chg ' + pctClass(q.chg_pct);
  document.getElementById('chAmount').textContent = (q.amount / 1e4).toFixed(2) + '亿';
}

/* ================= 盘中背离预览徽章 ================= */
/* 徽章增删会改变行高: 重置每页条数并重渲染, 避免末行被固定高度裁切 */
function repaginateWatch() {
  watchPage.size = 0;
  renderWatchList();
}

function setIntraday(rows) {
  const prevKeys = Object.keys(intradayMap).flatMap(code => Object.keys(intradayMap[code] || {}).map(tf => `${code}|${tf}`));
  intradayMap = {};
  rows.forEach(r => {
    if (!intradayMap[r.code]) intradayMap[r.code] = {};
    intradayMap[r.code][r.tf || '60m'] = r;
  });
  if (updateIntradayBadges()) repaginateWatch();
  const fresh = Object.keys(intradayMap).flatMap(code => Object.keys(intradayMap[code]).map(tf => `${code}|${tf}`))
    .filter(k => !prevKeys.includes(k));
  if (fresh.length) {
    const names = fresh.slice(0, 3).map(k => {
      const [code, tf] = k.split('|');
      return `${intradayMap[code][tf].name}(${TF_CN[tf] || tf})`;
    }).join('、');
    toast(`盘中背离: ${names}${fresh.length > 3 ? ' 等' : ''}`);
  }
}

async function loadIntraday() {
  try {
    const r = await apiFetch('/api/intraday');
    const d = await r.json();
    setIntraday(d.rows || []);
  } catch (e) { /* 下轮重试 */ }
}

function updateIntradayBadges() {
  let changed = false;
  document.querySelectorAll('.watch-item').forEach(el => {
    const signals = intradayMap[el.dataset.code] || {};
    const wanted = Object.values(signals);
    let box = el.querySelector('.intraday-badges');
    if (wanted.length) {
      if (!box) {
        box = document.createElement('span');
        box.className = 'intraday-badges';
        el.querySelector('.wname').appendChild(box);
        changed = true;
      }
      box.innerHTML = wanted.map(r => {
        const shortTf = (TF_CN[r.tf] || r.tf).replace('分钟', '分');
        const label = r.div === 'bear' ? `${TF_CN[r.tf] || r.tf}顶背离预览` : `${TF_CN[r.tf] || r.tf}底背离预览`;
        return `<span class="intraday-badge${r.div === 'bear' ? ' down' : ''}" title="${label}: 价格${r.price1.toFixed(2)}→${r.price2.toFixed(2)} DIF ${r.dif1}→${r.dif2}(未收盘确认)">${shortTf}${r.div === 'bear' ? '顶' : '底'}背离</span>`;
      }).join('');
    } else if (box) {
      box.remove();
      changed = true;
    }
  });
  return changed;
}

/* ================= 多周期共振徽章(60分/日/周) ================= */
const TF_CN = {'1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '60m': '60分钟', 'day': '日线', 'week': '周线'};
let resMap = {};   // code -> 共振行

function setResonance(rows) {
  const prevKeys = Object.keys(resMap);
  resMap = {};
  rows.forEach(r => { resMap[r.code] = r; });
  if (updateResBadges()) repaginateWatch();
  const fresh = Object.keys(resMap).filter(k => !prevKeys.includes(k));
  if (fresh.length) {
    const names = fresh.slice(0, 3).map(k => `${resMap[k].name}(${resMap[k].tfs.map(t => TF_CN[t]).join('+')})`).join('、');
    toast(`多周期共振: ${names}${fresh.length > 3 ? ' 等' : ''}`);
  }
}

async function loadResonance() {
  try {
    const r = await apiFetch('/api/resonance');
    const d = await r.json();
    setResonance(d.rows || []);
  } catch (e) { /* 下轮重试 */ }
}

function updateResBadges() {
  let changed = false;
  document.querySelectorAll('.watch-item').forEach(el => {
    const r = resMap[el.dataset.code];
    let b = el.querySelector('.res-badge');
    if (r) {
      if (!b) {
        b = document.createElement('span');
        b.className = 'res-badge';
        el.querySelector('.wname').appendChild(b);
        changed = true;
      }
      b.textContent = `${r.dir === 'bull' ? '↑' : '↓'}${r.tfs.length}周期共振`;
      b.classList.toggle('up', r.dir === 'bull');
      b.classList.toggle('down', r.dir === 'bear');
      b.title = r.detail.map(x =>
        `${TF_CN[x.tf] || x.tf} ${x.word}(${x.ago}根K线前, ${x.label})`).join('\n');
    } else if (b) {
      b.remove();
      changed = true;
    }
  });
  return changed;
}

/* ================= 搜索 ================= */
async function doSearch() {
  const inp = document.getElementById('q');
  const q = inp.value.trim();
  const box = document.getElementById('results');
  if (!q) {                          // 空输入 → 清空并收起结果区
    box.innerHTML = '';
    box.style.display = 'none';      // 同时消除 margin-top:10px 的残留空隙
    renderWatchList();               // 列表可用高度变大, 重算分页对齐
    return;
  }
  const myQ = q;                     // 捕获本次关键词, 用于丢弃过期响应
  box.style.display = '';            // 有词时恢复显示
  box.innerHTML = '<div class="empty">搜索中…</div>';
  const r = await apiFetch('/api/search?q=' + encodeURIComponent(q));
  const items = await r.json();
  // 响应回来时输入框已变 → 本次结果作废(快速连续输入/清空时的竞态防护)
  if (inp.value.trim() !== myQ) return;
  if (!items.length) {
    box.innerHTML = '<div class="empty">未找到相关标的</div>';
    return;
  }
  box.innerHTML = items.map(it => `
    <div class="item">
      <span class="name">${esc(it.name)}</span>
      <span class="code">${esc(it.code)}</span>
      <span class="tag ${it.type.toLowerCase()}">${esc(it.type)}</span>
      <span class="spacer"></span>
      <span class="group-pick">
        <select id="grp-${esc(it.code)}">
          ${groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
          <option value="新分组">＋新分组</option>
        </select>
        <input id="newgrp-${esc(it.code)}" placeholder="新分组名" style="display:none;width:80px">
      </span>
      <button class="add-btn" onclick="addStock('${esc(it.code)}','${esc(it.name)}')">添加</button>
    </div>`).join('');
  items.forEach(it => {
    const sel = document.getElementById('grp-' + it.code);
    if (sel) sel.onchange = () => {
      document.getElementById('newgrp-' + it.code).style.display =
        sel.value === '新分组' ? '' : 'none';
    };
  });
}

async function addStock(code, name) {
  let group = document.getElementById('grp-' + code).value;
  if (group === '新分组') {
    group = document.getElementById('newgrp-' + code).value.trim() || '自选';
  }
  const r = await apiFetch('/api/stocks', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({code, name, group})
  });
  const res = await r.json();
  toast(res.ok ? `已添加 ${name} → ${group}` : res.msg || '添加失败');
  if (res.ok) { loadWatch(); doSearch(); loadDivs(); }
}

async function delStock(code) {
  const r = await apiFetch('/api/stocks?code=' + encodeURIComponent(code), {method: 'DELETE'});
  const res = await r.json();
  toast(res.ok ? '已删除 ' + code : res.msg || '删除失败');
  if (res.ok) { loadWatch(); loadDivs(); }
}

/* 中栏"＋自选": 将当前查看的标的加入右侧监控列表(默认分组) */
async function addCurToWatch() {
  if (!curEtf) { toast('请先选择标的'); return; }
  const name = document.getElementById('chName').textContent.trim();
  if (!name) { toast('请先选择标的'); return; }
  if (watchData.some(s => s.code === curEtf)) { toast(`${name} 已在监控列表中`); return; }
  const r = await apiFetch('/api/stocks', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({code: curEtf, name, group: '自选'})
  });
  const res = await r.json();
  toast(res.ok ? `已添加 ${name} → 自选` : res.msg || '添加失败');
  if (res.ok) { loadWatch(); loadDivs(); }
}

/* ================= 系统面板(健康+日志) ================= */
let sysTimer = null;
let logLvl = '';

/* 系统状态视图: 进入挂载数据+15秒定时刷新, 离开卸载(由showView统一调度) */
function startSysView() {
  loadSysData();
  clearInterval(sysTimer);
  sysTimer = setInterval(loadSysData, 15000);
}

function stopSysTimer() {
  clearInterval(sysTimer);
  sysTimer = null;
}

async function loadSysData() {
  loadSysHealth();
  loadSysLogs();
  loadModelChoices();
  loadEntryRule();
}

function renderRuleOptions(boxId, options, selected, prefix) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const chosen = new Set(selected || ['steady']);
  box.innerHTML = Object.keys(options || {}).map(rule => `<label class="entry-rule-option"><input type="checkbox" value="${rule}" data-rule-group="${prefix}" ${chosen.has(rule) ? 'checked' : ''} onchange="saveRuleSelections()"> ${options[rule]}</label>`).join('');
}

function renderIntradayTimeframes(options, selected) {
  const box = document.getElementById('intradayTimeframeOptions');
  if (!box) return;
  const chosen = new Set(selected || ['60m']);
  box.innerHTML = options.map(tf => `<label class="intraday-timeframe-option"><input type="checkbox" value="${tf}" ${chosen.has(tf) ? 'checked' : ''} onchange="saveIntradayTimeframes()"> ${TF_CN[tf] || tf}</label>`).join('');
}

async function saveIntradayTimeframes() {
  const checks = [...document.querySelectorAll('#intradayTimeframeOptions input:checked')];
  if (!checks.length) {
    toast('至少选择一个盘中周期');
    loadEntryRule();
    return;
  }
  checks.forEach(x => { x.disabled = true; });
  try {
    const r = await apiFetch('/api/entry-rule', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({timeframes: checks.map(x => x.value)})
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.msg || '保存失败');
    renderIntradayTimeframes(data.timeframe_options || [], data.timeframes || checks.map(x => x.value));
    toast('自选股监控周期已保存');
  } catch (e) {
    toast(e.message || '盘中周期保存失败');
    loadEntryRule();
  }
}

async function loadEntryRule() {
  try {
    const r = await apiFetch('/api/entry-rule');
    const data = await r.json();
    renderRuleOptions('entryRuleOptions', data.rules || {}, data.entry_rules || [data.rule || 'steady'], 'entry');
    renderRuleOptions('sellRuleOptions', data.sell_rules || {}, data.selected_sell_rules || [data.sell_rule || 'steady'], 'sell');
    const sellEnabled = document.getElementById('sellAlertEnabled');
    if (sellEnabled) sellEnabled.checked = data.sell_enabled !== false;
    renderIntradayTimeframes(data.timeframe_options || [], data.timeframes || ['60m']);
    updateEntryRuleNote(data);
  } catch (e) {
    const note = document.getElementById('entryRuleNote');
    if (note) note.textContent = '买点规则获取失败';
  }
}

function updateEntryRuleNote(data) {
  const note = document.getElementById('entryRuleNote');
  if (!note) return;
  const buys = (data.entry_rules || [data.rule]).map(rule => data.rules && data.rules[rule]).filter(Boolean).join('；');
  const sells = (data.selected_sell_rules || [data.sell_rule]).map(rule => data.sell_rules && data.sell_rules[rule]).filter(Boolean).join('；');
  note.textContent = `买点：${buys}；卖点：${sells}`;
}

async function saveRuleSelections() {
  const buyChecks = [...document.querySelectorAll('#entryRuleOptions input:checked')];
  const sellChecks = [...document.querySelectorAll('#sellRuleOptions input:checked')];
  if (!buyChecks.length || !sellChecks.length) {
    toast('买点和卖点都至少选择一个规则');
    loadEntryRule();
    return;
  }
  const controls = [...document.querySelectorAll('#entryRuleOptions input, #sellRuleOptions input')];
  controls.forEach(x => { x.disabled = true; });
  const enabled = document.getElementById('sellAlertEnabled');
  try {
    const r = await apiFetch('/api/entry-rule', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({entry_rules: buyChecks.map(x => x.value),
                            selected_sell_rules: sellChecks.map(x => x.value),
                            sell_enabled: enabled ? enabled.checked : true})
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.msg || '保存失败');
    renderRuleOptions('entryRuleOptions', data.rules || {}, data.entry_rules, 'entry');
    renderRuleOptions('sellRuleOptions', data.sell_rules || {}, data.selected_sell_rules, 'sell');
    updateEntryRuleNote(data);
    toast('买卖点规则已保存');
  } catch (e) {
    toast(e.message || '规则保存失败');
    loadEntryRule();
  }
}

async function saveSellRule() {
  await saveRuleSelections();
}

async function saveEntryRule() {
  await saveRuleSelections();
}

async function loadModelChoices() {
  try {
    const r = await apiFetch('/api/models');
    const data = await r.json();
    renderModelChoices(data);
  } catch (e) {
    const box = document.getElementById('modelSelectRows');
    if (box) box.innerHTML = '<div class="empty">模型列表获取失败</div>';
  }
}

function renderModelChoices(data) {
  const box = document.getElementById('modelSelectRows');
  if (!box) return;
  const models = data.models || [];
  box.innerHTML = ['day', 'week'].map(tf => {
    const list = models.filter(m => m.tf === tf);
    const active = data.active && data.active[tf];
    const options = list.map(m =>
      `<option value="${esc(m.id)}" ${m.id === active ? 'selected' : ''}>` +
      `${esc(m.label || tf)} · ${esc(m.trained_at || m.created_at || '--')} · ` +
      `样本${m.n_samples || '--'} · 样本外AUC${m.wf_auc == null ? '--' : m.wf_auc}</option>`
    ).join('');
    return `<div class="model-select-row">` +
      `<div class="model-select-label"><b>${tf === 'day' ? '日线模型' : '周线模型'}</b>` +
      `<small>${active || '未选择'}</small></div>` +
      `<select data-model-tf="${tf}" onchange="selectModelVersion(this)">${options || '<option>暂无模型</option>'}</select>` +
      `<button type="button" class="model-refresh" title="刷新模型列表" onclick="loadModelChoices()">↻</button>` +
      `</div>`;
  }).join('');
}

async function selectModelVersion(select) {
  const tf = select.dataset.modelTf;
  const modelId = select.value;
  if (!modelId) return;
  select.disabled = true;
  try {
    const r = await apiFetch('/api/models', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tf: tf, model_id: modelId})
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.msg || '切换失败');
    toast(`已切换${tf === 'day' ? '日线' : '周线'}模型`);
    renderModelChoices(data);
    loadDivs();
    loadRadar();
  } catch (e) {
    toast(e.message || '模型切换失败');
    loadModelChoices();
  } finally {
    select.disabled = false;
  }
}

async function loadSysHealth() {
  try {
    const r = await apiFetch('/api/health');
    renderSysHealth(await r.json());
  } catch (e) {
    document.getElementById('sysHealth').innerHTML =
      '<div class="empty">健康数据获取失败(可能离线)</div>';
  }
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
        m = Math.floor(sec % 3600 / 60);
  return (d ? d + '天' : '') + (h || d ? h + '时' : '') + m + '分';
}

function renderSysHealth(h) {
  const o = h.obs || {};
  const scan = h.scan || {};
  const scanTxt = scan.scanning ?
    `扫描中 ${scan.done}/${scan.total}` :
    (scan.ts ? new Date(scan.ts * 1000).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}) : '未扫描');
  const card = (label, val, warn) =>
    `<div class="sh-card${warn ? ' warn' : ''}"><div class="sh-v">${val}</div><div class="sh-l">${label}</div></div>`;
  const domains = Object.entries((h.sources || {}).domains || {})
    .map(([d, s]) => `${d}${s.open_sec > 0 ? `(熔断中${s.open_sec}s)` : `(连续失败${s.fails})`}`)
    .join('、') || '正常';
  const hb = h.monitor_hb_age_sec;
  const hbOk = hb != null && hb >= 0 && hb <= 900;
  const hbTxt = hbOk
    ? (hb < 90 ? `${Math.floor(hb)}秒前` : `${Math.floor(hb / 60)}分前`)
    : (hb > 900 ? `${Math.floor(hb / 60)}分前` : '无心跳');
  const hbAlert = hbOk ? '' :
    `<div class="sh-alert">⚠ 监控进程疑似停止（最后心跳 ${hbTxt}），信号推送可能中断，请检查 monitor.py 是否在运行</div>`;
  document.getElementById('sysHealth').innerHTML =
    hbAlert +
    `<div class="sh-grid">` +
    card('运行时长', fmtUptime(o.uptime_sec || 0)) +
    card('24h错误', o.errors_24h || 0, (o.errors_24h || 0) > 0) +
    card('监控心跳', hbTxt, !hbOk) +
    card('缓冲事件', o.events || 0) +
    card('SSE订阅', h.sse_subs || 0) +
    card('K线缓存', (h.kline_bars || 0).toLocaleString()) +
    card('信号库', h.db_signals || 0) +
    `</div>` +
    `<div class="sh-row"><span>底背离扫描</span><b>${scanTxt}</b></div>` +
    `<div class="sh-row"><span>盘中背离</span><b>${h.intraday || 0} 条</b></div>` +
    `<div class="sh-row"><span>多周期共振</span><b>${h.resonance || 0} 条</b></div>` +
    `<div class="sh-row"><span>数据源域名</span><b>${esc(domains)}</b></div>` +
    `<div class="sh-row"><span>全局限流</span><b>${(h.sources || {}).rate_limiter ? ((h.sources.rate_limiter.rate || 0) + ' req/s, 余' + h.sources.rate_limiter.tokens + '令牌') : '--'}</b></div>`;
}

async function loadSysLogs() {
  try {
    const r = await apiFetch('/api/logs?limit=150' + (logLvl ? '&lvl=' + logLvl : ''));
    const d = await r.json();
    renderSysLogs(d.rows || []);
  } catch (e) {
    document.getElementById('sysLogs').innerHTML =
      '<div class="empty">日志获取失败(可能离线)</div>';
  }
}

function renderSysLogs(rows) {
  const box = document.getElementById('sysLogs');
  if (!rows.length) {
    box.innerHTML = '<div class="empty">暂无事件</div>';
    return;
  }
  box.innerHTML = rows.map(ev => {
    const t = new Date(ev.ts * 1000).toLocaleString('zh-CN',
      {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
       second: '2-digit', hour12: false});
    return `<div class="sl-row lvl-${ev.lvl.toLowerCase()}">` +
      `<span class="sl-t">${t}</span><span class="sl-l">${ev.lvl}</span>` +
      `<span class="sl-m">[${esc(ev.mod)}]</span><span class="sl-x">${esc(ev.msg)}</span></div>`;
  }).join('');
}

function setLogLvl(btn) {
  logLvl = btn.dataset.lvl || '';
  document.querySelectorAll('#sysLvls button').forEach(b =>
    b.classList.toggle('active', b === btn));
  loadSysLogs();
}

/* ================= AI选股面板(每交易日18:00自动 + 手动) ================= */
let aiTimer = null;
let aiTicks = 0;
let aiRunning = false;
let aiPickRows = [];
let ztPoolRows = [];
let ztDate = null;
let aiTab = 'picks';

/* AI选股视图: 进入挂载数据+定时刷新(运行中3秒/空闲30秒), 离开卸载(由showView统一调度) */
function startAiView() {
  loadAiConfig();
  loadAiPicks();
  loadZtPool();
  clearInterval(aiTimer);
  aiTicks = 0;
  aiTimer = setInterval(() => {
    aiTicks++;
    if (aiRunning) { loadAiPicks(); loadZtPool(); }
    else if (aiTicks % 10 === 0) loadAiPicks();
  }, 3000);
}

function stopAiTimer() {
  clearInterval(aiTimer);
  aiTimer = null;
}

async function loadAiConfig() {
  try {
    const r = await apiFetch('/api/ai/config');
    const c = await r.json();
    const key = document.getElementById('aiKey');
    key.value = '';
    key.placeholder = c.has_key ?
        `已保存 ${c.key_mask}（留空 = 保持不变）` : 'DeepSeek API Key（尚未配置）';
    const m = document.getElementById('aiModel');
    m.value = c.model || '';
    m.placeholder = c.default_model || 'deepseek-v4-flash';
    document.getElementById('aiSub').textContent =
        `每交易日 ${c.hour}:00 自动 · Top ${c.top_n}`;
  } catch (e) { /* 网络错误已有全局处理 */ }
}

async function saveAiCfg() {
  const btn = document.getElementById('aiSaveBtn');
  btn.disabled = true;
  try {
    const r = await apiFetch('/api/ai/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        api_key: document.getElementById('aiKey').value.trim(),
        model: document.getElementById('aiModel').value.trim()
      })
    });
    const d = await r.json();
    if (d.ok) {
      toast('AI配置已保存');
      loadAiConfig();
    } else toast(d.msg || '保存失败');
  } catch (e) {
    toast('保存失败, 请重试');
  } finally {
    btn.disabled = false;
  }
}

async function clearAiKey() {
  if (!confirm('确定清除已保存的 API Key 吗？')) return;
  try {
    await apiFetch('/api/ai/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({clear_key: true})
    });
    toast('API Key 已清除');
    loadAiConfig();
  } catch (e) {
    toast('操作失败, 请重试');
  }
}

async function testAi() {
  const btn = document.getElementById('aiTestBtn');
  const st = document.getElementById('aiStatus');
  btn.disabled = true;
  st.textContent = '连接测试中…';
  st.className = 'ai-status run';
  try {
    const r = await apiFetch('/api/ai/test', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        api_key: document.getElementById('aiKey').value.trim(),
        model: document.getElementById('aiModel').value.trim()
      })
    });
    const d = await r.json();
    st.textContent = d.msg || (d.ok ? '连接成功' : '连接失败');
    st.className = 'ai-status ' + (d.ok ? 'ok' : 'err');
  } catch (e) {
    st.textContent = '测试失败(网络错误)';
    st.className = 'ai-status err';
  } finally {
    btn.disabled = false;
  }
}

async function runAiPick() {
  const btn = document.getElementById('aiRunBtn');
  btn.disabled = true;
  try {
    const r = await apiFetch('/api/ai/run');
    const d = await r.json();
    toast(d.msg || '已触发');
    if (d.ok) {
      aiRunning = true;
      const st = document.getElementById('aiStatus');
      st.textContent = '选股运行中, 请稍候…（DeepSeek 分析约需 10-60 秒）';
      st.className = 'ai-status run';
    }
  } catch (e) {
    toast('触发失败, 请重试');
  } finally {
    btn.disabled = false;
  }
}

async function loadAiPicks() {
  try {
    const r = await apiFetch('/api/ai/picks');
    renderAiPicks(await r.json());
  } catch (e) { /* 面板打开期间网络抖动忽略, 下轮刷新 */ }
}

async function triggerZtScan() {
  const btn = document.getElementById('ztScanBtn');
  btn.disabled = true;
  try {
    const r = await apiFetch('/api/zt/scan', {method: 'POST'});
    const d = await r.json();
    toast(d.msg || '已触发');
    if (d.ok) setTimeout(loadZtPool, 3000);   // 扫描约需数秒
  } catch (e) {
    toast('触发失败, 请重试');
  } finally {
    btn.disabled = false;
  }
}

const AI_SRC_NAMES = {ai: 'DeepSeek 游资精选', model: '动能分 Top10（降级）',
                      'ai+model': 'AI 精选 + 动能分补齐'};

function _zttjTxt(e) {
  const lbc = e.lbc || 1;
  if (e.days && e.ct && e.ct < e.days) return `${e.days}天${e.ct}板`;
  return lbc >= 2 ? `${lbc}连板` : '首板';
}

/* 现金转化率(每股经营现金流/每股收益): >=1利润含金量高(绿), <0.3应收堆积警惕(红);
   亏损股看经营现金流正负(为负=失血,红), 其余灰 */
function _ccrCell(e) {
  if (e.ccr != null) {
    const cls = e.ccr >= 1 ? 'down' : (e.ccr < 0.3 ? 'up' : '');
    return `<b class="${cls}">${e.ccr.toFixed(2)}</b>` +
        (e.ccr_avg != null ? `<i class="ccr-avg">/${e.ccr_avg.toFixed(2)}</i>` : '');
  }
  if ((e.eps || 0) < 0) {
    const bleed = e.ocf_ps != null && e.ocf_ps < 0;
    return bleed ? '<b class="up">亏损·失血</b>' : '亏损';
  }
  return '--';
}

/* 近30日AI选股5日胜率走势(SVG折线): AI精选 vs 动能分Top10降级, 供人工决策是否续费 */
function renderAiTrend(series, stats) {
  const el = document.getElementById('aiTrend');
  if (!el) return;
  const pts = (series || []).filter(x =>
      (x.ai && x.ai.win5 != null) || (x.model && x.model.win5 != null));
  if (pts.length < 2) { el.style.display = 'none'; return; }
  el.style.display = '';
  const W = 640, H = 150, L = 36, R = 10, T = 10, B = 20;
  const iw = W - L - R, ih = H - T - B;
  const x = i => L + iw * i / (pts.length - 1);
  const y = v => T + ih * (1 - v / 100);
  const path = src => {
    let d = '', pen = false;
    pts.forEach((p, i) => {
      const v = p[src] && p[src].win5;
      if (v == null) { pen = false; return; }
      d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
      pen = true;
    });
    return d;
  };
  const grid = [0, 50, 100].map(v =>
      `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="var(--line)"/>` +
      `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end" class="at-txt">${v}</text>`).join('');
  const bs = (stats && stats.by_source) || {};
  const aiW = bs.ai && bs.ai.win5, mdW = bs.model && bs.model.win5;
  const cmp = (aiW != null || mdW != null)
      ? `AI ${aiW != null ? aiW + '%' : '--'} · 动能分 ${mdW != null ? mdW + '%' : '--'}`
      : '';
  el.innerHTML = `
    <div class="ai-trend-head">
      <span>近30日选股 5日胜率走势
        <small><i class="at-ai"></i>AI精选 <i class="at-md"></i>动能分Top10</small></span>
      <span class="ai-trend-cmp">${cmp}</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" class="ai-trend-svg" preserveAspectRatio="none">
      ${grid}
      <path d="${path('ai')}" fill="none" stroke="var(--up)" stroke-width="2"/>
      <path d="${path('model')}" fill="none" stroke="#3b82f6" stroke-width="1.5"
            stroke-dasharray="4 3"/>
      <text x="${L}" y="${H - 6}" class="at-txt">${pts[0].date.slice(5)}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end" class="at-txt">${pts[pts.length - 1].date.slice(5)}</text>
    </svg>`;
}

function renderAiPicks(d) {
  aiPickRows = d.rows || [];
  aiRunning = !!d.running;
  document.getElementById('aiRunBtn').disabled = aiRunning;
  const st = document.getElementById('aiStatus');
  if (aiRunning) {
    st.textContent = '选股运行中… 结果稍后自动刷新';
    st.className = 'ai-status run';
  } else if (d.msg) {
    st.textContent = d.msg;
    st.className = 'ai-status ' + (/失败|无可用/.test(d.msg) ? 'err' : 'ok');
  } else {
    st.textContent = '尚未运行过选股';
    st.className = 'ai-status';
  }
  // 近30日成绩统计(胜率/平均收益) + 5日胜率走势折线卡
  const s = d.stats, el = document.getElementById('aiStats');
  if (s && s.n) {
    const cell = (w, a) => w == null ? '--' : `${w}% / ${a > 0 ? '+' : ''}${a}%`;
    el.innerHTML = `近30日 ${s.n} 只 · 次日 <b>${cell(s.win1, s.avg1)}</b>` +
        ` · 3日 <b>${cell(s.win3, s.avg3)}</b> · 5日 <b>${cell(s.win5, s.avg5)}</b>`;
    el.title = '胜率 / 平均收益(自选股日涨停价起算)';
  } else {
    el.textContent = '';
  }
  renderAiTrend(d.series, d.stats);
  const box = document.getElementById('aiPicks');
  if (!d.date || !aiPickRows.length) {
    box.innerHTML = `<div class="empty">暂无选股结果：点击「立即选股」手动运行，` +
        `或等待每交易日 ${d.hour || 18}:00 自动运行</div>`;
    return;
  }
  const src = aiPickRows[0].source || 'model';
  box.innerHTML =
    `<div class="ai-date">${d.date} 涨停池 · 共 ${aiPickRows.length} 只 · ` +
    `<span class="ai-src src-${esc(src)}">${AI_SRC_NAMES[src] || esc(src)}</span></div>` +
    '<table class="ai-table"><thead><tr>' +
    '<th>#</th><th>股票</th><th>结构</th><th title="当日封板时间, 越早越强">封板</th>' +
    '<th title="当日换手率%">换手</th><th title="流通市值(亿)">市值</th>' +
    '<th title="当日同行业涨停家数">行业</th>' +
    '<th title="短线动能分(封板时间/炸板/换手/市值/封单/连板/板块效应加权)">动能分</th>' +
    '<th title="现金转化率/近4期均值: >=1利润含金量高(绿), <0.3警惕应收堆积(红); 亏损股看经营现金流正负">现金流</th>' +
    '<th>入选理由</th>' +
    '</tr></thead><tbody>' +
    aiPickRows.map((r, i) => {
      const e = r.extra || {};
      return `
      <tr onclick="viewAiPick(${i})">
        <td class="ai-rank">${i + 1}</td>
        <td class="dstock"><span class="dn">${esc(r.name || r.code)}</span><span class="dc">${r.code}</span></td>
        <td class="dv">${esc(_zttjTxt(e))}</td>
        <td class="dv">${esc(e.fbt_s || '--')}</td>
        <td class="dv">${e.hs != null ? e.hs.toFixed(1) + '%' : '--'}</td>
        <td class="dv">${e.ltsz != null ? e.ltsz.toFixed(0) : '--'}</td>
        <td class="dv" title="${esc(e.hybk || '--')}">${esc(e.hybk || '--')}</td>
        <td class="dv dsc"><b class="${r.score >= 75 ? 'sc-hi' : r.score >= 60 ? 'sc-mid' : 'sc-lo'}">${r.score != null ? r.score.toFixed(0) : '--'}</b></td>
        <td class="dv dsc">${_ccrCell(e)}</td>
        <td class="ai-reason">${esc(r.reason || '--')}</td>
      </tr>`;
    }).join('') +
    '</tbody></table>';
}

function viewAiPick(i) {
  const r = aiPickRows[i];
  if (!r) return;
  openStockInChart(r.name || r.code, r.code, 'AI选股 Top' + (i + 1));
  switchTf('day');
}

/* ---------- 涨停股池 Tab + 情绪面板 ---------- */

function switchAiTab(tab) {
  aiTab = tab;
  document.getElementById('tabPicks').classList.toggle('active', tab === 'picks');
  document.getElementById('tabPool').classList.toggle('active', tab === 'pool');
  document.getElementById('aiPicks').style.display = tab === 'picks' ? '' : 'none';
  document.getElementById('ztPool').style.display = tab === 'pool' ? '' : 'none';
}

async function loadZtPool() {
  try {
    const r = await apiFetch('/api/zt/pool');
    renderZtPool(await r.json());
  } catch (e) { /* 面板打开期间网络抖动忽略, 下轮刷新 */ }
}

const MOOD_CLS = {up: 'mood-up', down: 'mood-down', '': ''};

function renderZtPool(d) {
  ztPoolRows = d.rows || [];
  ztDate = d.date;
  renderMood(d.mood);
  const box = document.getElementById('ztPool');
  if (!d.date || !ztPoolRows.length) {
    box.innerHTML = `<div class="empty">暂无涨停池数据：交易日 15:20 后自动抓取，` +
        `或点击「扫描涨停池」手动触发${d.scanning ? '（扫描中…）' : ''}</div>`;
    return;
  }
  box.innerHTML =
    `<div class="ai-date">${d.date} 涨停股池 · 共 ${ztPoolRows.length} 只 · ` +
    `按动能分降序（剔除 ST/科创板/北交所）</div>` +
    '<table class="ai-table zt-table"><thead><tr>' +
    '<th>#</th><th>股票</th><th>结构</th><th title="当日封板时间, 越早越强">封板</th>' +
    '<th title="当日炸板次数, 越少越强">炸板</th>' +
    '<th title="当日换手率%">换手</th><th title="流通市值(亿)">市值</th>' +
    '<th title="封单金额(亿)">封单</th><th>行业</th>' +
    '<th title="短线动能分(封板时间/炸板/换手/市值/封单/连板/板块效应加权)">动能分</th>' +
    '<th title="结构标签: 首板/N连板/早封/尾盘板/烂板/强封单/板块效应">标签</th>' +
    '</tr></thead><tbody>' +
    ztPoolRows.map((r, i) => `
      <tr onclick="viewZtPick(${i})">
        <td class="ai-rank">${i + 1}</td>
        <td class="dstock"><span class="dn">${esc(r.name || r.code)}</span><span class="dc">${r.code}</span></td>
        <td class="dv">${esc(_zttjTxt(r))}</td>
        <td class="dv">${String(Math.floor(r.fbt / 100)).padStart(2, '0')}:${String(r.fbt % 100).padStart(2, '0')}</td>
        <td class="dv">${r.zbc || 0}</td>
        <td class="dv">${r.hs != null ? r.hs.toFixed(1) + '%' : '--'}</td>
        <td class="dv">${r.ltsz != null ? r.ltsz.toFixed(0) : '--'}</td>
        <td class="dv">${r.fund != null ? r.fund.toFixed(1) : '--'}</td>
        <td class="dv" title="${esc(r.hybk || '--')}">${esc(r.hybk || '--')}</td>
        <td class="dv dsc"><b class="${r.score >= 75 ? 'sc-hi' : r.score >= 60 ? 'sc-mid' : 'sc-lo'}">${r.score != null ? r.score.toFixed(0) : '--'}</b></td>
        <td class="zt-tags">${esc(r.tags || '--')}</td>
      </tr>`).join('') +
    '</tbody></table>';
}

function renderMood(m) {
  const box = document.getElementById('aiMood');
  if (!m) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML =
    `<span class="mood-item ${MOOD_CLS[m.stage_cls] || ''}">` +
    `<b>情绪温度 ${m.temp}</b>（${m.stage}期）</span>` +
    `<span class="mood-item">涨停 <b class="up">${m.zt_n}</b></span>` +
    `<span class="mood-item">跌停 <b class="down">${m.dt_n}</b></span>` +
    `<span class="mood-item">炸板率 <b>${m.zb_rate}%</b></span>` +
    `<span class="mood-item">最高 <b>${m.max_lbc}连板</b></span>` +
    `<span class="mood-item">2板以上 <b>${m.lbc2_n}家</b></span>`;
}

function viewZtPick(i) {
  const r = ztPoolRows[i];
  if (!r) return;
  openStockInChart(r.name || r.code, r.code, '涨停池 #' + (i + 1));
  switchTf('day');
}

/* ================= PWA / 网络状态 ================= */
/* Service Worker 注册: 静态外壳缓存 + 离线快照 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/static/sw.js').catch(() => {});
  });
}

/* 离线横幅: 断网提示(SW缓存的壳仍可打开, 行情暂停更新) */
function updateOnlineUI() {
  const b = document.getElementById('offlineBanner');
  if (b) b.style.display = navigator.onLine ? 'none' : 'flex';
}
window.addEventListener('online', updateOnlineUI);
window.addEventListener('offline', updateOnlineUI);
updateOnlineUI();

/* iOS 主屏安装引导: Safari 分享 → 添加到主屏幕(仅提示一次, 已安装/已关闭不再弹) */
function showIosGuide() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = navigator.standalone === true ||
    matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !standalone && !localStorage.getItem('ios_guide_done')) {
    const g = document.getElementById('iosGuide');
    if (g) g.style.display = 'flex';
  }
}
function dismissIosGuide() {
  localStorage.setItem('ios_guide_done', '1');
  document.getElementById('iosGuide').style.display = 'none';
}
showIosGuide();

/* ================= 启动 ================= */
document.getElementById('q').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});
document.getElementById('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 400);
});

/* ================= 底背离标的面板 ================= */
let divAll = [];        // 全部行(最近30个扫描日)
let divFiltered = [];   // 筛选后的行
let divDisplayRows = []; // 当前筛选结果按表格排序后的行
let divFolded = 0;      // 被优先级过滤折叠的低分行数
let divProfilePending = 0;
let divRetryTimer = null;

let divSnapshots = [];
let divSnapshotId = '';
let divLag = Number(localStorage.getItem('div_lag') || 4);
if (![2, 3, 4].includes(divLag)) divLag = 4;
const divLagSelect = document.getElementById('divLag');
if (divLagSelect) divLagSelect.value = String(divLag);

async function loadDivs(snapshotId = divSnapshotId) {
  try {
    const params = new URLSearchParams({lag: String(divLag)});
    if (snapshotId) params.set('snapshot_id', snapshotId);
    const r = await apiFetch('/api/divergences?' + params.toString());
    const data = await r.json();
    if (!data.ok && data.msg) throw new Error(data.msg);
    if (!data.scanning || data.snapshot) {
      divSnapshots = data.snapshots || divSnapshots;
      if (data.snapshot && data.snapshot.id) divSnapshotId = String(data.snapshot.id);
      renderDivSnapshotOptions();
    }
    renderDivs(data);
  } catch (e) { /* 下轮重试 */ }
}

function changeDivLag() {
  const sel = document.getElementById('divLag');
  const value = Number(sel ? sel.value : 4);
  divLag = [2, 3, 4].includes(value) ? value : 4;
  localStorage.setItem('div_lag', String(divLag));
  divSnapshotId = divSnapshotId || '';
  loadDivs(divSnapshotId);
}

function renderDivSnapshotOptions() {
  const sel = document.getElementById('divDate');
  const note = document.getElementById('divSnapshotNote');
  if (!sel) return;
  const current = divSnapshotId;
  if (!divSnapshots.length) {
    sel.innerHTML = '<option value="">暂无自动或手动扫描记录</option>';
    if (note) note.textContent = '当前数据库没有保存更早的扫描快照';
    return;
  }
  const triggerName = {auto: '自动扫描', manual: '手动扫描'};
  sel.innerHTML = divSnapshots.filter(s => s.trigger === 'auto' || s.trigger === 'manual').map(s => {
    const stamp = new Date(s.captured_at * 1000).toLocaleString('zh-CN',
      {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false});
    const label = `${triggerName[s.trigger]}时间 ${stamp} | 数据截止 ${s.data_asof}`;
    return `<option value="${s.id}">${esc(label)}</option>`;
  }).join('');
  if (!sel.options.length) {
    sel.innerHTML = '<option value="">暂无自动或手动扫描记录</option>';
    if (note) note.textContent = '当前数据库没有保存更早的扫描快照';
    return;
  }
  if (note) note.textContent = '每次扫描完成后自动保存独立快照，历史快照不会被覆盖';
  const visible = divSnapshots.filter(s => s.trigger === 'auto' || s.trigger === 'manual');
  sel.value = visible.some(s => String(s.id) === current)
    ? current : String(visible[0].id);
}

function changeDivSnapshot() {
  const sel = document.getElementById('divDate');
  divSnapshotId = sel ? sel.value : '';
  loadDivs(divSnapshotId);
}

function openDivBacktest() {
  const box = document.getElementById('divBacktestBox');
  const sel = document.getElementById('backtestSnapshot');
  if (!box || !sel) return;
  const visible = divSnapshots.filter(s => s.trigger === 'auto' || s.trigger === 'manual');
  sel.innerHTML = visible.length ? visible.map(s => {
    const stamp = new Date(s.captured_at * 1000).toLocaleString('zh-CN',
      {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false});
    return `<option value="${s.id}">${esc(`${s.scan_date || '--'} · ${stamp} · ${s.row_count || 0}条`)}</option>`;
  }).join('') : '<option value="">暂无历史扫描快照</option>';
  if (divSnapshotId && visible.some(s => String(s.id) === String(divSnapshotId))) {
    sel.value = divSnapshotId;
  }
  box.style.display = 'flex';
  runDivBacktest();
}

function closeDivBacktest() {
  const box = document.getElementById('divBacktestBox');
  if (box) box.style.display = 'none';
}

function backtestMetric(value, suffix = '%') {
  if (value == null) return '--';
  const cls = value > 0 ? 'up' : value < 0 ? 'down' : '';
  return `<span class="${cls}">${value > 0 ? '+' : ''}${value}${suffix}</span>`;
}

function renderBacktestAggregate(a, horizons) {
  const cells = horizons.map(n => `
    <div class="sc-cell">
      <div class="sc-n">确认后${n}日</div>
      <div class="sc-win">${a[`win${n}`] == null ? '--' : a[`win${n}`] + '%'}</div>
      <div class="sc-avg">均收益 ${backtestMetric(a[`avg${n}`])}</div>
      <div class="sc-cnt">${a[`n${n}`] || 0}个成熟样本 / ${a.samples || 0}个信号</div>
    </div>`).join('');
  return `<div class="sc-cells backtest-cells">${cells}</div>`;
}

function renderBacktestTable(title, groups, horizons) {
  if (!groups || !groups.length) return '';
  const head = horizons.map(n => `<th>${n}日胜率</th><th>${n}日均收</th>`).join('');
  const body = groups.map(g => `<tr><td>${esc(g.name)}</td><td>${g.samples || 0}</td>${horizons.map(n =>
    `<td>${g[`win${n}`] == null ? '--' : g[`win${n}`] + '%'}</td><td>${backtestMetric(g[`avg${n}`])}</td>`).join('')}</tr>`).join('');
  return `<h4>${title}</h4><table class="stats-table"><thead><tr><th>分组</th><th>信号数</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderDivBacktest(payload) {
  const body = document.getElementById('divBacktestBody');
  if (!body) return;
  if (!payload || !payload.by_lag) {
    body.innerHTML = '<div class="empty">暂无可回测的历史快照</div>';
    return;
  }
  const horizons = payload.horizons || [1, 3, 5, 10];
  const lagNames = {2: '已收盘第二根', 3: '已收盘第三根', 4: '已收盘第四根'};
  const sections = Object.entries(payload.by_lag).map(([lag, result]) => {
    const meta = result.snapshot || {};
    return `<section class="backtest-section">
      <h3>${lagNames[lag] || `确认${lag}根`} <small>${esc(meta.scan_date || '--')}</small></h3>
      ${renderBacktestAggregate(result.overall || {}, horizons)}
      ${renderBacktestTable('按共振分', result.by_score, horizons)}
      ${renderBacktestTable('按周期', result.by_tf, horizons)}
    </section>`;
  }).join('');
  body.innerHTML = `<div class="sc-note">扫描日期：<b>${esc((payload.by_lag['4'] || payload.by_lag['2']).snapshot?.scan_date || '--')}</b> ·
    收益从各信号确认日收盘价起算；未走满对应交易日的样本不计入该周期胜率和均收益。</div>${sections}`;
}

async function runDivBacktest() {
  const body = document.getElementById('divBacktestBody');
  const sel = document.getElementById('backtestSnapshot');
  if (!body || !sel || !sel.value) {
    if (body) body.innerHTML = '<div class="empty">暂无历史扫描快照</div>';
    return;
  }
  body.innerHTML = '计算中…';
  try {
    const lag = document.getElementById('backtestLag')?.value || 'all';
    const params = new URLSearchParams({snapshot_id: sel.value, lag, horizons: '1,3,5,10'});
    const res = await apiFetch('/api/divergence-backtest?' + params.toString());
    const payload = await res.json();
    if (lag !== 'all' && payload.snapshot) {
      payload.by_lag = {[String(payload.lag)]: payload};
      payload.horizons = payload.horizons || [1, 3, 5, 10];
    }
    renderDivBacktest(payload);
  } catch (e) {
    body.innerHTML = '<div class="empty">回测失败，请检查本地K线缓存</div>';
  }
}

/* 手动触发全市场底背离重扫(不影响16:00定时扫描) */
async function triggerDivRescan() {
  const btn = document.getElementById('divRescanBtn');
  btn.disabled = true;
  try {
    const r = await apiFetch('/api/div/rescan', {method: 'POST'});
    const d = await r.json();
    toast(d.ok ? '已触发全市场底背离扫描, 约6分钟' : (d.msg || '触发失败'));
    if (d.ok) {
      // 立即更新完成后切到新生成的快照; 用户在下拉框选择旧快照时不会被后台刷新改写。
      divSnapshotId = '';
      setTimeout(loadDivs, 1000);
    }
  } catch (e) {
    toast('触发失败, 请稍后重试');
  } finally {
    setTimeout(() => { btn.disabled = false; }, 5000);   // 防连点
  }
}

/* 导出当前筛选结果为CSV(带BOM, Excel打开中文不乱码) */
function exportDivs() {
  if (!divFiltered.length) { toast('当前筛选无数据可导出'); return; }
  const head = ['代码', '名称', '行业板块', '地域板块', '最高利润主营业务', '周期', '现价',
    '低点1日期', '低点1价格', '低点2日期', '低点2价格', 'DIF1', 'DIF2',
    'DIF增量', '后3日涨幅%', '后5日涨幅%', '模型分', '确认日', '共振标签',
    '共振分', '扫描日'];
  const esc = v => {
    if (v === null || v === undefined) return '';
    v = String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [head.join(',')];
  for (const r of divFiltered) {
    lines.push([r.code, r.name, r.industry, r.region, r.primary_business || r.primary_concept, r.tf_name, r.price,
      r.date1, r.price1, r.date2, r.price2, r.dif1, r.dif2, r.dif_inc, r.chg3,
      r.chg5, r.ml_score, r.confirm, (r.tags || '').split(',').filter(Boolean)
        .map(t => TAG_LABELS[t] || t).join('/'), r.score, r.scan].map(esc).join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')],
      {type: 'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  const ts = new Date();
  const pad = n => String(n).padStart(2, '0');
  a.download = `底背离信号_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${divFiltered.length} 条信号`);
}

const DIV_PIE_COLORS = ['#c0392b', '#2878b5', '#2e8b57', '#b36b00', '#7d4e9b', '#0f766e', '#a23e48', '#6875a5', '#aa7b1f', '#4d7c0f'];

function profileGroups(rows, field, split = false) {
  const counts = new Map();
  const codes = new Set();
  for (const row of rows) {
    if (codes.has(row.code)) continue;
    codes.add(row.code);
    const values = split ? String(row[field] || '').split(',').map(x => x.trim()).filter(Boolean)
                         : [String(row[field] || '').trim()];
    for (const value of (values.length ? values : ['未匹配'])) {
      counts.set(value || '未匹配', (counts.get(value || '未匹配') || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
}

function renderPie(pieId, legendId, groups, total) {
  const pie = document.getElementById(pieId), legend = document.getElementById(legendId);
  if (!pie || !legend) return;
  if (!groups.length || !total) {
    pie.style.background = 'var(--line)';
    legend.innerHTML = '<span class="div-profile-status">暂无可统计数据</span>';
    return;
  }
  // Reserve the seventh row for the aggregated remainder when needed.
  const top = groups.slice(0, 6);
  const other = groups.slice(6).reduce((sum, item) => sum + item[1], 0);
  if (other) top.push(['其他', other]);
  // Keep real categories in share order and reserve the aggregate for the last row.
  let start = 0;
  const stops = top.map((item, i) => {
    const end = start + item[1] / total * 360;
    const stop = `${DIV_PIE_COLORS[i % DIV_PIE_COLORS.length]} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
    start = end;
    return stop;
  });
  pie.style.background = `conic-gradient(${stops.join(',')})`;
  legend.innerHTML = top.map((item, i) => {
    const pct = item[1] / total * 100;
    return `<div class="div-legend-item" title="${esc(item[0])} ${item[1]}只">
      <i style="background:${DIV_PIE_COLORS[i % DIV_PIE_COLORS.length]}"></i>
      <span>${esc(item[0])}</span><b>${item[1]} (${pct.toFixed(1)}%)</b></div>`;
  }).join('');
}

function renderDivBreakdown(rows, pending) {
  const unique = new Set(rows.map(r => r.code)).size;
  const industry = profileGroups(rows, 'industry');
  // One representative business per stock: highest profit in the latest report.
  const businesses = profileGroups(rows, 'primary_business');
  renderPie('industryPie', 'industryLegend', industry, unique);
  renderPie('conceptPie', 'conceptLegend', businesses, unique);
  const meta = document.getElementById('divBreakdownMeta');
  if (meta) meta.textContent = `按当前筛选结果统计，共 ${unique} 只股票；每只股票按最新财报最高利润主营业务计一次`;
  const status = document.getElementById('divProfileStatus');
  if (status) status.textContent = pending ? `板块资料加载中，剩余 ${pending} 只` : '板块资料已更新';
}

function renderDivs(d) {
  divAll = d.rows || [];
  if (d.snapshot && d.snapshot.id) divSnapshotId = String(d.snapshot.id);
  divProfilePending = d.profile_pending || 0;
  renderDivBreakdown(divAll, divProfilePending);
  const upd = document.getElementById('divUpd');
  let txt = '';
  if (d.scanning) {
    const pct = d.total ? Math.round(d.done / d.total * 100) : 0;
    txt = `扫描中 ${d.done}/${d.total} (${pct}%)`;
    clearTimeout(divRetryTimer);
    divRetryTimer = setTimeout(loadDivs, 10000);   // 扫描期间高频轮询进度
  } else if (d.snapshot) {
    const triggerName = {auto: '自动扫描', manual: '手动扫描'};
    const stamp = new Date(d.snapshot.captured_at * 1000).toLocaleString('zh-CN',
      {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false});
    txt = `${triggerName[d.snapshot.trigger] || d.snapshot.trigger}时间 ${stamp}，数据截止 ${d.snapshot.data_asof}`;
  } else if (d.ts) {
    txt = new Date(d.ts * 1000).toLocaleString('zh-CN',
        { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) + ' 扫描';
  }
  if (d.profile_pending) {
    clearTimeout(divRetryTimer);
    divRetryTimer = setTimeout(loadDivs, 1800);
  }
  upd.textContent = txt;
  updateDivDateOptions();
  updateDivConfirmOptions();
  applyDivFilters();
  renderOvDivs();
}

function updateDivDateOptions() {
  // 现在按不可变快照选择, 不再用会被后续扫描覆盖的 scan_last 字段重建列表。
  renderDivSnapshotOptions();
}

/* 确认日期下拉(按底层数据去重, 默认全部, 用户改选后保持) */
function updateDivConfirmOptions() {
  const sel = document.getElementById('divConfirm');
  if (!sel) return;
  const cur = sel.value;
  const dates = [...new Set(divAll.map(r => r.confirm).filter(Boolean))]
      .sort().reverse();
  sel.innerHTML = '<option value="">确认日: 全部</option>' +
      dates.map(dt => `<option value="${dt}">确认日: ${dt}</option>`).join('');
  sel.value = dates.includes(cur) ? cur : '';
}

/* 列排序: 默认按融合分降序(T3.1), 'asc'/'desc'=升降序; 空值排最后 */
let divSort = {key: 'fused', dir: 'desc'};
const DIV_SORT_COLS = {confirm: 'sortConfirm', dif_inc: 'sortDifInc', chg3: 'sortChg3',
                       chg5: 'sortChg5', ml_score: 'sortMl', score: 'sortScore', name: 'sortName', tf: 'sortTf',
                       date2: 'sortDate2', price2: 'sortPrice2', dif2: 'sortDif2',
                       fused: 'sortFused'};
const TAG_LABELS = {vol_shrink: '缩量', ma_hold: '均线托底', rsi_repair: 'RSI修复',
                    kdj_gold: 'KDJ金叉', week_align: '周线同向', vol_engulf: '放量反包'};

function toggleDivSort(key) {
  if (divSort.key === key) {
    divSort.dir = divSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    divSort = {key, dir: 'desc'};
  }
  for (const [k, id] of Object.entries(DIV_SORT_COLS)) {
    const el = document.getElementById(id);
    el.querySelector('.si').textContent =
        divSort.key === k ? (divSort.dir === 'desc' ? ' ▼' : ' ▲') : '';
  }
  renderDivTable();
}

function applyDivFilters() {
  const q = document.getElementById('divQ').value.trim().toLowerCase();
  const tf = document.getElementById('divTf').value;
  const date = '';
  const confirm = document.getElementById('divConfirm').value;
  const watch = document.getElementById('divWatch').value;
  const prio = document.getElementById('divPrio').value;
  const base = divAll.filter(r =>
      (!tf || r.tf === tf) &&
      (!date || r.scan === date) &&
      (!confirm || (r.confirm || '') === confirm) &&
      (watch === '' || !!r.watch === (watch === '1')) &&
      (!q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q)));
  /* 默认只看模型分>=60的中高优先级; 折叠数=仅被优先级过滤掉的行数 */
  divFolded = base.filter(r => r.ml_score == null || r.ml_score < 60).length;
  divFiltered = prio === 'good'
      ? base.filter(r => r.ml_score != null && r.ml_score >= 60)
      : base;
  renderDivBreakdown(divFiltered, divProfilePending);
  renderDivTable();
}

/* 点击"已折叠N条低分信号"展开全部 */
function showAllPrio() {
  document.getElementById('divPrio').value = '';
  applyDivFilters();
}

function renderDivTable() {
  const body = document.getElementById('divBody');
  document.getElementById('divCount').textContent =
      divAll.length ? `${divFiltered.length} / ${divAll.length} 条` : '';
  const fold = document.getElementById('divFolded');
  if (fold) {
    const prioOn = document.getElementById('divPrio').value === 'good';
    fold.style.display = (prioOn && divFolded > 0) ? '' : 'none';
    fold.textContent = `已折叠 ${divFolded} 条低分信号`;
  }
  if (!divAll.length) {
    body.innerHTML = '<tr><td colspan="15" class="empty">暂无底背离标的</td></tr>';
    return;
  }
  if (!divFiltered.length) {
    body.innerHTML = '<tr><td colspan="15" class="empty">无符合条件的标的</td></tr>';
    return;
  }
  let rows = divFiltered;
  if (divSort.key) {
    const k = divSort.key, s = divSort.dir === 'desc' ? -1 : 1;
    rows = [...divFiltered].sort((a, b) => {
      const va = a[k], vb = b[k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;    // 空值(K线不足/旧缓存)恒排最后
      if (vb == null) return -1;
      return va < vb ? -s : va > vb ? s : 0;
    });
  }
  divDisplayRows = rows;
  const fmtPct = v => v == null ? '--' :
      `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
  const idxOf = new Map(divFiltered.map((r, i) => [r, i]));   // 行对象→筛选结果下标
  const scoreCell = r => {
    if (r.score == null) return '<td class="dv">--</td>';
    const tags = (r.tags || '').split(',').filter(Boolean);
    const badges = tags.map(t =>
        `<span class="tagb" title="${TAG_LABELS[t] || t}">${TAG_LABELS[t] || t}</span>`).join('');
    return `<td class="dv dsc"><b class="${r.score >= 5 ? 'sc-hi' : r.score >= 3 ? 'sc-mid' : 'sc-lo'}">${r.score}</b>${badges}</td>`;
  };
  const mlCell = r => {
    if (r.ml_score == null) return '<td class="dv">--</td>';
    const v = r.ml_score;
    const cls = v >= 60 ? 'sc-hi' : v >= 40 ? 'sc-mid' : 'sc-lo';
    return `<td class="dv"><b class="${cls}">${v.toFixed(0)}</b>${prioBadge(r)}</td>`;
  };
  const prioBadge = r => {
    const map = {high: ['高', 'prio-high'], medium: ['中', 'prio-med'],
                 low: ['低', 'prio-low'], reject: ['弃', 'prio-low']};
    const m = map[r.prio];
    return m ? `<span class="prio-b ${m[1]}">${m[0]}</span>` : '';
  };
  const fusedCell = r => {
    if (r.fused == null) return '<td class="dv">--</td>';
    const v = r.fused;
    const cls = v >= 70 ? 'fz-hi' : v >= 40 ? 'fz-mid' : 'fz-lo';
    return `<td class="dv"><b class="${cls}">${v.toFixed(0)}</b></td>`;
  };
  body.innerHTML = rows.map((r, i) => `
    <tr class="div-row" onclick="viewDivIdx(${i})">
      <td class="di">${i + 1}</td>
      <td class="dstock"><span class="dn">${esc(r.name)}</span><span class="dc">${r.code}</span></td>
      <td class="dd profile-cell" title="${esc(r.industry || '未匹配')}">${esc(r.industry || '--')}</td>
      <td class="dd profile-cell" title="${esc(r.primary_business || r.primary_concept || '未匹配')}">${esc(r.primary_business || r.primary_concept || '--')}</td>
      <td class="dtf">${r.tf_name}</td>
      <td class="dd">${r.date1} → ${r.date2}</td>
      <td class="dv">${r.price1.toFixed(2)} → ${r.price2.toFixed(2)}</td>
      <td class="dv">${r.dif1} → ${r.dif2}</td>
      <td class="dv">${r.dif_inc != null ? r.dif_inc.toFixed(3) : '--'}</td>
      <td class="dv">${fmtPct(r.chg3)}</td>
      <td class="dv">${fmtPct(r.chg5)}</td>
      ${mlCell(r)}
      ${scoreCell(r)}
      ${fusedCell(r)}
      <td class="dd">${r.confirm}</td>
    </tr>`).join('');
}

function viewDivIdx(i) {
  viewDivRow(divDisplayRows[i], divDisplayRows);
}

/* 打开单条底背离信号(信号表行与概览卡片共用): 跳图表分析视图看K线 */
function viewDivRow(r, listRows = null) {
  if (!r) return;
  openStockInChart(r.name, r.code, r.tf_name + '底背离', listRows, r);
  switchTf(r.tf);
}

/* ================= 复盘统计弹窗 ================= */
async function openStats() {
  document.getElementById('statsBox').style.display = 'flex';
  const body = document.getElementById('statsBody');
  body.innerHTML = '加载中…';
  try {
    const [r, re] = await Promise.all([
      apiFetch('/api/stats'),
      apiFetch('/api/model_explain').catch(() => null)
    ]);
    renderStats(await r.json(), re ? await re.json() : []);
  } catch (e) {
    body.innerHTML = '<div class="empty">加载失败, 请重试</div>';
  }
}

function closeStats() {
  document.getElementById('statsBox').style.display = 'none';
}

/* 样本外(walk-forward)真实预期卡片: 与上方"历史回填(样本内)"分层明确区分;
   wf.buckets 为空(旧模型/未训练)时不渲染 */
function mlWfCard(meta) {
  if (!meta || !meta.wf || !meta.wf.buckets || !meta.wf.buckets.length) return '';
  const wf = meta.wf;
  const buckets = wf.buckets.map(b => `
    <div class="sc-cell">
      <div class="sc-n">模型分${b.key}</div>
      <div class="sc-win">${b.win}%</div>
      <div class="sc-cnt">${b.n}样本</div>
    </div>`).join('');
  return `
    <h4>真实预期(样本外 walk-forward)</h4>
    <div class="wf-note wf-card">
      <div class="sc-cells">${buckets}</div>
      <div class="wf-meta">样本外AUC <b>${wf.auc}</b> · 基线胜率 ${wf.base_win}% · ${wf.n}样本 · 模型训练于 ${meta.trained_at || '--'}
        <br><small>上方"历史回填"分层为样本内口径, 偏乐观; 对新信号的预期请以本卡片样本外胜率为准。</small></div>
    </div>`;
}

/* 模型解释: 标准化系数Top10横向条形图, 正值右延(红)负值左延(绿) */
function mlExplainChart(items) {
  if (!items || !items.length) return '';
  const CN = {
    rsi14: 'RSI超卖', dif_inc_n: 'DIF抬升强度', zero_depth: '零轴深度',
    price_drop: '新低幅度', ret20: '近20日跌幅', ret60: '近60日跌幅',
    vol_ratio: '放量程度', vol_shrink: '探底缩量', ma60_pos: 'MA60位置',
    ma20_slope: 'MA20斜率', atr_pct: '波动率ATR', off_low: '脱离低点',
    pivot_gap: '形态时长', hist_rise: 'MACD柱拐头', score: '共振分',
    kdj_gold: 'KDJ金叉', week_align: '周线同向', vol_engulf: '放量反包',
    idx_ma60_pos: '大盘MA60位置', idx_ret20: '大盘20日动能',
    mood_temp: '情绪温度', mood_zb_rate: '炸板率', ind_momentum: '行业动量'
  };
  const maxW = Math.max(...items.map(x => Math.abs(x.w)), 0.001);
  const rows = items.map(x => {
    const pct = Math.min(100, Math.abs(x.w) / maxW * 100);
    const bar = x.w >= 0
        ? `<div class="mx-l"></div><div class="mx-r"><i style="width:${pct}%"></i></div>`
        : `<div class="mx-l"><i style="width:${pct}%"></i></div><div class="mx-r"></div>`;
    return `<div class="mx-row">
      <span class="mx-name" title="${x.name}">${CN[x.name] || x.name}</span>
      <div class="mx-bar">${bar}</div>
      <span class="mx-w">${x.w > 0 ? '+' : ''}${x.w}</span></div>`;
  }).join('');
  return `<h4>模型在关注什么(标准化系数Top10)</h4>
    <div class="mx-chart">${rows}</div>
    <div class="sc-note">正值(红)推高胜率, 负值(绿)压低胜率; "A*B"为两特征交互项</div>`;
}

function renderStats(s, explain) {
  const body = document.getElementById('statsBody');
  if (!s || !s.total) {
    body.innerHTML = '<div class="empty">暂无已跟踪信号(扫描运行后按日积累)</div>';
    return;
  }
  const pc = v => v == null ? '--' :
      `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : ''}${v}%</span>`;
  const wr = v => v == null ? '--' : `${v}%`;
  // 总览卡片: 胜率/平均收益矩阵(3/5/10/20/60周期)
  const o = s.overall;
  const cell = (n) => `
    <div class="sc-cell">
      <div class="sc-n">${n}周期</div>
      <div class="sc-win">${wr(o['win' + n])}</div>
      <div class="sc-avg">${pc(o['avg' + n])}</div>
      <div class="sc-cnt">${o['n' + n]}样本</div>
    </div>`;
  // 分层表: 周期 / 共振分
  const rowsHtml = arr => arr.map(x => `
    <tr><td>${x.name}</td><td>${x.n3 || 0}</td><td>${wr(x.win3)}</td><td>${pc(x.avg3)}</td>
    <td>${wr(x.win5)}</td><td>${pc(x.avg5)}</td><td>${wr(x.win10)}</td><td>${pc(x.avg10)}</td>
    <td>${wr(x.win20)}</td><td>${pc(x.avg20)}</td><td>${wr(x.win60)}</td><td>${pc(x.avg60)}</td></tr>`).join('');
  const months = s.by_month.map(m => `
    <tr><td>${m.key}</td><td>${m.n}</td><td>${wr(m.win5)}</td><td>${pc(m.avg5)}</td><td>${pc(m.avg20)}</td></tr>`).join('');
  body.innerHTML = `
    <div class="sc-note">信号总数 ${s.total} · 确认日期 ${s.from || '--'} ~ ${s.to || '--'} ·
      胜率/收益均自<b>确认日收盘</b>起算(可实际入场点); 共振分越高代表多指标共振越强;
      模型分为元标签质量模型打分(0-100, 只用确认日前数据)</div>
    <div class="sc-cells">${[3, 5, 10, 20, 60].map(cell).join('')}</div>
    <h4>按周期 / 共振分分层</h4>
    <table class="stats-table">
      <thead><tr><th>分层</th><th>样本</th><th>3日胜率</th><th>3日均收</th>
      <th>5日胜率</th><th>5日均收</th><th>10日胜率</th><th>10日均收</th>
      <th>20日胜率</th><th>20日均收</th><th>60日胜率</th><th>60日均收</th></tr></thead>
      <tbody>${rowsHtml(s.by_tf)}${rowsHtml(s.by_score)}</tbody>
    </table>
    ${s.by_ml && s.by_ml.some(x => x.n3 > 0) ? `
    <h4>按模型分分层(历史回填, 样本内, 仅供参考)</h4>
    <table class="stats-table">
      <thead><tr><th>模型分</th><th>样本</th><th>3日胜率</th><th>3日均收</th>
      <th>5日胜率</th><th>5日均收</th><th>10日胜率</th><th>10日均收</th>
      <th>20日胜率</th><th>20日均收</th><th>60日胜率</th><th>60日均收</th></tr></thead>
      <tbody>${rowsHtml(s.by_ml)}</tbody>
    </table>
    ${mlWfCard(s.ml_meta)}` : ''}
    ${mlExplainChart(explain)}
    <h4>按确认月份(近12个月)</h4>
    <table class="stats-table slim">
      <thead><tr><th>月份</th><th>信号数</th><th>5日胜率</th><th>5日均收</th><th>20日均收</th></tr></thead>
      <tbody>${months || '<tr><td colspan="5" class="empty">暂无数据</td></tr>'}</tbody>
    </table>`;
}

/* chart.js 已完成 KChart/ShareChart 初始化 */
applyTheme(localStorage.getItem('theme') || 'auto');  // 补一次主题下的绘制

/* 初始视图: 默认概览, 恢复上次使用的视图 */
(function initView() {
  initIdxPanel();
  const saved = localStorage.getItem('last_view');
  showView(VIEWS.includes(saved) ? saved : 'overview');
})();

/* 启动认证探测: 已启用认证且当前token无效则弹登录框, 否则正常加载 */
(async function probeAuth() {
  try {
    const r = await fetch('/api/auth/status', {
      headers: authToken ? {'Authorization': 'Bearer ' + authToken} : {}
    });
    const st = await r.json();
    if (st.enabled && !st.ok) showLogin(true);
    else { loadIdxList(); loadEtfList(); loadWatch(); loadDivs(); loadRadar(); loadIntraday(); loadResonance(); }
  } catch (e) {
    loadIdxList(); loadEtfList(); loadWatch(); loadDivs(); loadRadar(); loadIntraday(); loadResonance();
  }
})();
/* SSE连接时行情实时推送, 断开时回退5秒轮询; 低频轮询兜底主力资金流等SSE未覆盖字段 */
setInterval(() => { if (!sseOk) refreshQuotes(); }, 5000);
setInterval(refreshQuotes, 120000);
setInterval(loadIdxList, 60000);
setInterval(loadEtfList, 60000);
setInterval(loadResonance, 300000);   // 共振快照5分钟兜底(SSE断开时也能更新)
setInterval(loadDivs, 3600000);   // 每小时拉一次, 后端每日全量重扫
