/**
 * DLsite Price Tracker — background service worker
 *
 * 役割:
 *   1. voice-labo.com API から価格履歴を取得する（host_permissions 経由なので CORS 不要）
 *   2. 取得結果を chrome.storage.local に 6 時間キャッシュする
 *   3. GitHub Releases の最新版を 1 日 1 回確認する（ストア配布ではないため自動更新が無い）
 *   4. ウォッチリストを定期チェックして、条件を満たしたら通知する
 *
 * content script から直接 fetch せずここに集約しているのは、
 * DLsite のページ origin から外部 API を叩くと CORS に阻まれるため。
 *
 * ES モジュールにしていないのは、watchlist.js を content script / popup と
 * 共有するため（content script はモジュール不可）。importScripts で読み込む。
 */

importScripts("/src/lib/watchlist.js");

const WL = globalThis.DPT_WATCHLIST;

// 2026-08-09 に voicelabo.net → voice-labo.com へ移転。旧ドメインは 410 Gone を返すため
// ここを旧値のままにすると拡張が丸ごと沈黙する（v0.1.0 が実際にそうなっていた）。
const API_BASE = "https://voice-labo.com/api/ext";
const RELEASES_API = "https://api.github.com/repos/CureArcana/dlsite-price-tracker/releases/latest";
const RELEASES_PAGE = "https://github.com/CureArcana/dlsite-price-tracker/releases/latest";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6時間。works_daily は日次更新なので十分。
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

/** ウォッチリストの点検間隔。スキャンは日次2回なので6時間で取りこぼさない。 */
const WATCH_ALARM = "dpt-watch-check";
const WATCH_INTERVAL_MIN = 360;

/** batch API の上限。サーバー側 BATCH_MAX_IDS と揃える。 */
const BATCH_MAX_IDS = 50;

/** 一度に出す個別通知の上限。これを超えたら1本にまとめる（通知スパム防止）。 */
const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

/** キャッシュ肥大を防ぐための保持上限。超えたら古い順に捨てる。 */
const MAX_CACHED_WORKS = 500;

// v0.3.1 で `ph:` → `ph2:` にリネーム。
// 理由: v0.2.x + 旧 backend (RJ 音声決め打ちルーター) 時代に、DLsite の RJ 非音声
// 作品 (漫画・CG) を開くと 404 が返り、それが `ph:` キーで 6 時間キャッシュされていた。
// backend が 3-DB ルーティングで正しくデータを返すようになっても、キャッシュ TTL が
// 切れるまで拡張は 404 を表示し続ける。プレフィックス変更で強制的に旧キャッシュを迂回する。
const cacheKey = (productId) => `ph2:${productId}`;

async function readCache(productId) {
  const key = cacheKey(productId);
  const bag = await chrome.storage.local.get(key);
  const entry = bag[key];
  if (!entry || typeof entry.at !== "number") return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) return null;
  return entry;
}

async function writeCache(productId, payload) {
  await chrome.storage.local.set({
    [cacheKey(productId)]: { at: Date.now(), ...payload },
  });
  pruneCache();
}

/** 保持上限を超えた分を古い順に削除する（失敗しても致命的ではないので握りつぶす）。 */
async function pruneCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all)
      .filter(([k, v]) => k.startsWith("ph:") && v && typeof v.at === "number")
      .sort((a, b) => a[1].at - b[1].at);
    if (entries.length <= MAX_CACHED_WORKS) return;
    const doomed = entries.slice(0, entries.length - MAX_CACHED_WORKS).map(([k]) => k);
    await chrome.storage.local.remove(doomed);
  } catch {
    /* noop */
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    return { status: res.status, body: res.ok ? await res.json() : null };
  } finally {
    clearTimeout(timer);
  }
}

async function getPriceHistory(productId) {
  const cached = await readCache(productId);
  if (cached) return { ok: cached.ok, data: cached.data ?? null, status: cached.status, cached: true };

  let result;
  try {
    const { status, body } = await fetchJson(`${API_BASE}/price-history/${encodeURIComponent(productId)}`);
    if (status === 200 && body) {
      result = { ok: true, data: body, status };
    } else if (status === 404) {
      // 未収録作品。これは異常ではないので、同じくキャッシュして問い合わせを繰り返さない。
      result = { ok: false, data: null, status: 404 };
    } else {
      // サーバ側の一時的な不調。キャッシュせず次回に再試行させる。
      return { ok: false, data: null, status, transient: true };
    }
  } catch (err) {
    return { ok: false, data: null, status: 0, transient: true, error: String(err) };
  }

  await writeCache(productId, result);
  return { ...result, cached: false };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: res.ok ? await res.json() : null };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── ウォッチリストの点検 ─────────────────────────

/**
 * ウォッチリスト全件の現在値を batch API でまとめて取る。
 *
 * batch はスリムな形（current / min / discount_rate / is_lowest_ever / signal）しか
 * 返さない。判定にはそれで足りる。タイトルとアフィリンクは**発火した数件だけ**
 * 単品 GET で取る。全件に付けて返させると 50 件で 9KB 無駄になるため。
 */
async function fetchCurrentStats(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += BATCH_MAX_IDS) {
    const chunk = ids.slice(i, i + BATCH_MAX_IDS);
    try {
      const { status, body } = await postJson(`${API_BASE}/price-history/batch`, { product_ids: chunk });
      if (status === 200 && body && body.items) Object.assign(out, body.items);
    } catch {
      /* 一時的な失敗。この回は諦める。次の点検で拾い直す。 */
    }
    // 連続で叩かない。300件でも6リクエストなので待っても体感に影響しない。
    if (i + BATCH_MAX_IDS < ids.length) await sleep(1000);
  }
  return out;
}

/** 通知クリック先の URL を覚えておく。service worker は通知の生存期間より先に死ぬ。 */
const notifKey = (id) => `notif:${id}`;

async function notify({ id, title, message, url }) {
  try {
    await chrome.storage.local.set({ [notifKey(id)]: { url, at: Date.now() } });
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      // 通知を開いたまま放置されても、クリックで買いに行けるようにしておく。
      requireInteraction: false,
      silent: false,
    });
  } catch {
    /* 通知が拒否されている環境。機能そのものは壊さない。 */
  }
}

/**
 * ウォッチリストを点検し、条件を満たしたものを通知する。
 * 戻り値は popup の「今すぐ確認」ボタンがそのまま表示できる形にする。
 */
async function runWatchCheck() {
  const entries = await WL.list();
  if (entries.length === 0) {
    await chrome.storage.local.set({ watchCheck: { at: Date.now(), checked: 0, hits: 0 } });
    return { checked: 0, hits: 0 };
  }

  const stats = await fetchCurrentStats(entries.map((e) => e.id));
  const updates = [];
  const hits = [];

  for (const entry of entries) {
    const s = stats[entry.id];
    if (!s) continue; // 未収録 / 取得失敗。次回に回す。
    // min / lowest は popup の「過去最安かどうか」表示に使う。
    // is_lowest_ever は「更新」を厳密に見るため、最安と同値の日は false になる。
    // 一覧では「今が最安値か」を知りたいので、min との同値も最安扱いにする。
    const current = Number(s.current);
    const min = Number.isFinite(Number(s.min)) ? Number(s.min) : null;
    const update = {
      id: entry.id,
      lastSeen: {
        price: current,
        rate: Number(s.discount_rate) || 0,
        list: Number.isFinite(Number(s.list_price)) ? Number(s.list_price) : null,
        min,
        lowest: s.is_lowest_ever === true || (min !== null && current <= min),
        // FANZA のサムネは floor が URL に入り ID から組み立てられないため、
        // サーバーが返す実 URL を保存する（popup がこれを最優先で使う）。
        thumb: typeof s.thumb === "string" && s.thumb ? s.thumb : null,
        at: Date.now(),
      },
    };
    if (WL.shouldNotify(entry, s)) {
      hits.push({ entry, stats: s });
      update.notified = { price: Number(s.current), at: Date.now() };
    }
    updates.push(update);
  }

  // 発火した数件だけ単品 GET で title / affiliate_url を取る。
  // アフィIDはサーバーが組み立てる（拡張に焼き込むと 8月の ID 変更でまた死ぬ）。
  for (const hit of hits.slice(0, MAX_INDIVIDUAL_NOTIFICATIONS)) {
    try {
      const { status, body } = await fetchJson(
        `${API_BASE}/price-history/${encodeURIComponent(hit.entry.id)}`,
      );
      if (status === 200 && body) {
        hit.title = body.title || null;
        hit.url = body.affiliate_url || body.voicelabo_url || null;
        const u = updates.find((x) => x.id === hit.entry.id);
        if (u && body.title) u.title = body.title;
      }
    } catch {
      /* リンクが取れなくても通知はする。クリック先はボイラボにフォールバック。 */
    }
    await sleep(300);
  }

  await WL.recordCheck(updates);

  if (hits.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
    // まとめ通知。1件ずつ鳴らすと通知センターが埋まってアンインストールされる。
    await notify({
      id: `dpt-summary-${Date.now()}`,
      title: `${hits.length}件が希望の価格になりました`,
      message: hits
        .slice(0, 4)
        .map((h) => `・${h.title || h.entry.title || h.entry.id}`)
        .join("\n"),
      // 何を指せばいいか決められないので、ウォッチリスト画面をタブで開く。
      url: chrome.runtime.getURL("src/popup/popup.html"),
    });
  } else {
    for (const h of hits) {
      const name = h.title || h.entry.title || h.entry.id;
      const rate = Number(h.stats.discount_rate) || 0;
      await notify({
        id: `dpt-${h.entry.id}-${h.stats.current}`,
        title: `${Number(h.stats.current).toLocaleString("ja-JP")}円になりました${rate ? `（${rate}%OFF）` : ""}`,
        message: name.length > 90 ? `${name.slice(0, 90)}…` : name,
        url: h.url,
      });
    }
  }

  const result = { at: Date.now(), checked: entries.length, hits: hits.length };
  await chrome.storage.local.set({ watchCheck: result });
  return result;
}

/** 点検アラームを張る。既にあれば作り直さない（毎回起動時に間隔がリセットされる）。 */
async function ensureWatchAlarm() {
  try {
    const existing = await chrome.alarms.get(WATCH_ALARM);
    if (existing) return;
    await chrome.alarms.create(WATCH_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: WATCH_INTERVAL_MIN,
    });
  } catch {
    /* alarms 権限が無い環境では静かに諦める */
  }
}

chrome.runtime.onInstalled.addListener(ensureWatchAlarm);
chrome.runtime.onStartup.addListener(ensureWatchAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCH_ALARM) runWatchCheck();
});

chrome.notifications.onClicked.addListener(async (id) => {
  const key = notifKey(id);
  let url = null;
  try {
    const bag = await chrome.storage.local.get(key);
    url = bag[key]?.url || null;
    await chrome.storage.local.remove(key);
  } catch {
    /* noop */
  }
  chrome.tabs.create({ url: url || "https://voice-labo.com/" });
  chrome.notifications.clear(id);
});

/**
 * GitHub Releases の最新タグを見て更新の有無を返す。
 * ストア配布をしていないので自動更新が効かない。ユーザーに気付いてもらう唯一の経路。
 */
async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  const bag = await chrome.storage.local.get("updateCheck");
  const prev = bag.updateCheck;
  if (prev && Date.now() - prev.at < UPDATE_CHECK_INTERVAL_MS) {
    return { ...prev.result, current };
  }

  let result = { latest: null, hasUpdate: false, url: RELEASES_PAGE };
  try {
    const { status, body } = await fetchJson(RELEASES_API);
    if (status === 200 && body && typeof body.tag_name === "string") {
      const latest = body.tag_name.replace(/^v/, "");
      result = { latest, hasUpdate: isNewer(latest, current), url: body.html_url || RELEASES_PAGE };
    }
  } catch {
    /* 更新確認の失敗はユーザーに見せない */
  }

  await chrome.storage.local.set({ updateCheck: { at: Date.now(), result } });
  return { ...result, current };
}

/** セマンティックバージョンの単純比較。数値以外の接尾辞は無視する。 */
function isNewer(a, b) {
  const parse = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === "PRICE_HISTORY" && typeof msg.productId === "string") {
    getPriceHistory(msg.productId).then(sendResponse);
    return true; // 非同期応答
  }

  if (msg.type === "UPDATE_CHECK") {
    checkForUpdate().then(sendResponse);
    return true;
  }

  // popup の「今すぐ確認」。アラームを待たずに点検する。
  if (msg.type === "WATCH_CHECK_NOW") {
    runWatchCheck().then(sendResponse, () => sendResponse(null));
    return true;
  }

  return false;
});
