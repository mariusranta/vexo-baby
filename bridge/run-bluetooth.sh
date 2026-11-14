#!/bin/zsh
# Start the bridge over Bluetooth. Double-tap the band first (light blinks blue).
#   bridge/run-bluetooth.sh 66 Marco
# Run it from Terminal.app: macOS only gives Bluetooth to apps that ask for it properly.
cd "$(dirname "$0")/.."
PY=${VEXO_PY:-.venv/bin/python}                 # made with: uv venv --python 3.12 .venv && uv pip install -r bridge/requirements.txt
[ -x "$PY" ] || PY=$HOME/Documents/vexo-hack/.venv/bin/python
[ -x "$PY" ] || PY=python3
exec "$PY" -u bridge/bridge.py "${1:-66}" --who "${2:-Marco}" "${@:3}"
