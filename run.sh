#!/usr/bin/env bash
# GraphNovel — quick start script
set -euo pipefail

cd "$(dirname "$0")"

# Create virtualenv if missing
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi

source .venv/bin/activate

# Install deps
pip install -q --break-system-packages -r requirements.txt 2>/dev/null || \
    pip install -q -r requirements.txt

# Copy .env if missing
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    echo "Creating .env from .env.example — please edit it with your API key."
    cp .env.example .env
    echo "Edit .env and re-run this script."
    exit 1
fi

echo ""
echo "GraphNovel — starting Web UI..."
echo "Open http://localhost:5500 in your browser."
echo ""

python web_server.py
