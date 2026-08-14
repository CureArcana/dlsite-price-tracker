/**
 * DLsite のお気に入り（欲しいものリスト）ページからの一括取り込み。
 *
 * 方針 — ここが一番デリケートなので明文化しておく:
 *   - **DLsite へリクエストを 1 本も出さない。** ユーザーが自分で開いたページの
 *     DOM を読むだけ。ログイン情報にも Cookie にも触らない。
 *     裏でお気に入り API を叩く実装は「スクレイピングしない」という約束を破るので採らない
 *   - **自動で登録しない。** 件数を出してボタンを見せるだけ。押すのはユーザー
 *   - 既に登録済みの作品は触らない（設定済みの条件を上書きしたら事故）
 *   - ページャで分割されているので、1 ページずつ取り込む前提。
 *     何ページ目でも同じバーが出て、重複は自動で弾かれる
 */

(() => {
  const DOM = globalThis.DPT_DOM;
  const WL = globalThis.DPT_WATCHLIST;

  // panel.css は `#dpt-import` で配色トークンと外枠を定義している（class ではなく
  // id で当てるのは DLsite 側の CSS に負けないため）。ここを変えるなら panel.css も直す。
  const BAR_ID = "dpt-import";

  if (!DOM.isWishlistPage()) return;

  const ICON_BELL =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

  function mount(bar) {
    // お気に入りページの構造は変わりうるので、いくつか候補を持って全滅したら body 先頭。
    const anchors = ["#main_inner", "#main", ".base_menu_wrapper", "#container", "main"];
    for (const sel of anchors) {
      const el = document.querySelector(sel);
      if (el) {
        el.insertAdjacentElement("afterbegin", bar);
        return true;
      }
    }
    document.body.insertAdjacentElement("afterbegin", bar);
    return true;
  }

  async function render(bar, works) {
    const registered = await Promise.all(works.map((w) => WL.has(w.id)));
    const fresh = works.filter((_, i) => !registered[i]);
    const already = works.length - fresh.length;
    const total = await WL.count();

    bar.innerHTML = "";

    const head = document.createElement("div");
    head.className = "dpt-import-head";
    head.innerHTML = `${ICON_BELL}<strong>DLsite Price Tracker</strong>`;

    const msg = document.createElement("div");
    msg.className = "dpt-import-msg";

    const actions = document.createElement("div");
    actions.className = "dpt-import-actions";

    bar.append(head, msg, actions);

    if (fresh.length === 0) {
      msg.textContent =
        works.length === 0
          ? "このページから作品を読み取れませんでした"
          : `このページの ${works.length} 件はすべて通知対象に入っています（登録 ${total} 件）`;
      return;
    }

    msg.textContent =
      `このページの ${fresh.length} 件を「安くなったら通知」に追加できます` +
      (already > 0 ? `（${already} 件は既に登録済み）` : "");

    const add = document.createElement("button");
    add.type = "button";
    add.className = "dpt-alert-btn dpt-alert-btn-primary";
    add.textContent = `${fresh.length}件を追加（過去最安で通知）`;

    const note = document.createElement("span");
    note.className = "dpt-alert-note";
    note.textContent = "条件は作品ページで個別に変えられます";

    actions.append(add, note);

    add.addEventListener("click", async () => {
      add.disabled = true;
      add.textContent = "追加しています…";
      const res = await WL.putMany(fresh, { mode: "lowest", price: null, rate: null });
      msg.textContent = res.full
        ? `${res.added} 件を追加しました。上限 ${WL.MAX_ENTRIES} 件に達したため残りは追加していません`
        : `${res.added} 件を追加しました（登録 ${res.total} 件）`;
      actions.innerHTML = "";
      actions.appendChild(note);
    });
  }

  /** 直前に描画した作品IDの集合。これが変わらない限り描き直さない。 */
  let lastKey = null;

  function keyOf(works) {
    return works
      .map((w) => w.id)
      .sort()
      .join(",");
  }

  function boot() {
    if (document.getElementById(BAR_ID)) return;
    const works = DOM.harvestWorks();
    if (works.length === 0) return; // 読み取れないページでは何も出さない

    const bar = document.createElement("section");
    bar.id = BAR_ID;
    bar.className = "dpt-import";
    mount(bar);
    lastKey = keyOf(works);
    render(bar, works);
  }

  boot();

  // お気に入りページは絞り込みや並べ替えで中身が差し替わる。
  // 件数がずれたまま古いバーを見せると嘘になるので、変化したら作り直す。
  //
  // 注意: render() 自体が DOM を触るので、素直に監視すると自分の描画で
  // 再帰的に発火し続ける。**作品IDの集合が変わった時だけ**描き直して断ち切る。
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const works = DOM.harvestWorks();
      if (works.length === 0) return;
      const key = keyOf(works);
      if (key === lastKey) return;
      lastKey = key;
      const bar = document.getElementById(BAR_ID);
      if (bar) render(bar, works);
      else boot();
    }, 600);
  }).observe(document.body, { childList: true, subtree: true });
})();
