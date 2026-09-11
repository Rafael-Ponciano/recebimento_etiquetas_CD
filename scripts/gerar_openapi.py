"""Gera docs/openapi.json a partir do schema real do FastAPI (backend/app/main.py).

Não inicia o servidor nem faz chamadas de rede: importa o objeto `app` e chama
`app.openapi()`, que o FastAPI monta a partir das rotas/Pydantic models já
carregados em memória. Por isso é seguro rodar em qualquer máquina com o venv
do backend instalado, mesmo sem Supabase/BigQuery/AnyMarket configurados.

Uso (raiz do projeto, com backend/.venv já criado e com dependências):

    backend\\.venv\\Scripts\\activate
    python scripts\\gerar_openapi.py

Ou via scripts\\gerar_openapi.bat.

Rodar sempre que uma rota, request body ou response model mudar em
`backend/app/routers/*.py` — mantém docs/openapi.json fiel ao código (ver
AGENTS.md, seção 11).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
BACKEND = RAIZ / "backend"
SAIDA = RAIZ / "docs" / "openapi.json"


def main() -> None:
    sys.path.insert(0, str(BACKEND))
    try:
        from app.main import app  # import tardio: só depois de ajustar sys.path
    except Exception as e:  # pragma: no cover
        print(f"[gerar_openapi] Falha ao importar backend/app/main.py: {e}")
        print(
            "[gerar_openapi] Confirme que o venv do backend está ativo "
            "(backend\\.venv\\Scripts\\activate) e as dependências instaladas "
            "(pip install -r backend/requirements.txt)."
        )
        raise SystemExit(1)

    spec = app.openapi()

    SAIDA.parent.mkdir(parents=True, exist_ok=True)
    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=2)
        f.write("\n")

    n_paths = len(spec.get("paths", {}))
    print(f"[gerar_openapi] OK — {n_paths} rotas exportadas para {SAIDA}")


if __name__ == "__main__":
    main()
