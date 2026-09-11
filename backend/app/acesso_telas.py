"""Controle de quais telas cada login pode abrir.

Configuração global gravada em preferencias_usuario sob o usuário
ADMIN_ACESSO (rafael.silva), tela=acesso-telas.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, HTTPException

from .auth import AuthUser, get_current_user
from .supabase_client import get_client, executar_com_retry

ADMIN_ACESSO = "rafael.silva"
TELA_CONFIG = "acesso-telas"

TELAS_TODAS: tuple[str, ...] = (
    "pedidos",
    "historico",
    "despacho",
    "dashboard",
    "logs",
    "performance",
    "baixa-manual",
)

TELA_LABELS: dict[str, str] = {
    "pedidos": "Pedidos",
    "historico": "Histórico",
    "despacho": "Despacho",
    "dashboard": "Dashboard",
    "logs": "Logs",
    "performance": "Performance",
    "baixa-manual": "Baixa manual",
}

DEFAULTS_POR_ROLE: dict[str, tuple[str, ...]] = {
    "operador": ("pedidos", "historico", "despacho"),
    "admin": TELAS_TODAS,
}


def eh_admin_acesso(usuario: str) -> bool:
    return (usuario or "").strip().casefold() == ADMIN_ACESSO.casefold()


def _limpar_telas(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    validas = set(TELAS_TODAS)
    out: list[str] = []
    visto: set[str] = set()
    for item in raw:
        chave = str(item or "").strip().casefold()
        if chave not in validas or chave in visto:
            continue
        visto.add(chave)
        out.append(chave)
    return out


def defaults_para_role(role: str) -> list[str]:
    return list(DEFAULTS_POR_ROLE.get((role or "").strip().casefold(), DEFAULTS_POR_ROLE["operador"]))


def carregar_mapa() -> dict[str, list[str]]:
    """Mapa usuario → telas (somente overrides gravados)."""
    try:
        resp = executar_com_retry(
            lambda: (
                get_client()
                .table("preferencias_usuario")
                .select("preferencias")
                .eq("usuario", ADMIN_ACESSO)
                .eq("tela", TELA_CONFIG)
                .limit(1)
                .execute()
            )
        )
        if not resp.data:
            return {}
        raw = (resp.data[0].get("preferencias") or {}).get("mapa") or {}
        if not isinstance(raw, dict):
            return {}
        out: dict[str, list[str]] = {}
        for usuario, telas in raw.items():
            login = str(usuario or "").strip()
            if not login:
                continue
            limpas = _limpar_telas(telas)
            if limpas:
                out[login] = limpas
        return out
    except Exception:
        return {}


def salvar_mapa(mapa: dict[str, list[str]]) -> dict[str, list[str]]:
    limpo: dict[str, list[str]] = {}
    for usuario, telas in (mapa or {}).items():
        login = str(usuario or "").strip()
        if not login:
            continue
        limpas = _limpar_telas(telas)
        if limpas:
            limpo[login] = limpas

    executar_com_retry(
        lambda: (
            get_client()
            .table("preferencias_usuario")
            .upsert(
                {
                    "usuario": ADMIN_ACESSO,
                    "tela": TELA_CONFIG,
                    "preferencias": {"mapa": limpo},
                    "atualizado_em": datetime.now(timezone.utc).isoformat(),
                },
                on_conflict="usuario,tela",
            )
            .execute()
        )
    )
    return limpo


def telas_efetivas(usuario: str, role: str) -> list[str]:
    """Telas que o login pode abrir (override ou padrão do role)."""
    login = (usuario or "").strip()
    if eh_admin_acesso(login):
        return list(TELAS_TODAS)

    mapa = carregar_mapa()
    # Match case-insensitive no mapa
    alvo = login.casefold()
    for chave, telas in mapa.items():
        if chave.casefold() == alvo:
            return telas if telas else defaults_para_role(role)

    return defaults_para_role(role)


def usuario_tem_tela(usuario: str, role: str, tela: str) -> bool:
    chave = (tela or "").strip().casefold()
    return chave in telas_efetivas(usuario, role)


def catalogo_telas() -> list[dict[str, str]]:
    return [{"id": tid, "label": TELA_LABELS[tid]} for tid in TELAS_TODAS]


def require_tela(tela: str):
    """Dependency FastAPI: exige acesso à tela (além de estar autenticado)."""

    def _checker(user: AuthUser = Depends(get_current_user)) -> AuthUser:
        if not usuario_tem_tela(user.usuario, user.role, tela):
            raise HTTPException(
                status_code=403,
                detail="Você não tem permissão para acessar este recurso.",
            )
        return user

    return _checker
