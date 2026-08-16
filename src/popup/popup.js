/**
 * ウォッチリスト管理画面。
 *
 * サムネイルを主役にしたカードの一覧・絞り込み・解除・手動チェックを担う。
 * 条件の編集は作品ページのパネルでやる（そこには価格履歴が出ているので、
 * いくらを狙うか決められる。ここで数字だけ入れさせても判断材料が無い）。
 */

(() => {
  const WL = globalThis.DPT_WATCHLIST;

  const els = {
    summary: document.getElementById("summary"),
    list: document.getElementById("list"),
    empty: document.getElementById("empty"),
    noMatch: document.getElementById("no-match"),
    status: document.getElementById("status"),
    check: document.getElementById("check"),
    clear: document.getElementById("clear"),
    sort: document.getElementById("sort"),
    chips: document.getElementById("chips"),
  };

  /** 一覧の絞り込み・並び順の状態。popup を開き直したらリセットされる（保存しない）。 */
  const state = { sort: "added", filter: "all" };

  const yen = (n) => (Number.isFinite(Number(n)) ? `${Number(n).toLocaleString("ja-JP")}円` : "—");

  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function relative(ts) {
    if (!ts) return null;
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return "たった今";
    if (min < 60) return `${min}分前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}時間前`;
    return `${Math.floor(h / 24)}日前`;
  }

  /** 作品ページの URL。素の DLsite URL にする（ここはアフィリンクにしない）。
   *  ユーザー自身の管理画面なので、自分の一覧から自分のアフィを踏ませる意味がない。 */
  const workUrl = (id) =>
    `https://www.dlsite.com/maniax/work/=/product_id/${encodeURIComponent(id)}.html`;

  /**
   * DLsite のメイン画像 URL。RJ番号を 1000 単位で切り上げたフォルダに入っている
   * （ボイラボ本体 frontend/lib/thumbnail.js と同じ規則）。
   * 規則が変わった作品は onerror で「画像なし」表示に落ちるだけで、機能は壊れない。
   */
  function thumbUrl(id) {
    const m = String(id || "").match(/^RJ(\d+)$/i);
    if (!m) return null;
    const numStr = m[1];
    const group = Math.ceil(parseInt(numStr, 10) / 1000) * 1000;
    const groupStr = String(group).padStart(numStr.length, "0");
    return `https://img.dlsite.jp/modpub/images2/work/doujin/RJ${groupStr}/${String(id).toUpperCase()}_img_main.jpg`;
  }

  /** 現在の絞り込みを適用する。 */
  function applyFilter(entries) {
    return entries.filter((e) => {
      if (state.filter === "discount" && !(Number(e.lastSeen?.rate) > 0)) return false;
      if (state.filter === "lowest" && e.lastSeen?.lowest !== true) return false;
      if (state.filter === "notified" && !e.notified) return false;
      return true;
    });
  }

  /** 並び順を適用する。価格・割引率が未確認のものは末尾へ回す。 */
  function applySort(entries) {
    if (state.sort === "price") {
      return [...entries].sort(
        (a, b) => (Number(a.lastSeen?.price) || Infinity) - (Number(b.lastSeen?.price) || Infinity),
      );
    }
    if (state.sort === "rate") {
      return [...entries].sort(
        (a, b) => (Number(b.lastSeen?.rate) || 0) - (Number(a.lastSeen?.rate) || 0),
      );
    }
    return entries; // added: WL.list() が返す追加の新しい順
  }

  /** 2×2 の価格セル。ラベル＋値の縦組み。 */
  function cell(label, value, cls) {
    const c = document.createElement("span");
    c.className = `cell${cls ? ` ${cls}` : ""}`;
    const l = document.createElement("span");
    l.className = "cell-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "cell-value";
    v.textContent = value;
    c.append(l, v);
    return c;
  }

  /**
   * 1件のカード。上段は左にサムネイル・右に 2×2 の価格グリッド
   * （定価 / 現在 / 割引率 / 過去最安）、その下にタイトルと通知条件。
   */
  function buildCard(e) {
    const li = document.createElement("li");
    li.className = "item";

    // カード全体を作品ページへのリンクにする。フルタイトルはネイティブの
    // ツールチップ（title 属性）でカーソルオーバー時に見せる。
    const a = document.createElement("a");
    a.className = "card";
    a.href = workUrl(e.id);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = e.title || e.id;

    // ── 上段左: サムネイル ──
    const thumb = document.createElement("span");
    thumb.className = "thumb";
    const src = thumbUrl(e.id);
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => li.classList.add("no-thumb"), { once: true });
      thumb.appendChild(img);
    } else {
      li.classList.add("no-thumb");
    }
    const fallback = document.createElement("span");
    fallback.className = "thumb-fallback";
    fallback.textContent = e.id;
    thumb.appendChild(fallback);

    // ── 上段右: 2×2 の価格グリッド ──
    const pricing = document.createElement("span");
    pricing.className = "pricing";
    if (e.lastSeen) {
      const s = e.lastSeen;
      const rate = Number(s.rate) || 0;
      pricing.appendChild(cell("定価", Number.isFinite(Number(s.list)) ? yen(s.list) : "—"));
      pricing.appendChild(cell("現在", yen(s.price), "cell-now"));
      pricing.appendChild(cell("割引率", rate > 0 ? `${rate}%OFF` : "—", rate > 0 ? "cell-rate" : ""));
      pricing.appendChild(
        s.lowest === true
          ? cell("過去最安", "いまが最安", "cell-lowest")
          : cell("過去最安", Number.isFinite(Number(s.min)) ? yen(s.min) : "—"),
      );
    } else {
      const unchecked = document.createElement("span");
      unchecked.className = "unchecked";
      unchecked.textContent = "未確認";
      pricing.appendChild(unchecked);
    }

    const top = document.createElement("span");
    top.className = "top";
    top.append(thumb, pricing);

    // ── 下段: タイトル（尻切れ）と通知条件 ──
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = e.title || e.id;

    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent =
      WL.describeRule(e.rule) +
      (e.notified?.price ? `／${yen(e.notified.price)}で通知済み` : "");

    a.append(top, title, sub);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.setAttribute("aria-label", `${e.title || e.id} を解除`);
    remove.title = "解除";
    remove.innerHTML = ICON_CLOSE;
    remove.addEventListener("click", async () => {
      await WL.remove(e.id);
      paint();
    });

    li.append(a, remove);
    return li;
  }

  async function paint() {
    const entries = await WL.list();
    const shown = applySort(applyFilter(entries));
    const last = (await chrome.storage.local.get("watchCheck")).watchCheck;
    const filtered = shown.length !== entries.length;

    els.summary.textContent =
      entries.length === 0
        ? "登録 0 件"
        : (filtered
            ? `${entries.length} 件中 ${shown.length} 件を表示`
            : `登録 ${entries.length} 件（上限 ${WL.MAX_ENTRIES} 件）`) +
          (last?.at ? `／最終確認 ${relative(last.at)}` : "／未確認");

    els.empty.hidden = entries.length > 0;
    els.noMatch.hidden = !(entries.length > 0 && shown.length === 0);
    els.clear.disabled = entries.length === 0;
    els.list.innerHTML = "";

    for (const e of shown) els.list.appendChild(buildCard(e));
  }

  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    paint();
  });

  els.chips.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".chip");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    els.chips.querySelectorAll(".chip").forEach((c) => {
      const on = c === chip;
      c.classList.toggle("is-active", on);
      c.setAttribute("aria-pressed", String(on));
    });
    paint();
  });

  els.check.addEventListener("click", async () => {
    els.check.disabled = true;
    els.status.textContent = "確認しています…";
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: "WATCH_CHECK_NOW" });
    } catch {
      /* service worker が落ちている */
    }
    els.check.disabled = false;
    if (!res) {
      els.status.textContent = "確認できませんでした。少し待ってもう一度お試しください";
    } else if (res.checked === 0) {
      els.status.textContent = "登録がありません";
    } else {
      els.status.textContent =
        res.hits > 0
          ? `${res.checked}件を確認、${res.hits}件が条件を満たしました`
          : `${res.checked}件を確認しました。条件を満たすものはありません`;
    }
    paint();
  });

  els.clear.addEventListener("click", async () => {
    // popup では confirm() が閉じてしまう環境があるため、2 度押しで確定させる。
    if (els.clear.dataset.armed !== "1") {
      els.clear.dataset.armed = "1";
      els.clear.textContent = "本当に解除しますか？";
      els.status.textContent = "もう一度押すと全件解除されます";
      setTimeout(() => {
        els.clear.dataset.armed = "";
        els.clear.textContent = "すべて解除";
      }, 4000);
      return;
    }
    els.clear.dataset.armed = "";
    els.clear.textContent = "すべて解除";
    await WL.clear();
    els.status.textContent = "すべて解除しました";
    paint();
  });

  paint();
})();
