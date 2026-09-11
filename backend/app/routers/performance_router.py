from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..auth import require_role, AuthUser
from ..acesso_telas import require_tela
from .. import performance_service
from ..supabase_client import get_client
from ..timeutil import hoje_br

router = APIRouter(prefix="/api/performance", tags=["performance"])


def _iter_etapas(etapas: Any) -> list[tuple[str, float]]:
    """Normaliza dict antigo ou lista nova para [(nome, delta_ms), ...] na ordem."""
    if isinstance(etapas, list):
        out: list[tuple[str, float]] = []
        for item in etapas:
            if not isinstance(item, dict):
                continue
            nome = str(item.get("etapa") or "").strip()
            if not nome:
                continue
            try:
                ms = float(item.get("ms") or 0)
            except (TypeError, ValueError):
                continue
            out.append((nome, ms))
        return out
    if isinstance(etapas, dict):
        out = []
        for nome, ms in etapas.items():
            try:
                out.append((str(nome), float(ms)))
            except (TypeError, ValueError):
                continue
        return out
    return []


class TempoClienteBody(BaseModel):
    order_id: str = Field(min_length=1)
    total_ms: float = Field(ge=0)


@router.post("/tempo-cliente")
def registrar_tempo_cliente(
    body: TempoClienteBody,
    user: AuthUser = Depends(require_role("operador", "admin")),
):
    """Grava o tempo sentido: clique em Conferir → processo terminar / modal fechar."""
    ok = performance_service.atualizar_tempo_cliente(
        body.order_id.strip(),
        body.total_ms,
        usuario=user.usuario,
    )
    if not ok:
        # tenta sem filtrar usuário (amostra acabou de ser gravada pelo backend)
        ok = performance_service.atualizar_tempo_cliente(
            body.order_id.strip(),
            body.total_ms,
            usuario=None,
        )
    return {"ok": ok, "total_ms": round(body.total_ms, 1)}


@router.get("")
def listar_performance(
    data_ini: date | None = Query(None),
    data_fim: date | None = Query(None),
    order_id: str | None = Query(None),
    usuario: str | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
    _user: AuthUser = Depends(require_tela("performance")),
):
    if data_ini is None:
        data_ini = hoje_br()
    if data_fim is None:
        data_fim = hoje_br()

    try:
        resp = (
            get_client()
            .rpc(
                "listar_conferencia_performance",
                {
                    "p_data_ini": data_ini.isoformat(),
                    "p_data_fim": data_fim.isoformat(),
                    "p_order_id": order_id or None,
                    "p_usuario": usuario or None,
                    "p_limit": limit,
                },
            )
            .execute()
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Falha ao listar performance: {e}. "
                "Rode backend/sql/conferencia_performance.sql no Supabase."
            ),
        ) from e

    items: list[dict[str, Any]] = list(resp.data or [])
    totais = [float(i.get("total_ms") or 0) for i in items if i.get("total_ms") is not None]
    resumo = {
        "amostras": len(items),
        "media_ms": round(sum(totais) / len(totais), 1) if totais else None,
        "p95_ms": None,
        "max_ms": max(totais) if totais else None,
    }
    if totais:
        ordenados = sorted(totais)
        idx = min(len(ordenados) - 1, max(0, int(round(0.95 * (len(ordenados) - 1)))))
        resumo["p95_ms"] = round(ordenados[idx], 1)

    soma_etapa: dict[str, float] = {}
    cont_etapa: dict[str, int] = {}
    for item in items:
        for nome, ms in _iter_etapas(item.get("etapas")):
            soma_etapa[nome] = soma_etapa.get(nome, 0.0) + ms
            cont_etapa[nome] = cont_etapa.get(nome, 0) + 1
    medias_etapa = [
        {
            "etapa": nome,
            "media_ms": round(soma_etapa[nome] / cont_etapa[nome], 1),
            "n": cont_etapa[nome],
        }
        for nome in sorted(soma_etapa.keys(), key=lambda k: -soma_etapa[k] / cont_etapa[k])
    ]

    return {"items": items, "resumo": resumo, "medias_etapa": medias_etapa}
