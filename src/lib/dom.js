/**
 * DLsite の DOM 依存を 1 ファイルに集約する。
 *
 * DLsite のマークアップが変わったとき、直す場所をここだけに閉じ込めるのが目的。
 * どのアンカーも配列でフォールバックを持ち、全滅したら注入を諦める（= DLsite の
 * 画面を壊さない）。壊れた状態で無理に描画するより、静かに消えるほうが安全。
 */

globalThis.DPT_DOM = (() => {
  /** URL から product_id を取り出す。取れなければ null。 */
  function productIdFromUrl(href = location.href) {
    const m = href.match(/\/product_id\/(RJ\d+)/i);
    return m ? m[1].toUpperCase() : null;
  }

  /**
   * パネルの差し込み位置。
   * サンプル画像（#work_left）と作品情報テーブル（#work_outline）を包む
   * #work_header の直後 = 本文カラムの全幅が使える位置に、横長で置く。
   * 右カラム内（旧位置）は縦に細長く潰れるので、構造変更時の保険に格下げ。
   */
  const ANCHORS = [
    { selector: "#work_header", position: "afterend" },
    { selector: "#intro-title", position: "beforebegin" },
    { selector: ".work_parts_container", position: "beforebegin" },
    { selector: "#work_parts_container", position: "beforebegin" },
    { selector: ".work_parts_area", position: "beforebegin" },
    { selector: "#work_outline", position: "beforebegin" },
    { selector: "#work_buy_box_wrapper", position: "afterend" },
    { selector: "#work_right", position: "beforeend" },
  ];

  function findAnchor() {
    for (const a of ANCHORS) {
      const el = document.querySelector(a.selector);
      if (el) return { el, position: a.position };
    }
    return null;
  }

  /** 作品ページかどうか。announce（予約作品）は価格履歴が無いので除く。 */
  function isTrackablePage() {
    return Boolean(productIdFromUrl()) && !location.pathname.includes("/announce/");
  }

  /** お気に入り（欲しいものリスト）ページかどうか。全年齢サイト /home/ 側も同じ構造。 */
  function isWishlistPage() {
    return /\/(maniax|home|girls|girls-pro|pro|eco|app)\/mypage\/wishlist/.test(location.pathname);
  }

  /**
   * ページ内の作品を総ざらいして [{ id, title }] を返す。
   *
   * お気に入りページの DOM は将来変わりうるので、**特定のクラス名に依存しない**。
   * 「product_id を含むリンク」と「data 属性」の 2 系統から拾い、
   * タイトルはリンク周辺から取れたものを使う（取れなくても ID だけで機能する）。
   *
   * これは DLsite への追加リクエストを 1 本も出さない。
   * ユーザーが自分で開いたページの DOM を読むだけなので、スクレイピングではない。
   */
  function harvestWorks(root = document) {
    const found = new Map();

    const remember = (rawId, title) => {
      if (!rawId) return;
      const id = String(rawId).toUpperCase();
      if (!/^RJ\d+$/.test(id)) return;
      const clean = (title || "").replace(/\s+/g, " ").trim();
      const prev = found.get(id);
      // タイトルは長いほうが本文らしい（「続きを読む」等の短い誤爆を避ける）
      if (!prev || (clean && clean.length > (prev.title || "").length)) {
        found.set(id, { id, title: clean || prev?.title || null });
      }
    };

    /** リンクから作品名らしい文字列を探す。 */
    const titleNear = (a) => {
      const own = (a.getAttribute("title") || a.textContent || "").trim();
      if (own.length > 3) return own;
      const img = a.querySelector("img[alt]");
      if (img && img.alt.trim().length > 3) return img.alt;
      // 同じ行（li / tr / .n_worklist_item 等）の中の作品名要素を探す
      const row = a.closest("li, tr, [class*=worklist], [class*=work_item], [class*=search_result]");
      const named = row?.querySelector('[class*="work_name"], [class*="title"]');
      const t = (named?.textContent || "").trim();
      return t.length > 3 ? t : own;
    };

    root.querySelectorAll('a[href*="/product_id/RJ"]').forEach((a) => {
      const m = a.getAttribute("href").match(/\/product_id\/(RJ\d+)/i);
      if (m) remember(m[1], titleNear(a));
    });

    root.querySelectorAll("[data-list_item_product_id]").forEach((el) => {
      remember(el.getAttribute("data-list_item_product_id"), el.textContent);
    });

    return [...found.values()];
  }

  return { productIdFromUrl, findAnchor, isTrackablePage, isWishlistPage, harvestWorks };
})();
