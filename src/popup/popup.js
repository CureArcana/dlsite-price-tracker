/**
 * ウォッチリスト管理画面。
 *
 * 一覧・条件の確認・解除・手動チェックだけを担う。
 * 条件の編集は作品ページのパネルでやる（そこには価格履歴が出ているので、
 * いくらを狙うか決められる。ここで数字だけ入れさせても判断材料が無い）。
 */

(() => {
  const WL = globalThis.DPT_WATCHLIST;

  const els = {
    summary: document.getElementById("summary"),
    list: document.getElementById("list"),
    empty: document.getElementById("empty"),
    status: document.getElementById("status"),
    check: document.getElementById("check"),
    clear: document.getElementById("clear"),
  };

  const yen = (n) => (Number.isFinite(Number(n)) ? `${Number(n).toLocaleString("ja-JP")}円` : "—");

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

  async function paint() {
    const entries = await WL.list();
    const last = (await chrome.storage.local.get("watchCheck")).watchCheck;

    els.summary.textContent =
      entries.length === 0
        ? "登録 0 件"
        : `登録 ${entries.length} 件（上限 ${WL.MAX_ENTRIES} 件）` +
          (last?.at ? `／最終確認 ${relative(last.at)}` : "／未確認");

    els.empty.hidden = entries.length > 0;
    els.clear.disabled = entries.length === 0;
    els.list.innerHTML = "";

    for (const e of entries) {
      const li = document.createElement("li");
      li.className = "item";

      const a = document.createElement("a");
      a.className = "item-title";
      a.href = workUrl(e.id);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = e.title || e.id;

      const rule = document.createElement("div");
      rule.className = "item-rule";
      rule.textContent = WL.describeRule(e.rule);

      const seen = document.createElement("div");
      seen.className = "item-seen";
      if (e.notified?.price) {
        seen.innerHTML = `<span class="item-hit">${yen(e.notified.price)}で通知済み</span>` +
          `（さらに安くなったら再通知）`;
      } else if (e.lastSeen?.price) {
        const rate = Number(e.lastSeen.rate) || 0;
        seen.textContent = `現在 ${yen(e.lastSeen.price)}${rate ? `（${rate}%OFF）` : ""}`;
      } else {
        seen.textContent = "まだ確認していません";
      }

      const actions = document.createElement("div");
      actions.className = "item-actions";
      const off = document.createElement("button");
      off.type = "button";
      off.className = "btn btn-quiet";
      off.textContent = "解除";
      off.addEventListener("click", async () => {
        await WL.remove(e.id);
        paint();
      });
      actions.appendChild(off);

      li.append(a, rule, seen, actions);
      els.list.appendChild(li);
    }
  }

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
