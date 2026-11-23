import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables
} from '@modelcontextprotocol/ext-apps';

const state = {
  tab: 'overview',
  busy: false,
  snapshot: null,
  drawnTarot: null,
  buildReport: null,
  dryRunReport: null,
  statusMsg: null,
  errorMsg: null,
  canOpenLinks: false
};

const app = new App({ name: 'OMOCHI TUNE', version: '1.1.0' }, {});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

function getToolErrorText(result) {
  const txt = result?.content?.find((c) => c.type === 'text')?.text;
  if (!txt) return '操作に失敗しました。';
  try {
    const parsed = JSON.parse(txt);
    return parsed.error || txt;
  } catch {
    return txt;
  }
}

async function callTool(name, args = {}) {
  if (state.busy) return null;
  state.busy = true;
  state.errorMsg = null;
  render();
  try {
    const res = await app.callServerTool({ name, arguments: args });
    if (res.isError) {
      state.errorMsg = getToolErrorText(res);
      return null;
    }
    return res.structuredContent || null;
  } catch (err) {
    state.errorMsg = err instanceof Error ? err.message : String(err);
    return null;
  } finally {
    state.busy = false;
    render();
  }
}

async function refreshSnapshot(targetTab) {
  const data = await callTool('open_dashboard', { tab: targetTab || state.tab });
  if (data) {
    state.snapshot = data;
    if (data.tab) state.tab = data.tab;
    render();
  }
}

function renderOverview(container) {
  const snap = state.snapshot;
  const ov = snap.overview;
  const sch = ov.schedule;

  // Schedule Card
  const schCard = el('section', 'card');
  const schTitle = el('h2', 'card-title');
  schTitle.append(el('span', '', '次回開催スケジュール'));
  schTitle.append(
    el('span', sch.isLiveNow ? 'badge badge-rose' : 'badge badge-accent', sch.statusLabel || sch.nextEvent.displayDate)
  );
  schCard.append(schTitle);
  schCard.append(
    el(
      'div',
      '',
      `${sch.nextEvent.displayDate} ${sch.nextEvent.startTime}〜${sch.nextEvent.endTime} JST（あと ${sch.daysUntilNext} 日）`
    )
  );
  schCard.append(el('div', 'muted', `${ov.site.venue} / ${ov.site.address}`));

  const quickActions = el('div', 'row');
  const buildBtn = el('button', 'btn-primary', '全検証 & ビルド');
  buildBtn.disabled = state.busy;
  buildBtn.addEventListener('click', async () => {
    const res = await callTool('validate_and_build', { runBuild: true, runE2E: false });
    if (res) {
      state.buildReport = res;
      state.statusMsg = '全 5 JSON 検証とビルドが完了しました。';
      render();
    }
  });
  quickActions.append(buildBtn);

  const refreshBtn = el('button', '', '最新情報に更新');
  refreshBtn.disabled = state.busy;
  refreshBtn.addEventListener('click', () => refreshSnapshot('overview'));
  quickActions.append(refreshBtn);

  if (state.canOpenLinks) {
    const openSiteBtn = el('button', '', '公開サイトを開く ↗');
    openSiteBtn.addEventListener('click', () => app.openLink({ url: ov.site.url }));
    quickActions.append(openSiteBtn);
  }
  schCard.append(quickActions);

  if (state.buildReport) {
    schCard.append(
      el(
        'div',
        'banner banner-ok',
        `検証 OK（コラム ${state.buildReport.counts.columns} / 図鑑 ${state.buildReport.counts.gallery} / タロット ${state.buildReport.counts.tarot}）`
      )
    );
  }
  container.append(schCard);

  // Counts Card
  const countsCard = el('section', 'card');
  countsCard.append(el('h2', 'card-title', '公開コンテンツ件数'));
  const grid = el('div', 'stats-grid');
  for (const [label, val] of [
    ['おもちコラム', ov.counts.columns],
    ['おもち図鑑', ov.counts.gallery],
    ['タロットカード', ov.counts.tarot],
    ['Instagram', ov.counts.instagram]
  ]) {
    const box = el('div', 'stat-box');
    box.append(el('div', 'stat-value', String(val)));
    box.append(el('div', 'stat-label', label));
    grid.append(box);
  }
  countsCard.append(grid);
  container.append(countsCard);

  // Quick Tarot Card
  const tarotCard = el('section', 'card');
  tarotCard.append(el('h2', 'card-title', 'おもちタロット 1枚引き'));
  const drawRow = el('div', 'row');
  const dailyBtn = el('button', '', '✦ 今日のカードを引く');
  dailyBtn.disabled = state.busy;
  dailyBtn.addEventListener('click', async () => {
    const res = await callTool('draw_tarot_card', { mode: 'daily' });
    if (res) {
      state.drawnTarot = res;
      render();
    }
  });
  const loveBtn = el('button', 'btn-rose', '💖 恋愛運を引く');
  loveBtn.disabled = state.busy;
  loveBtn.addEventListener('click', async () => {
    const res = await callTool('draw_tarot_card', { mode: 'love' });
    if (res) {
      state.drawnTarot = res;
      render();
    }
  });
  drawRow.append(dailyBtn, loveBtn);
  tarotCard.append(drawRow);

  if (state.drawnTarot?.card) {
    const c = state.drawnTarot.card;
    const box = el('div', 'tarot-box');
    box.append(el('strong', '', `${c.illust} ${c.nameJp} (${c.nameEn})`));
    box.append(el('div', '', c.desc));
    if (state.drawnTarot.loveAdvice) {
      box.append(el('div', 'tarot-love', `💖 恋愛アドバイス: ${state.drawnTarot.loveAdvice}`));
    }
    tarotCard.append(box);
  }
  container.append(tarotCard);
}

function renderSettings(container) {
  const s = state.snapshot.overview.settings;
  const card = el('section', 'card');
  card.append(el('h2', 'card-title', '公開・予約設定（content/settings.json）'));

  const form = el('form', 'form-grid');
  const toggleGrid = el('div', 'toggle-grid');

  const checkboxes = {};
  for (const [key, label] of [
    ['showTarot', 'タロット占いを表示'],
    ['showGallery', 'おもち図鑑を表示'],
    ['showColumn', 'おもちコラムを表示'],
    ['showSchedule', '開催日程を表示']
  ]) {
    const wrap = el('label', 'toggle-item');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(s[key]);
    checkboxes[key] = cb;
    wrap.append(cb, el('span', '', label));
    toggleGrid.append(wrap);
  }
  form.append(toggleGrid);

  const inputs = {};
  for (const [key, label, type] of [
    ['reservationLabel', '予約ボタン文言', 'text'],
    ['reservationUrl', '事前予約 URL', 'url'],
    ['walkInText', '当日参加案内', 'text'],
    ['instagramHandle', 'Instagram ハンドル', 'text'],
    ['instagramUrl', 'Instagram URL', 'url'],
    ['accessVideoUrl', 'アクセス動画 URL（任意）', 'url']
  ]) {
    const field = el('label', 'field', label);
    const input = document.createElement('input');
    input.type = type;
    input.value = s[key] || '';
    inputs[key] = input;
    field.append(input);
    form.append(field);
  }

  const actions = el('div', 'row');
  const saveBtn = el('button', 'btn-primary', '設定を保存');
  saveBtn.type = 'submit';
  saveBtn.disabled = state.busy;
  actions.append(saveBtn);
  form.append(actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const patch = {
      showTarot: checkboxes.showTarot.checked,
      showGallery: checkboxes.showGallery.checked,
      showColumn: checkboxes.showColumn.checked,
      showSchedule: checkboxes.showSchedule.checked,
      reservationLabel: inputs.reservationLabel.value.trim(),
      reservationUrl: inputs.reservationUrl.value.trim(),
      walkInText: inputs.walkInText.value.trim(),
      instagramHandle: inputs.instagramHandle.value.trim(),
      instagramUrl: inputs.instagramUrl.value.trim(),
      accessVideoUrl: inputs.accessVideoUrl.value.trim()
    };
    const res = await callTool('update_settings', patch);
    if (res?.settings) {
      state.snapshot.overview.settings = res.settings;
      state.statusMsg = 'サイト設定を保存しました。';
      render();
    }
  });

  card.append(form);
  container.append(card);
}

function renderContent(container) {
  const { columns, gallery, tarot, instagram } = state.snapshot;

  const colCard = el('section', 'card');
  colCard.append(el('h2', 'card-title', `おもちコラム (${columns.length}件)`));
  const colList = el('div', 'item-list');
  for (const col of columns) {
    const row = el('div', 'item-row');
    const head = el('div', 'item-head');
    head.append(el('span', '', `#${col.id} ${col.title}`));
    head.append(el('span', 'badge', `${col.date} / ${col.tag}`));
    row.append(head, el('div', 'muted', col.summary));
    colList.append(row);
  }
  colCard.append(colList);
  container.append(colCard);

  const galCard = el('section', 'card');
  galCard.append(el('h2', 'card-title', `おもち図鑑 (${gallery.length}件)`));
  const galList = el('div', 'item-list');
  for (const item of gallery) {
    const row = el('div', 'item-row');
    const head = el('div', 'item-head');
    head.append(el('span', '', `#${item.id} ${item.title}`));
    head.append(el('span', 'badge', item.type));
    row.append(head, el('div', 'muted', `${item.image} ・ ${item.features}`));
    galList.append(row);
  }
  galCard.append(galList);
  container.append(galCard);

  const tarotCard = el('section', 'card');
  tarotCard.append(el('h2', 'card-title', `タロット (${tarot.length}枚) / Instagram (${instagram.length}枠)`));
  const tList = el('div', 'item-list');
  for (const card of tarot) {
    const row = el('div', 'item-row');
    row.append(el('div', 'item-head', `${card.illust} ${card.nameJp} (${card.nameEn})`));
    row.append(el('div', 'muted', card.desc));
    tList.append(row);
  }
  tarotCard.append(tList);
  container.append(tarotCard);
}

function renderPublish(container) {
  const git = state.snapshot.overview.git;
  const card = el('section', 'card');
  const title = el('h2', 'card-title');
  title.append(el('span', '', 'GitHub 公開ステータス'));
  title.append(el('span', 'badge', `branch: ${git.currentBranch}`));
  card.append(title);

  card.append(
    el(
      'div',
      'banner',
      `公開対象の変更（content/*.json, images/uploads/*）: ${git.allowedContentPaths.length} 件 / その他変更: ${git.otherPaths.length} 件`
    )
  );

  if (git.allowedContentPaths.length > 0) {
    card.append(el('pre', 'code-box', git.allowedContentPaths.join('\n')));
  } else {
    card.append(el('div', 'muted', '現在、公開待ちのコンテンツ変更はありません。'));
  }

  const actions = el('div', 'row');
  const statusBtn = el('button', '', 'Git 状態を再取得');
  statusBtn.disabled = state.busy;
  statusBtn.addEventListener('click', () => refreshSnapshot('publish'));

  const dryRunBtn = el('button', 'btn-primary', '公開計画を dry-run 確認');
  dryRunBtn.disabled = state.busy;
  dryRunBtn.addEventListener('click', async () => {
    const res = await callTool('publish_changes', {
      mode: 'pr',
      commitMessage: 'Update OMOCHI TUNE content via MCP App',
      confirm: false
    });
    if (res) {
      state.dryRunReport = res;
      state.statusMsg = res.noChanges
        ? '公開対象のコンテンツ変更はありませんでした。'
        : 'dry-run プレビューを生成しました（まだ Git 操作は行われていません）。';
      render();
    }
  });
  actions.append(statusBtn, dryRunBtn);
  card.append(actions);

  if (state.dryRunReport) {
    card.append(el('pre', 'code-box', JSON.stringify(state.dryRunReport, null, 2)));
  }
  card.append(
    el(
      'div',
      'muted',
      '※ 安全保護のため UI からは dry-run（confirm: false）のみ実行できます。実際の PR 作成 / push はチャット上で明示承認のうえ実行してください。'
    )
  );
  container.append(card);
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';

  const shell = el('div', 'app-shell');

  // Header
  const header = el('header', 'header-card');
  const titleWrap = el('div');
  const brandRow = el('div', 'brand-row');
  brandRow.append(el('h1', 'brand-title', 'OMOCHI TUNE 管理パネル'));
  brandRow.append(el('span', 'badge badge-accent', 'MCP App'));
  titleWrap.append(brandRow);
  titleWrap.append(el('p', 'subtitle', '毎月第一木曜 20:00〜23:00 ・ 渋谷・道玄坂 天井裏 “M”'));
  header.append(titleWrap);

  const tabs = el('nav', 'tabs');
  for (const [key, label] of [
    ['overview', '概要'],
    ['settings', '設定'],
    ['content', 'コンテンツ'],
    ['publish', '公開確認']
  ]) {
    const btn = el('button', `tab-btn${state.tab === key ? ' active' : ''}`, label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      state.tab = key;
      render();
    });
    tabs.append(btn);
  }
  header.append(tabs);
  shell.append(header);

  if (state.statusMsg) {
    shell.append(el('div', 'banner banner-ok', state.statusMsg));
  }
  if (state.errorMsg) {
    shell.append(el('div', 'banner banner-error', `エラー: ${state.errorMsg}`));
  }

  if (!state.snapshot) {
    const loadingCard = el('section', 'card');
    loadingCard.append(el('div', 'muted', 'OMOCHI TUNE データを読み込んでいます...'));
    shell.append(loadingCard);
    root.append(shell);
    return;
  }

  if (state.tab === 'overview') renderOverview(shell);
  else if (state.tab === 'settings') renderSettings(shell);
  else if (state.tab === 'content') renderContent(shell);
  else renderPublish(shell);

  root.append(shell);
}

// Register handlers BEFORE connect() so no tool notification is missed.
app.ontoolinput = (params) => {
  const requestedTab = params?.arguments?.tab;
  if (typeof requestedTab === 'string') {
    state.tab = requestedTab;
  }
  render();
};

app.ontoolresult = (result) => {
  if (result?.isError) {
    state.errorMsg = getToolErrorText(result);
    render();
    return;
  }
  const sc = result?.structuredContent;
  if (sc?.overview) {
    state.snapshot = sc;
    if (sc.tab) state.tab = sc.tab;
    render();
  }
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
};

async function boot() {
  render();

  try {
    await app.connect();
    applyHostContext(app.getHostContext());
    state.canOpenLinks = Boolean(app.getHostCapabilities()?.openLinks);
    render();
    // Wait briefly for the host's initial tool-result notification before issuing a fallback refresh.
    setTimeout(() => {
      if (!state.snapshot && !state.busy) {
        void refreshSnapshot(state.tab);
      }
    }, 250);
  } catch (err) {
    state.errorMsg = err instanceof Error ? err.message : String(err);
    render();
  }
}

void boot();
