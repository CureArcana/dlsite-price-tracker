/**
 * 開発プレビュー用の chrome.* スタブ（お気に入りバー / popup 用）。
 *
 * dev/preview.html は作品ページ専用でスタブを内蔵しているが、
 * こちらは storage と sendMessage だけで足りるので共有ファイルにしてある。
 * 拡張の実コードを 1 行も変えずにブラウザで動かすための足場。
 */

(() => {
  // sessionStorage に置いてリロードを跨がせる。ここをメモリだけにすると
  // 「サンプルを入れて再読み込み」した瞬間に消えて、空の画面しか見られない。
  const SEED = "__dpt_stub_storage";
  let mem = {};
  try {
    mem = JSON.parse(sessionStorage.getItem(SEED) || "{}");
  } catch {
    mem = {};
  }

  const persist = () => {
    try {
      sessionStorage.setItem(SEED, JSON.stringify(mem));
    } catch {
      /* 容量超過などは無視 */
    }
  };

  window.__DPT_MEM = mem; // 検証で中身を覗くため
  window.__DPT_RESET = () => {
    sessionStorage.removeItem(SEED);
    location.reload();
  };

  window.chrome = {
    storage: {
      local: {
        async get(key) {
          if (key === null || key === undefined) return { ...mem };
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) if (k in mem) out[k] = mem[k];
          return out;
        },
        async set(obj) {
          Object.assign(mem, obj);
          persist();
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete mem[k];
          persist();
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: "0.1.1" }),
      getURL: (p) => `/${p}`,
      async sendMessage(msg) {
        if (msg?.type === "WATCH_CHECK_NOW") {
          // 点検の結果だけを模す。実際の判定は service worker 側で行う。
          const map = mem.watchlist || {};
          const ids = Object.keys(map);
          const result = { at: Date.now(), checked: ids.length, hits: ids.length ? 1 : 0 };
          mem.watchCheck = result;
          // 1件目に「現在価格が見えた」状態を作って表示を確かめられるようにする
          if (ids[0]) {
            map[ids[0]].lastSeen = { price: 423, rate: 45, at: Date.now() };
            mem.watchlist = map;
          }
          persist();
          return result;
        }
        return null;
      },
    },
  };
})();
