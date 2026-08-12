#!/usr/bin/env bash
# GraphNovel — Node/Pi quick start script
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "错误：需要 Node.js 22 或更高版本。" >&2
    exit 1
fi

if [ ! -d "node_modules" ]; then
    npm ci
fi

echo ""
echo "GraphNovel — starting Node Web UI..."
echo "Open http://127.0.0.1:5500 in your browser."
echo ""

exec npm run dev
