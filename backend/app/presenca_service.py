from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .supabase_client import get_client, executar_com_retry

PRESENCA_TTL_SEGUNDOS = 12

def _norm_operador(valor: str) -> str:
    return (valor or "").strip()

def _ativos(
    linhas: list[dict],
    agora: datetime,
    ttl_segundos: int = PRESENCA_TTL_SEGUNDOS,
) -> list[dict]:
    limite = agora - timedelta(seconds=ttl_segundos)
    ativos: list[dict] = []
    for row in linhas:
        raw = row.get("atualizado_em")
        if not raw:
            continue
        try:
            ts = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts < limite:
            continue
        op = _norm_operador(str(row.get("operador") or ""))
        if not op:
            continue
        nome = _norm_operador(str(row.get("nome") or "")) or op
        ativos.append({"operador": op, "nome": nome, "atualizado_em": ts.isoformat()})
    return ativos

def sincronizar_presenca(
    order_id: str,
    operador: str,
    nome: str | None = None,
    ttl_segundos: int = PRESENCA_TTL_SEGUNDOS,
) -> dict[str, Any]:
    oid = str(order_id or "").strip()
    op = _norm_operador(operador)
    if not oid or not op:
        return {"outros": [], "ativo": False}

    agora = datetime.now(timezone.utc)
    client = get_client()
    display = _norm_operador(nome or "") or op

    try:
        executar_com_retry(
            lambda: client.table("conferencia_presenca")
            .upsert(
                {
                    "order_id": oid,
                    "operador": op,
                    "nome": display,
                    "atualizado_em": agora.isoformat(),
                },
                on_conflict="order_id,operador",
            )
            .execute()
        )
    except Exception:
        return {"outros": [], "ativo": False, "aviso": "presenca_indisponivel"}

    try:
        resp = executar_com_retry(
            lambda: client.table("conferencia_presenca")
            .select("operador,nome,atualizado_em")
            .eq("order_id", oid)
            .execute()
        )
        linhas = resp.data or []
    except Exception:
        return {"outros": [], "ativo": True, "aviso": "presenca_indisponivel"}

    outros = [
        {"operador": a["operador"], "nome": a["nome"]}
        for a in _ativos(linhas, agora, ttl_segundos)
        if a["operador"].casefold() != op.casefold()
    ]
    outros.sort(key=lambda x: x["nome"].casefold())
    return {"outros": outros, "ativo": True}

def sair_presenca(order_id: str, operador: str) -> None:
    oid = str(order_id or "").strip()
    op = _norm_operador(operador)
    if not oid or not op:
        return
    try:
        executar_com_retry(
            lambda: get_client()
            .table("conferencia_presenca")
            .delete()
            .eq("order_id", oid)
            .eq("operador", op)
            .execute()
        )
    except Exception:
        pass
