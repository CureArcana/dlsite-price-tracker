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
   * 購入ボタン（#work_buy_box_wrapper）より下、作品紹介（#work_parts_area）より上に置く。
   * 購買動線を妨げず、かつスクロールで埋もれない位置。
   */
  const ANCHORS = [
    { selector: "#work_outline", position: "beforebegin" },
    { selector: ".work_parts_area", position: "beforebegin" },
    { selector: "#work_parts_container", position: "beforebegin" },
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

  return { productIdFromUrl, findAnchor, isTrackablePage };
})();
