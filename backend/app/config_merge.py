"""Mescla / sincroniza config.ini a partir do config.example.ini do pacote.

- Chaves novas: adicionadas se faltarem.
- Chaves de infraestrutura (Supabase/BQ/update oficial): sempre atualizadas
  a partir do example quando o valor do example for real (não placeholder).
- Credenciais locais (impressora, AnyMarket, SMTP, JWT, etc.): preservadas.
"""

from __future__ import annotations

import configparser
import shutil
from pathlib import Path

# Sempre sobrescrever no update/boot com o valor do pacote (se válido).
FORCE_KEYS = frozenset(
    {
        "SUPABASE_URL",
        "SUPABASE_KEY",
        "SUPABASE_TABELA_PEDIDOS",
        "BQ_PROJECT",
        "BQ_TABELA_PEDIDOS",
        "BQ_CREDENTIALS_FILE",
        "UPDATE_BUCKET",
        "UPDATE_LATEST_PATH",
        "UPDATE_LATEST_URL",
        "UPDATE_ENABLED",
    }
)

# Podem ser forçadas mesmo vazias (ex.: limpar URL de teste).
FORCE_ALLOW_EMPTY = frozenset({"UPDATE_LATEST_URL"})

_PLACEHOLDER_MARKERS = (
    "seu-projeto",
    "sua_service",
    "sua_",
    "your_",
    "changeme",
    "example.com",
    "xxxx",
    "placeholder",
)


def _ler(path: Path) -> configparser.ConfigParser:
    cfg = configparser.ConfigParser()
    cfg.optionxform = str  # type: ignore[method-assign]
    if path.is_file():
        cfg.read(path, encoding="utf-8")
    if "DEFAULT" not in cfg:
        cfg["DEFAULT"] = {}
    return cfg


def _valor_util(valor: str) -> bool:
    texto = (valor or "").strip()
    if not texto:
        return False
    baixo = texto.casefold()
    return not any(m in baixo for m in _PLACEHOLDER_MARKERS)


def merge_config_ini(
    user_path: Path | str,
    defaults_path: Path | str | None = None,
) -> list[str]:
    """
    Atualiza config.ini do usuário.
    Retorna lista de chaves alteradas (adicionadas ou forçadas).
    """
    user = Path(user_path)
    defaults = Path(defaults_path) if defaults_path else user.with_name("config.example.ini")
    if not user.is_file() or not defaults.is_file():
        return []

    cfg_user = _ler(user)
    cfg_def = _ler(defaults)
    existentes = {k.upper(): k for k in cfg_user["DEFAULT"]}
    alteradas: list[str] = []

    for chave in cfg_def["DEFAULT"]:
        val_def = str(cfg_def["DEFAULT"].get(chave, "")).strip()
        chave_up = chave.upper()
        forcar = chave_up in FORCE_KEYS and (
            _valor_util(val_def) or chave_up in FORCE_ALLOW_EMPTY
        )

        if chave_up in existentes:
            nome_real = existentes[chave_up]
            atual = str(cfg_user["DEFAULT"].get(nome_real, "")).strip()
            if forcar:
                if atual == val_def:
                    continue
                cfg_user["DEFAULT"][nome_real] = cfg_def["DEFAULT"][chave]
                alteradas.append(chave)
                continue
            if atual or not _valor_util(val_def):
                continue
            cfg_user["DEFAULT"][nome_real] = cfg_def["DEFAULT"][chave]
            alteradas.append(chave)
            continue

        # Chave ausente: adiciona (mesmo placeholder vazio — documenta a opção)
        cfg_user["DEFAULT"][chave] = cfg_def["DEFAULT"][chave]
        alteradas.append(chave)

    if alteradas:
        with user.open("w", encoding="utf-8") as f:
            cfg_user.write(f)
    return alteradas


def garantir_arquivo_se_ausente(
    dest_dir: Path | str,
    nome: str,
    origem: Path | str,
) -> bool:
    """Copia `origem` → dest_dir/nome apenas se o destino ainda não existir."""
    dest_dir = Path(dest_dir)
    destino = dest_dir / nome
    if destino.is_file():
        return False
    origem_p = Path(origem)
    if not origem_p.is_file():
        return False
    try:
        shutil.copy2(origem_p, destino)
        return True
    except Exception:
        return False
