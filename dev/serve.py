"""開発用の静的サーバー。

dev/preview.html を配信するだけなら python -m http.server で足りるが、
実際の DLsite ページに拡張のコードを流し込んで見た目を確認したいときに
クロスオリジンで取りに行く必要があるため、CORS ヘッダを足してある。

    python dev/serve.py [port]

http://localhost は Chrome の "potentially trustworthy origin" なので、
https の DLsite ページからでも mixed content として遮断されない。
"""

from __future__ import annotations

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CorsHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # 静かにする
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    handler = functools.partial(CorsHandler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {ROOT} on http://localhost:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
