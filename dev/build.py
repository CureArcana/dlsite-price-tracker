"""配布用 ZIP の作成と、manifest.json の整合性チェック。

    python dev/build.py            # 検証のみ
    python dev/build.py --zip      # 検証して dist/ に ZIP を作る

ストア配布をしていないため、ユーザーは ZIP を解凍して
「パッケージ化されていない拡張機能を読み込む」で入れる。
manifest が参照しているファイルが 1 つでも欠けると読み込み時にエラーになるので、
ZIP を作る前に必ず実在を確認する。
"""

from __future__ import annotations

import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 配布物に含めるもの。dev/ と docs/ は開発用なので入れない。
INCLUDE_FILES = ["manifest.json", "LICENSE", "README.md"]
INCLUDE_DIRS = ["src", "icons"]


def load_manifest() -> dict:
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)


def referenced_paths(manifest: dict) -> list[str]:
    """manifest が参照しているファイルパスを全部拾う。"""
    paths: list[str] = list(manifest.get("icons", {}).values())
    bg = manifest.get("background", {})
    if bg.get("service_worker"):
        paths.append(bg["service_worker"])
    for cs in manifest.get("content_scripts", []):
        paths += cs.get("js", []) + cs.get("css", [])
    action = manifest.get("action", {})
    if action.get("default_popup"):
        paths.append(action["default_popup"])
    paths += list(action.get("default_icon", {}).values())
    return paths


def importscripts_paths(sw_rel: str) -> list[str]:
    """service worker が importScripts で読むファイルを拾う。

    ES モジュールを使わず importScripts にしているため、manifest からは辿れない。
    ここが欠けると拡張が起動時に丸ごと死ぬので、ZIP を作る前に実在を確かめる。
    """
    full = os.path.join(ROOT, sw_rel)
    if not os.path.isfile(full):
        return []
    with open(full, encoding="utf-8") as f:
        src = f.read()
    return [p.lstrip("/") for p in re.findall(r'importScripts\(\s*["\']([^"\']+)["\']', src)]


def validate(manifest: dict) -> list[str]:
    errors: list[str] = []

    if manifest.get("manifest_version") != 3:
        errors.append("manifest_version は 3 であること")
    if not manifest.get("key"):
        errors.append('"key" が無い。拡張IDが固定されず、再インストールで設定が失われる')
    for field in ("name", "version", "description"):
        if not manifest.get(field):
            errors.append(f'"{field}" が空')

    for rel in referenced_paths(manifest):
        if not os.path.isfile(os.path.join(ROOT, rel)):
            errors.append(f"manifest が参照しているファイルが無い: {rel}")

    sw = manifest.get("background", {}).get("service_worker")
    if sw:
        if manifest["background"].get("type") == "module":
            errors.append("service_worker が type:module。importScripts が使えなくなる")
        for rel in importscripts_paths(sw):
            if not os.path.isfile(os.path.join(ROOT, rel)):
                errors.append(f"service worker の importScripts 先が無い: {rel}")

    # content script は globalThis 経由で受け渡すので、lib が後ろに来ると壊れる。
    # 使うライブラリの組み合わせはスクリプトごとに違うため、順序ではなく
    # 「lib が content より前」「使っている lib が全部入っている」を見る。
    provides = {
        "src/lib/dom.js": "DPT_DOM",
        "src/lib/format.js": "DPT_FORMAT",
        "src/lib/chart.js": "DPT_CHART",
        "src/lib/watchlist.js": "DPT_WATCHLIST",
    }
    for cs in manifest.get("content_scripts", []):
        js = cs.get("js", [])
        libs = [p for p in js if p.startswith("src/lib/")]
        entries = [p for p in js if not p.startswith("src/lib/")]
        if libs and entries and js.index(libs[-1]) > js.index(entries[0]):
            errors.append(f"content_scripts の読み込み順が不正（lib は content より前）: {js}")
        for entry in entries:
            full = os.path.join(ROOT, entry)
            if not os.path.isfile(full):
                continue
            with open(full, encoding="utf-8") as f:
                body = f.read()
            for lib, symbol in provides.items():
                if f"globalThis.{symbol}" in body and lib not in js:
                    errors.append(f"{entry} が {symbol} を使うのに {lib} が読み込まれていない")

    # 通知・定期実行を使うなら権限が要る。宣言漏れは実行時まで気づけない。
    perms = set(manifest.get("permissions", []))
    for need in ("storage", "alarms", "notifications"):
        if need not in perms:
            errors.append(f'permissions に "{need}" が無い')

    # host_permissions に DLsite を含めない（拡張から DLsite へ通信しない方針）
    for host in manifest.get("host_permissions", []):
        if "dlsite.com" in host:
            errors.append(f"host_permissions に DLsite が入っている: {host}（スクレイピング禁止の方針に反する）")

    return errors


def collect() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for rel in INCLUDE_FILES:
        out.append((os.path.join(ROOT, rel), rel))
    for d in INCLUDE_DIRS:
        for base, _dirs, files in os.walk(os.path.join(ROOT, d)):
            for fn in sorted(files):
                full = os.path.join(base, fn)
                out.append((full, os.path.relpath(full, ROOT).replace("\\", "/")))
    return out


def main() -> int:
    manifest = load_manifest()
    errors = validate(manifest)
    if errors:
        for e in errors:
            print(f"NG  {e}")
        return 1

    entries = collect()
    print(f"OK  manifest v{manifest['version']} / 参照ファイルすべて実在 / 収録 {len(entries)} 件")

    if "--zip" not in sys.argv:
        return 0

    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, f"dlsite-price-tracker-v{manifest['version']}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for full, rel in entries:
            z.write(full, rel)
    print(f"OK  {os.path.relpath(out, ROOT)} ({os.path.getsize(out):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
