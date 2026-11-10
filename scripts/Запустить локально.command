#!/bin/zsh
TASK_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'Python 3 не найден. Откройте файл «Телесуфлёр.html» напрямую в Chrome.' 'Нажмите Enter, чтобы закрыть окно.'
  read -r
  exit 1
fi
exec python3 "$TASK_DIR/prepare-local.py" --directory "$TASK_DIR"
