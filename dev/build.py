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
    return paths


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

    # content script は globalThis 経由で受け渡すので、読み込み順が崩れると壊れる
    for cs in manifest.get("content_scripts", []):
        js = cs.get("js", [])
        order = ["src/lib/dom.js", "src/lib/format.js", "src/lib/chart.js", "src/content/work-page.js"]
        if js and js != order:
            errors.append(f"content_scripts の読み込み順が想定と違う: {js}")

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
