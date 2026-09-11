from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from .config import get_external_path

def _candidatos() -> list[Path]:
    caminhos: list[Path] = []

    caminhos.append(Path(get_external_path("VERSION")))

    aqui = Path(__file__).resolve()
    caminhos.append(aqui.parents[2] / "VERSION")
    caminhos.append(aqui.parents[1] / "VERSION")
    return caminhos

@lru_cache
def get_app_version() -> str:
    for path in _candidatos():
        try:
            if path.is_file():
                texto = path.read_text(encoding="utf-8").strip().splitlines()[0].strip()
                if texto:
                    return texto
        except Exception:
            continue
    return os.environ.get("APP_VERSION", "dev").strip() or "dev"
