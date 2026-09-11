"""Gera docs/schema_supabase.json com o schema real das tabelas/RPCs do Supabase.

Usa o endpoint OpenAPI nativo do PostgREST (a mesma API REST que o app usa em
`supabase_client.py`) — não abre conexão direta com o Postgres nem precisa de
nenhuma credencial além das já usadas em `config.ini` (SUPABASE_URL,
SUPABASE_KEY). É uma chamada HTTP GET, somente leitura: não altera nada no
banco.

Uso (raiz do projeto):

    python scripts\\gerar_schema_supabase.py

Ou via scripts\\gerar_schema_supabase.bat.

Precisa de rede até o seu projeto Supabase (por isso roda no PC do
desenvolvedor/operação, não em ambientes sem acesso à internet externa).

Rodar sempre que uma tabela, coluna ou RPC mudar no projeto Supabase —
mantém docs/schema_supabase.json fiel ao banco real (ver AGENTS.md, seção 11).
"""

from __future__ import annotations

import configparser
import json
import sys
from pathlib import Path

try:
    import requests
except ImportError:  # pragma: no cover
    print("[gerar_schema_supabase] Falta o pacote 'requests'. Ative o venv do "
          "backend (backend\\.venv\\Scripts\\activate) antes de rodar.")
    raise SystemExit(1)

RAIZ = Path(__file__).resolve().parent.parent
SAIDA = RAIZ / "docs" / "schema_supabase.json"


def _config_ini_path() -> Path:
    """Mesma resolução de backend/app/config.py: config/config.ini primeiro, raiz legado."""
    novo = RAIZ / "config" / "config.ini"
    if novo.is_file():
        return novo
    return RAIZ / "config.ini"


def _ler_supabase_url_key() -> tuple[str, str]:
    caminho = _config_ini_path()
    if not caminho.is_file():
        print(f"[gerar_schema_supabase] config.ini não encontrado em {caminho}")
        raise SystemExit(1)

    config = configparser.ConfigParser()
    config.read(caminho, encoding="utf-8")
    secao = config["DEFAULT"]

    url = (secao.get("SUPABASE_URL") or "").strip().rstrip("/")
    key = (secao.get("SUPABASE_KEY") or "").strip()

    if not url or not key:
        print("[gerar_schema_supabase] SUPABASE_URL / SUPABASE_KEY vazios em config.ini.")
        raise SystemExit(1)

    if key.startswith("sb_publishable_") or "anon" in key[:80].casefold():
        print(
            "[gerar_schema_supabase] Aviso: a SUPABASE_KEY parece não ser a "
            "service_role. O schema retornado pode vir incompleto (RLS)."
        )

    return url, key


def main() -> None:
    url, key = _ler_supabase_url_key()

    resposta = requests.get(
        f"{url}/rest/v1/",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/openapi+json",
        },
        timeout=20,
    )
    resposta.raise_for_status()
    spec = resposta.json()

    SAIDA.parent.mkdir(parents=True, exist_ok=True)
    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=2)
        f.write("\n")

    n_tabelas = len(spec.get("definitions", {}))
    print(f"[gerar_schema_supabase] OK — {n_tabelas} tabelas/views exportadas para {SAIDA}")


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"[gerar_schema_supabase] Falha de rede/HTTP ao consultar o Supabase: {e}")
        sys.exit(1)
