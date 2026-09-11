"""Persistência de status da Baixa Manual (override sobre o ETL)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .supabase_client import get_client, executar_com_retry


MAPA_TTL_SEGUNDOS = 60
_mapa_cache: dict[str, Any] = {"dados": None, "ts": 0.0}


def _invalidar_mapa_cache() -> None:
    _mapa_cache["dados"] = None
    _mapa_cache["ts"] = 0.0


def _norm_id(order_id: Any) -> str:
    oid = str(order_id or "").strip()
    if oid.endswith(".0") and oid[:-2].lstrip("-").isdigit():
        oid = oid[:-2]
    return oid


def salvar_status_manual(
    order_id: str,
    status_any: str,
    usuario: str,
    observacao: str = "",
) -> None:
    oid = _norm_id(order_id)
    status = str(status_any or "").strip()
    if not oid or not status:
        raise ValueError("order_id e status_any são obrigatórios.")

    payload = {
        "id_any": oid,
        "status_any": status,
        "usuario": (usuario or "").strip() or None,
        "observacao": (observacao or "").strip() or None,
        "atualizado_em": datetime.now(timezone.utc).isoformat(),
    }
    client = get_client()
    executar_com_retry(
        lambda: client.table("pedidos_status_manual")
        .upsert(payload, on_conflict="id_any")
        .execute()
    )
    _invalidar_mapa_cache()


def ler_status_manual(order_id: str) -> str | None:
    oid = _norm_id(order_id)
    if not oid:
        return None
    client = get_client()
    try:
        resp = executar_com_retry(
            lambda: client.table("pedidos_status_manual")
            .select("status_any")
            .eq("id_any", oid)
            .limit(1)
            .execute()
        )
    except Exception:
        return None
    if not resp.data:
        return None
    return str(resp.data[0].get("status_any") or "").strip() or None


def mapa_status_manual() -> dict[str, str]:
    """id_any (str) → status_any. Só carrega registros dos últimos 60 dias.

    Resultado fica em cache por MAPA_TTL_SEGUNDOS para que refreshes forçados
    seguidos não repuxem as 5000 linhas a cada clique (egress).
    """
    import time

    agora = time.time()
    if (
        _mapa_cache["dados"] is not None
        and (agora - _mapa_cache["ts"]) <= MAPA_TTL_SEGUNDOS
    ):
        return dict(_mapa_cache["dados"])

    from datetime import datetime, timezone, timedelta
    client = get_client()
    since = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
    try:
        resp = executar_com_retry(
            lambda: client.table("pedidos_status_manual")
            .select("id_any,status_any")
            .gte("atualizado_em", since)
            .limit(5000)
            .execute()
        )
    except Exception:
        return {}
    out: dict[str, str] = {}
    for row in resp.data or []:
        oid = _norm_id(row.get("id_any"))
        st = str(row.get("status_any") or "").strip()
        if oid and st:
            out[oid] = st
    _mapa_cache["dados"] = out
    _mapa_cache["ts"] = agora
    return dict(out)
