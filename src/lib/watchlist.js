/**
 * ウォッチリストと通知条件の一元管理。
 *
 * 設計方針:
 *   - **データは端末内にしか置かない。** サーバーに預けない。
 *     R18 作品の「欲しいものリスト」は極めてセンシティブなので、
 *     アカウントを作らせない・預からないのが唯一の正解。
 *     問い合わせるのは作品ID だけ（既存のプライバシー方針そのまま）。
 *   - `chrome.storage.local` を使う。`sync` は 100KB / 512 item 制限があり、
 *     300 件を持つと将来詰まる。端末間同期より容量を取る。
 *   - content script / service worker / popup の3か所から使うため、
 *     ES モジュールにせず globalThis に載せる（MV3 の content script は
 *     モジュール不可。service worker からは importScripts で読む）。
 */

globalThis.DPT_WATCHLIST = (() => {
  const KEY = "watchlist";

  /** 保持上限。batch API は 50 件/回なので 300 件 = 6 リクエストで収まる。 */
  const MAX_ENTRIES = 300;

  /**
   * 作品IDの正規化。DLsite の RJ 番号は大文字、FANZA 同人の cid（d_〜）は小文字。
   * どちらでもなければ null（ウォッチリストに入れない）。
   */
  function normalizeId(raw) {
    const s = String(raw || "").trim();
    if (/^RJ\d+$/i.test(s)) return s.toUpperCase();
    if (/^d_[a-z0-9_]+$/i.test(s)) return s.toLowerCase();
    return null;
  }

  /**
   * 通知条件のモード。
   * `lowest` を既定にしているのは、設定を一切させずに一番役に立つから。
   * 金額や割引率を自分で決めたい人だけが他を選ぶ。
   */
  const MODES = ["lowest", "price", "rate", "both", "either"];

  const DEFAULT_RULE = { mode: "lowest", price: null, rate: null };

  const MODE_LABELS = {
    lowest: "過去最安を更新したら",
    price: "指定した金額以下になったら",
    rate: "指定した割引率以上になったら",
    both: "金額と割引率の両方を満たしたら",
    either: "金額か割引率のどちらかを満たしたら",
  };

  /** 条件を正規化する。壊れた値が入っていても既定に落として動き続ける。 */
  function normalizeRule(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const mode = MODES.includes(r.mode) ? r.mode : DEFAULT_RULE.mode;
    const price = Number.isFinite(Number(r.price)) && Number(r.price) > 0 ? Math.round(Number(r.price)) : null;
    const rate = Number.isFinite(Number(r.rate)) && Number(r.rate) > 0 ? Math.min(99, Math.round(Number(r.rate))) : null;

    // 金額/割引率を使うモードなのに数値が無いと永久に発火しない。既定へ落とす。
    if ((mode === "price" || mode === "both") && price === null) return { ...DEFAULT_RULE };
    if ((mode === "rate" || mode === "both") && rate === null) return { ...DEFAULT_RULE };
    if (mode === "either" && price === null && rate === null) return { ...DEFAULT_RULE };

    return { mode, price, rate };
  }

  /** 条件を日本語1行にする。パネルと popup で同じ文言を出すため共有する。 */
  function describeRule(rule) {
    const r = normalizeRule(rule);
    switch (r.mode) {
      case "price":
        return `${r.price.toLocaleString("ja-JP")}円以下になったら通知`;
      case "rate":
        return `${r.rate}%OFF 以上になったら通知`;
      case "both":
        return `${r.price.toLocaleString("ja-JP")}円以下 かつ ${r.rate}%OFF 以上で通知`;
      case "either":
        if (r.price !== null && r.rate !== null) {
          return `${r.price.toLocaleString("ja-JP")}円以下 または ${r.rate}%OFF 以上で通知`;
        }
        return r.price !== null
          ? `${r.price.toLocaleString("ja-JP")}円以下になったら通知`
          : `${r.rate}%OFF 以上になったら通知`;
      default:
        return "過去最安を更新したら通知";
    }
  }

  /**
   * 条件を満たしているか判定する。
   *
   * `stats` は batch API の返り値 1 件分:
   *   { current, min, discount_rate, is_lowest_ever, signal, observed_days }
   *
   * batch はスリムな形しか返さないので、ここで使う値だけで判定できるように
   * 条件モデルを設計してある（title / affiliate_url は発火後に単品 GET で取る）。
   */
  function matches(rule, stats) {
    if (!stats || !Number.isFinite(Number(stats.current))) return false;
    const r = normalizeRule(rule);
    const current = Number(stats.current);
    const rate = Number(stats.discount_rate) || 0;

    // 過去最安。API の is_lowest_ever を信用するが、min と同値のケースも拾う
    // （API 側は「更新」を厳密に見るため、同値だと false になることがある）。
    const isLowest =
      stats.is_lowest_ever === true ||
      (Number.isFinite(Number(stats.min)) && current <= Number(stats.min));

    const byPrice = r.price !== null && current <= r.price;
    const byRate = r.rate !== null && rate >= r.rate;

    switch (r.mode) {
      case "price":
        return byPrice;
      case "rate":
        return byRate;
      case "both":
        return byPrice && byRate;
      case "either":
        return byPrice || byRate;
      default:
        return isLowest;
    }
  }

  /**
   * 通知すべきか。条件成立に加えて重複抑制をかける。
   *
   * 同じ価格で何度も鳴らすと即アンインストールされる。
   * 「前回通知した価格より安くなった時だけ鳴らす」= Keepa と同じ振る舞い。
   */
  function shouldNotify(entry, stats) {
    if (!matches(entry.rule, stats)) return false;
    const current = Number(stats.current);
    const last = entry.notified;
    if (!last || !Number.isFinite(Number(last.price))) return true;
    return current < Number(last.price);
  }

  async function readAll() {
    try {
      const bag = await chrome.storage.local.get(KEY);
      const raw = bag[KEY];
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  async function writeAll(map) {
    try {
      await chrome.storage.local.set({ [KEY]: map });
      return true;
    } catch {
      return false;
    }
  }

  /** 新しい順の配列で返す。UI はこの順で出す。 */
  async function list() {
    const map = await readAll();
    return Object.values(map).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  async function get(productId) {
    const map = await readAll();
    return map[productId] || null;
  }

  async function has(productId) {
    return Boolean(await get(productId));
  }

  async function count() {
    return Object.keys(await readAll()).length;
  }

  /**
   * 追加または条件の更新。既にあるものは条件だけ差し替え、
   * 通知履歴（notified）は引き継ぐ。条件をいじった拍子に鳴り直すのを防ぐ。
   *
   * lastSeen は作品ページからの登録時に渡す（パネルは今の価格を知っているので、
   * 次の定期チェックを待たずにウォッチリストへ価格・最安状態を出せる）。
   */
  async function put(productId, { title = null, rule = null, lastSeen = null } = {}) {
    const id = normalizeId(productId);
    if (!id) return { ok: false, reason: "invalid_id" };
    const map = await readAll();
    const prev = map[id];

    if (!prev && Object.keys(map).length >= MAX_ENTRIES) {
      return { ok: false, reason: "full", max: MAX_ENTRIES };
    }

    map[id] = {
      id,
      // タイトルは分かる時だけ入れる。分からなければ作品IDのまま表示する。
      title: title || prev?.title || null,
      addedAt: prev?.addedAt || Date.now(),
      rule: normalizeRule(rule || prev?.rule),
      notified: prev?.notified || null,
      lastSeen: lastSeen || prev?.lastSeen || null,
    };
    const ok = await writeAll(map);
    return { ok, entry: map[id], created: !prev };
  }

  async function remove(productId) {
    const id = normalizeId(productId) || String(productId || "");
    const map = await readAll();
    if (!map[id]) return { ok: true, removed: false };
    delete map[id];
    const ok = await writeAll(map);
    return { ok, removed: true };
  }

  async function clear() {
    return { ok: await writeAll({}) };
  }

  /**
   * まとめて追加する（お気に入りページからの取り込み用）。
   * items: [{ id, title }]
   */
  async function putMany(items, rule = null) {
    const map = await readAll();
    let added = 0;
    let skipped = 0;
    let full = false;

    for (const it of items || []) {
      const id = normalizeId(it?.id);
      if (!id) continue;
      if (map[id]) {
        // 既に入っているものは触らない。設定済みの条件を上書きしたら事故。
        skipped += 1;
        continue;
      }
      if (Object.keys(map).length >= MAX_ENTRIES) {
        full = true;
        break;
      }
      map[id] = {
        id,
        title: it.title || null,
        addedAt: Date.now(),
        rule: normalizeRule(rule),
        notified: null,
        lastSeen: null,
      };
      added += 1;
    }

    const ok = await writeAll(map);
    return { ok, added, skipped, full, total: Object.keys(map).length };
  }

  /** チェック後の観測値と通知履歴を書き戻す。 */
  async function recordCheck(updates) {
    const map = await readAll();
    for (const u of updates || []) {
      const e = map[u.id];
      if (!e) continue;
      if (u.lastSeen !== undefined) e.lastSeen = u.lastSeen;
      if (u.notified !== undefined) e.notified = u.notified;
      if (u.title && !e.title) e.title = u.title;
    }
    await writeAll(map);
  }

  return {
    KEY,
    MAX_ENTRIES,
    MODES,
    MODE_LABELS,
    DEFAULT_RULE,
    normalizeId,
    normalizeRule,
    describeRule,
    matches,
    shouldNotify,
    list,
    get,
    has,
    count,
    put,
    putMany,
    remove,
    clear,
    recordCheck,
  };
})();
