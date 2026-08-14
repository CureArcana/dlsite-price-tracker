/**
 * DLsite Price Tracker — background service worker
 *
 * 役割:
 *   1. voice-labo.com API から価格履歴を取得する（host_permissions 経由なので CORS 不要）
 *   2. 取得結果を chrome.storage.local に 6 時間キャッシュする
 *   3. GitHub Releases の最新版を 1 日 1 回確認する（ストア配布ではないため自動更新が無い）
 *
 * content script から直接 fetch せずここに集約しているのは、
 * DLsite のページ origin から外部 API を叩くと CORS に阻まれるため。
 */

// 2026-08-09 に voicelabo.net → voice-labo.com へ移転。旧ドメインは 410 Gone を返すため
// ここを旧値のままにすると拡張が丸ごと沈黙する（v0.1.0 が実際にそうなっていた）。
const API_BASE = "https://voice-labo.com/api/ext";
const RELEASES_API = "https://api.github.com/repos/CureArcana/dlsite-price-tracker/releases/latest";
const RELEASES_PAGE = "https://github.com/CureArcana/dlsite-price-tracker/releases/latest";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6時間。works_daily は日次更新なので十分。
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

/** キャッシュ肥大を防ぐための保持上限。超えたら古い順に捨てる。 */
const MAX_CACHED_WORKS = 500;

const cacheKey = (productId) => `ph:${productId}`;

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

  return false;
});
