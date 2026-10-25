#!/bin/sh
# Makes zood-pdf-site.zip: only what the website serves, ready to upload into
# a static host's web root (Hostinger: public_html of pdf.zoodrealty.com). Run from
# anywhere: sh website/tools/pack.sh [output.zip]
# The licensed headline font is added when assets/fonts/licensed/ has it; the
# zip is then private and must never be posted anywhere public.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$here/zood-pdf-site.zip"}
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
rm -f "$out"
cd "$here"
git ls-files -- . ':!tools' ':!README.md' ':!Dockerfile' ':!Caddyfile' ':!.dockerignore' \
  ':!.gitignore' ':!package.json' >/tmp/zood-site-files.$$
ls assets/fonts/licensed/*.woff2 >>/tmp/zood-site-files.$$ 2>/dev/null || true
zip -q -X "$out" -@ </tmp/zood-site-files.$$
rm -f /tmp/zood-site-files.$$
echo "$out ($(wc -c <"$out" | tr -d ' ') bytes)"
