/**
 * DLsite 作品ページへのパネル注入。
 *
 * 方針:
 *   - DLsite の既存要素は一切変更・削除しない。自前の要素を1つ足すだけ
 *   - アンカーが見つからない / API が落ちている場合は静かに諦める
 *   - 絵文字は使わない。アイコンは inline SVG
 */

(() => {
  const DOM = globalThis.DPT_DOM;
  const F = globalThis.DPT_FORMAT;
  const CHART = globalThis.DPT_CHART;
  const WL = globalThis.DPT_WATCHLIST;

  const PANEL_ID = "dpt-panel";
  const STORE_KEYS = { collapsed: "ui:collapsed", showList: "ui:showList", period: "ui:period" };

  const PERIODS = [
    { id: "30", label: "1ヶ月", days: 30 },
    { id: "90", label: "3ヶ月", days: 90 },
    { id: "all", label: "全期間", days: null },
  ];

  const ICONS = {
    chart:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 6h5v6h5v5h6"/></svg>',
    chevron:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    external:
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    bell:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    bellOn:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>' +
      '<path d="M13.7 21a2 2 0 0 1-3.4 0" fill="none"/></svg>',
  };

  const store = {
    async get(key, fallback) {
      try {
        const bag = await chrome.storage.local.get(key);
        return bag[key] === undefined ? fallback : bag[key];
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        chrome.storage.local.set({ [key]: value });
      } catch {
        /* 拡張がリロードされた直後などは無視 */
      }
    },
  };

  async function ask(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null; // service worker が落ちている / 拡張コンテキスト無効
    }
  }

  function buildShell(collapsed) {
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.className = `dpt-panel${collapsed ? " dpt-collapsed" : ""}`;

    const head = document.createElement("div");
    head.className = "dpt-head";
    head.innerHTML =
      `<button class="dpt-toggle" type="button" aria-expanded="${!collapsed}" aria-controls="dpt-body">` +
      `<span class="dpt-head-icon">${ICONS.chart}</span>` +
      `<span class="dpt-title">価格・割引の推移</span>` +
      `<span class="dpt-chevron">${ICONS.chevron}</span>` +
      `</button>`;

    const body = document.createElement("div");
    body.className = "dpt-body";
    body.id = "dpt-body";
    body.innerHTML = '<div class="dpt-state">価格履歴を読み込んでいます</div>';

    panel.append(head, body);

    head.querySelector(".dpt-toggle").addEventListener("click", () => {
      const nowCollapsed = !panel.classList.contains("dpt-collapsed");
      panel.classList.toggle("dpt-collapsed", nowCollapsed);
      head.querySelector(".dpt-toggle").setAttribute("aria-expanded", String(!nowCollapsed));
      store.set(STORE_KEYS.collapsed, nowCollapsed);
    });

    return { panel, body };
  }

  function renderUnavailable(body, message, detail, link) {
    body.innerHTML = "";
    const box = document.createElement("div");
    box.className = "dpt-state";
    box.textContent = message;
    body.appendChild(box);
    if (detail) {
      const sub = document.createElement("div");
      sub.className = "dpt-state-sub";
      sub.textContent = detail;
      body.appendChild(sub);
    }
    if (link) {
      const wrap = document.createElement("div");
      wrap.className = "dpt-links dpt-links-center";
      const a = document.createElement("a");
      a.className = "dpt-link";
      a.href = link.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.innerHTML = `${link.text} ${ICONS.external}`;
      wrap.appendChild(a);
      body.appendChild(wrap);
    }
  }

  /**
   * 「安くなったら通知」バー。
   *
   * ウォッチリストは端末内（chrome.storage.local）にしか置かない。
   * サーバーに預けないので、ログインもアカウント作成も要らない。
   */
  function buildAlertBar(data) {
    const productId = data.product_id;
    const wrap = document.createElement("div");
    wrap.className = "dpt-alert";

    const row = document.createElement("div");
    row.className = "dpt-alert-row";
    const form = document.createElement("div");
    form.className = "dpt-alert-form";
    form.hidden = true;
    wrap.append(row, form);

    // 条件フォームの初期値。過去最安を狙う人が一番多いので、そこを既定に置く。
    const suggestPrice = Number(data.stats.min) || Number(data.stats.current) || null;
    let draft = { mode: "lowest", price: suggestPrice, rate: 50 };

    function say(message, tone = "") {
      const note = document.createElement("div");
      note.className = `dpt-alert-note${tone ? ` dpt-alert-note-${tone}` : ""}`;
      note.textContent = message;
      note.setAttribute("role", "status");
      return note;
    }

    async function paint() {
      const entry = await WL.get(productId);
      row.innerHTML = "";

      if (!entry) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "dpt-alert-btn dpt-alert-btn-primary";
        add.innerHTML = `${ICONS.bell}<span>安くなったら通知</span>`;
        add.addEventListener("click", () => openForm(null));
        row.appendChild(add);
        row.appendChild(say("通知の設定はこの端末内だけに保存されます"));
        return;
      }

      const state = document.createElement("span");
      state.className = "dpt-alert-on";
      state.innerHTML = `${ICONS.bellOn}<span>通知オン</span>`;

      const desc = document.createElement("span");
      desc.className = "dpt-alert-desc";
      desc.textContent = WL.describeRule(entry.rule);

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "dpt-alert-btn";
      edit.textContent = "条件を変更";
      edit.addEventListener("click", () => openForm(entry.rule));

      const off = document.createElement("button");
      off.type = "button";
      off.className = "dpt-alert-btn dpt-alert-btn-quiet";
      off.textContent = "解除";
      off.addEventListener("click", async () => {
        await WL.remove(productId);
        form.hidden = true;
        paint();
      });

      row.append(state, desc, edit, off);

      if (entry.notified?.price) {
        row.appendChild(
          say(`${Number(entry.notified.price).toLocaleString("ja-JP")}円で通知済み（さらに安くなったら再通知）`),
        );
      }
    }

    function openForm(rule) {
      if (rule) draft = { ...WL.normalizeRule(rule) };
      if (draft.price === null) draft.price = suggestPrice;
      if (draft.rate === null) draft.rate = 50;

      form.hidden = false;
      form.innerHTML = "";

      const modeLabel = document.createElement("label");
      modeLabel.className = "dpt-field";
      const modeSelect = document.createElement("select");
      modeSelect.className = "dpt-select";
      WL.MODES.forEach((m) => {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = WL.MODE_LABELS[m];
        modeSelect.appendChild(o);
      });
      modeSelect.value = draft.mode;
      modeLabel.append(Object.assign(document.createElement("span"), { textContent: "通知する条件" }), modeSelect);

      const priceLabel = document.createElement("label");
      priceLabel.className = "dpt-field";
      const priceInput = document.createElement("input");
      Object.assign(priceInput, { type: "number", min: "1", step: "1", value: String(draft.price ?? "") });
      priceInput.className = "dpt-input";
      priceInput.inputMode = "numeric";
      priceLabel.append(
        Object.assign(document.createElement("span"), { textContent: "金額（円以下）" }),
        priceInput,
      );

      const rateLabel = document.createElement("label");
      rateLabel.className = "dpt-field";
      const rateInput = document.createElement("input");
      Object.assign(rateInput, { type: "number", min: "1", max: "99", step: "1", value: String(draft.rate ?? "") });
      rateInput.className = "dpt-input";
      rateInput.inputMode = "numeric";
      rateLabel.append(
        Object.assign(document.createElement("span"), { textContent: "割引率（%OFF 以上）" }),
        rateInput,
      );

      const actions = document.createElement("div");
      actions.className = "dpt-alert-actions";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "dpt-alert-btn dpt-alert-btn-primary";
      save.textContent = "この条件で通知する";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dpt-alert-btn dpt-alert-btn-quiet";
      cancel.textContent = "キャンセル";
      actions.append(save, cancel);

      const hint = document.createElement("div");
      hint.className = "dpt-alert-note";

      form.append(modeLabel, priceLabel, rateLabel, actions, hint);

      /** モードに関係ない入力欄は隠す。使わない値を尋ねると迷わせる。 */
      function syncFields() {
        const m = modeSelect.value;
        priceLabel.hidden = !(m === "price" || m === "both" || m === "either");
        rateLabel.hidden = !(m === "rate" || m === "both" || m === "either");
        const now = Number(data.stats.current);
        hint.textContent =
          m === "lowest"
            ? `現在の過去最安は ${F.yen(data.stats.min)} です。これを下回ったら通知します`
            : `現在の販売価格は ${F.yen(now)}（${data.stats.discount_rate || 0}%OFF）です`;
      }
      modeSelect.addEventListener("change", syncFields);
      syncFields();

      cancel.addEventListener("click", () => {
        form.hidden = true;
      });

      save.addEventListener("click", async () => {
        const rule = WL.normalizeRule({
          mode: modeSelect.value,
          price: priceInput.value,
          rate: rateInput.value,
        });
        // 入力が空のまま金額モードを選ぶと normalizeRule が既定へ落とす。黙って
        // 「過去最安」に変わると裏切りになるので、その場で知らせて止める。
        if (rule.mode !== modeSelect.value) {
          hint.textContent = "金額または割引率を入力してください";
          hint.classList.add("dpt-alert-note-warn");
          return;
        }
        draft = { ...rule };
        const res = await WL.put(productId, { title: data.title, rule });
        if (!res.ok && res.reason === "full") {
          hint.textContent = `ウォッチリストは最大 ${res.max} 件です。不要なものを解除してください`;
          hint.classList.add("dpt-alert-note-warn");
          return;
        }
        form.hidden = true;
        paint();
      });
    }

    paint();
    return wrap;
  }

  async function renderData(body, data) {
    body.innerHTML = "";

    const state = {
      period: await store.get(STORE_KEYS.period, "90"),
      showList: await store.get(STORE_KEYS.showList, true),
    };
    // 計測期間より長い期間タブは無意味なので、選べる範囲に丸める。
    const observed = data.stats.observed_days || 0;
    if (state.period === "90" && observed < 45) state.period = "30";

    // ── 期間タブ ──
    const tabs = document.createElement("div");
    tabs.className = "dpt-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "表示期間");
    PERIODS.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dpt-tab";
      b.textContent = p.label;
      b.dataset.period = p.id;
      b.setAttribute("role", "tab");
      tabs.appendChild(b);
    });

    // ── サマリ行 ──
    const summary = document.createElement("div");
    summary.className = "dpt-summary";

    // ── グラフ ──
    const chartBox = document.createElement("div");
    chartBox.className = "dpt-chart-box";

    // ── 統計テーブル ──
    const statsBox = document.createElement("dl");
    statsBox.className = "dpt-stats";

    // ── 凡例 ──
    const legend = document.createElement("div");
    legend.className = "dpt-legend";

    // ── フッター ──
    const footer = document.createElement("div");
    footer.className = "dpt-footer";

    // 凡例はグラフの直下に置く。統計表を挟むと、何の凡例か分からなくなる。
    body.append(tabs, summary, chartBox, legend, statsBox, footer);

    function draw() {
      const days = PERIODS.find((p) => p.id === state.period)?.days ?? null;
      const points = F.sliceByDays(data.points, data.last_observed, days);
      const periodStats = F.statsFor(points, data.last_observed);

      tabs.querySelectorAll(".dpt-tab").forEach((b) => {
        const on = b.dataset.period === state.period;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", String(on));
      });

      // サマリ。
      // バッジは必ず「計測できた全期間」で判定する。表示期間の最安で判定すると、
      // 1ヶ月表示にしただけで「過去最安」と出てしまう（全期間の最安385円に対し
      // 直近1ヶ月の最安は423円、というような場合に嘘になる）。
      const sig = F.signalLabel(data.stats.signal, data.stats.current, data.stats.min);
      const rate = data.stats.discount_rate;
      summary.innerHTML = "";
      const badge = document.createElement("span");
      badge.className = `dpt-badge dpt-badge-${sig.tone}`;
      badge.textContent = sig.text;
      const price = document.createElement("span");
      price.className = "dpt-current";
      price.textContent = F.yen(data.stats.current);
      summary.append(badge, price);
      if (rate) {
        const off = document.createElement("span");
        off.className = "dpt-off";
        off.textContent = `${rate}%OFF`;
        summary.appendChild(off);
      }
      const end = F.endDateTime(data.stats.discount_end);
      if (data.stats.is_discount && end) {
        const left = F.daysUntil(data.stats.discount_end);
        const note = document.createElement("span");
        note.className = "dpt-sale-end";
        note.textContent = `このセールは ${end} まで${left !== null ? `（あと${left}日）` : ""}`;
        summary.appendChild(note);
      }

      // グラフ
      if (points.length === 0) {
        chartBox.innerHTML = '<div class="dpt-state">この期間の記録がありません</div>';
      } else if (periodStats.min === periodStats.max) {
        chartBox.innerHTML = "";
        const flat = document.createElement("div");
        flat.className = "dpt-state";
        flat.textContent = `この期間は ${F.yen(periodStats.current)} のまま動いていません`;
        chartBox.appendChild(flat);
      } else {
        CHART.render(chartBox, {
          points,
          lastObserved: data.last_observed,
          showListPrice: state.showList,
        });
      }

      // 統計
      const rows = [
        ["現在", F.yen(data.stats.current)],
        ["期間最安", `${F.yen(periodStats.min)}${periodStats.minDate ? `（${F.shortDate(periodStats.minDate)}）` : ""}`],
        ["期間最高", F.yen(periodStats.max)],
        ["30日平均", F.yen(data.stats.avg_30d)],
        ["90日平均", F.yen(data.stats.avg_90d)],
      ];
      statsBox.innerHTML = rows
        .map(([k, v]) => `<div class="dpt-stat"><dt>${k}</dt><dd>${v}</dd></div>`)
        .join("");

      // 凡例
      legend.innerHTML = "";
      const priceKey = document.createElement("span");
      priceKey.className = "dpt-key";
      priceKey.innerHTML = '<i class="dpt-swatch dpt-swatch-price"></i>販売価格';
      legend.appendChild(priceKey);

      const listToggle = document.createElement("button");
      listToggle.type = "button";
      listToggle.className = `dpt-key dpt-key-btn${state.showList ? " is-on" : ""}`;
      listToggle.innerHTML = '<i class="dpt-swatch dpt-swatch-list"></i>サークル設定価格';
      listToggle.setAttribute("aria-pressed", String(state.showList));
      listToggle.addEventListener("click", () => {
        state.showList = !state.showList;
        store.set(STORE_KEYS.showList, state.showList);
        draw();
      });
      legend.appendChild(listToggle);

      const bandKey = document.createElement("span");
      bandKey.className = "dpt-key";
      bandKey.innerHTML = '<i class="dpt-swatch dpt-swatch-band"></i>割引期間';
      legend.appendChild(bandKey);
    }

    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".dpt-tab");
      if (!btn) return;
      state.period = btn.dataset.period;
      store.set(STORE_KEYS.period, state.period);
      draw();
    });

    // ── フッター（計測期間の明示 + 導線 + アフィリエイト表示） ──
    const since = document.createElement("div");
    since.className = "dpt-since";
    since.textContent =
      `計測開始 ${F.longDate(data.tracking_since)}（${data.stats.observed_days}日分）` +
      `／最終取得 ${F.longDate(data.last_observed)}`;

    const links = document.createElement("div");
    links.className = "dpt-links";
    if (data.affiliate_url) {
      const a = document.createElement("a");
      a.className = "dpt-link dpt-link-primary";
      a.href = data.affiliate_url;
      a.target = "_blank";
      a.rel = "sponsored noopener noreferrer";
      a.innerHTML = `DLsite で見る ${ICONS.external}`;
      links.appendChild(a);
    }
    if (data.voicelabo_url) {
      const a = document.createElement("a");
      a.className = "dpt-link";
      a.href = data.voicelabo_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.innerHTML = `ボイラボで詳しく見る ${ICONS.external}`;
      links.appendChild(a);
    }

    const disclosure = document.createElement("div");
    disclosure.className = "dpt-disclosure";
    disclosure.textContent =
      "「DLsite で見る」はアフィリエイトリンクです。価格は日次観測にもとづく参考値で、" +
      "実際の販売価格は DLsite の表示が正となります。";

    footer.append(buildAlertBar(data), since, links, disclosure);

    draw();
  }

  /** ストア配布ではないため自動更新が無い。新版が出ていたら控えめに知らせる。 */
  async function maybeShowUpdate(panel) {
    const info = await ask({ type: "UPDATE_CHECK" });
    if (!info || !info.hasUpdate || !info.latest) return;
    const bar = document.createElement("a");
    bar.className = "dpt-update";
    bar.href = info.url;
    bar.target = "_blank";
    bar.rel = "noopener noreferrer";
    bar.textContent = `新しいバージョン ${info.latest} が公開されています（現在 ${info.current}）`;
    panel.appendChild(bar);
  }

  async function main() {
    if (!DOM.isTrackablePage()) return;
    if (document.getElementById(PANEL_ID)) return;

    const productId = DOM.productIdFromUrl();
    const anchor = DOM.findAnchor();
    if (!productId || !anchor) return; // DLsite の構造が変わった。静かに諦める。

    const collapsed = await store.get(STORE_KEYS.collapsed, false);
    const { panel, body } = buildShell(collapsed);
    anchor.el.insertAdjacentElement(anchor.position, panel);

    const res = await ask({ type: "PRICE_HISTORY", productId });

    if (!res) {
      renderUnavailable(body, "価格履歴を取得できませんでした", "拡張機能を再読み込みすると直ることがあります。");
      return;
    }
    if (res.ok && res.data) {
      await renderData(body, res.data);
      maybeShowUpdate(panel);
      return;
    }
    if (res.status === 404) {
      // 未収録作品の /works/{id} はボイラボ側にも無いので、リンク先はトップにする。
      renderUnavailable(
        body,
        "この作品はまだ計測対象外です",
        "ボイラボが日次で取得している作品のみ表示されます。新作は数日で対象になります。",
        { href: "https://voice-labo.com/", text: "ボイラボで作品を探す" },
      );
      return;
    }
    renderUnavailable(body, "価格履歴を取得できませんでした", "時間をおいて再度お試しください。");
  }

  main();
})();
