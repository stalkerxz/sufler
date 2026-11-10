#!/usr/bin/env python3
"""Prepare a private Python runtime and verify/extract the bundled Russian model."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

MODEL_HASH = '961d5ff98a17f4aa6de69864d0aa71fa5bac682301d2b5d17a3f24c5c99a46d4'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    root = args.directory.resolve()
    runtime = root / '.runtime'
    python = runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.exists():
        print('Подготавливаю отдельное окружение Python…', flush=True)
        subprocess.run([sys.executable, '-m', 'venv', str(runtime)], check=True)
    check = subprocess.run([str(python), '-c', 'import vosk'], capture_output=True)
    if check.returncode:
        print('Устанавливаю локальный движок речи из PyPI. Интернет нужен только для подготовки…', flush=True)
        subprocess.run([str(python), '-m', 'pip', 'install', 'vosk==0.3.44', '--disable-pip-version-check'], check=True)
    model = root / 'model-ru'
    if not (model / 'am' / 'final.mdl').is_file():
        archive = root / 'model-ru.zip'
        if not archive.is_file():
            sys.exit('Не найден model-ru.zip. Распакуйте полный комплект заново.')
        print('Проверяю и распаковываю русскую модель…', flush=True)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != MODEL_HASH:
            sys.exit('Архив модели повреждён. Распакуйте полный комплект заново.')
        with tempfile.TemporaryDirectory(dir=root, prefix='.model-') as scratch:
            target = Path(scratch).resolve()
            with zipfile.ZipFile(archive) as z:
                if sum(i.file_size for i in z.infolist()) > 300_000_000 or len(z.infolist()) > 1000:
                    sys.exit('Неверный архив модели.')
                for info in z.infolist():
                    if not (target / info.filename).resolve().is_relative_to(target) or ((info.external_attr >> 16) & 0o170000) == 0o120000:
                        sys.exit('Небезопасный путь в архиве модели.')
                z.extractall(target)
            extracted = target / 'vosk-model-small-ru-0.22'
            if not (extracted / 'am' / 'final.mdl').is_file():
                sys.exit('Модель не содержит акустических данных.')
            if model.exists():
                sys.exit('Папка model-ru существует, но неполна. Переименуйте её и запустите снова.')
            shutil.move(str(extracted), str(model))
    command = [str(python), str(root / 'start-local.py'), '--directory', str(root), '--model', str(model)]
    if args.no_open:
        command.append('--no-open')
    os.execv(str(python), command)

if __name__ == '__main__':
    main()
