"""Fila de erros de conferência / etiqueta / impressão (não-Sheets).

Usa a tabela `logs`: um pedido fica pendente enquanto o último evento relevante
for um erro e não houver resolução posterior (FINALIZACAO_OK / resolvido manual).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .supabase_client import get_client, log_evento, executar_com_retry
from .supabase_pedidos import linhas_pedido_snake

TIPOS_ERRO = frozenset(
    {
        "ERRO_ETIQUETA",
        "ERRO_CONFERENCIA",
        "ERRO_NF_PEDIDO",
        "ERRO_IMPRESSAO",
        "ERRO_ANYMARKET",
        "ERRO_FINALIZACAO",
        "FINALIZACAO_PENDENTE",
        "FINALIZACAO_AVISO_IMPRESSAO",
    }
)

TIPOS_RESOLUCAO = frozenset(
    {
        "FINALIZACAO_OK",
        "FINALIZACAO_AGENDADO",
        "FINALIZACAO_ERRO_RESOLVIDO",
    }
)

_TIPOS_CONSULTA = tuple(sorted(TIPOS_ERRO | TIPOS_RESOLUCAO))

_LABEL_TIPO = {
    "ERRO_ETIQUETA": "Etiqueta/DANFE",
    "ERRO_CONFERENCIA": "Conferência AnyMarket",
    "ERRO_NF_PEDIDO": "NF Pedido ausente",
    "ERRO_IMPRESSAO": "Impressão",
    "ERRO_ANYMARKET": "AnyMarket",
    "ERRO_FINALIZACAO": "Finalização",
    "FINALIZACAO_PENDENTE": "Finalização incompleta",
    "FINALIZACAO_AVISO_IMPRESSAO": "Aviso de impressão",
}


def _enrich_pedido(order_id: str) -> dict:
    rows = linhas_pedido_snake(order_id)
    return dict(rows[0]) if rows else {}


def _parse_ts(valor) -> datetime:
    if isinstance(valor, datetime):
        return valor if valor.tzinfo else valor.replace(tzinfo=timezone.utc)
    texto = str(valor or "").strip()
    if not texto:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        if texto.endswith("Z"):
            texto = texto[:-1] + "+00:00"
        dt = datetime.fromisoformat(texto)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return datetime.min.replace(tzinfo=timezone.utc)


def listar_erros_finalizacao_pendentes(*, limite: int = 80, dias: int = 14) -> dict:
    client = get_client()
    desde = (datetime.now(timezone.utc) - timedelta(days=max(1, dias))).isoformat()
    resp = executar_com_retry(
        lambda: (
            client.table("logs")
            .select("created_at,usuario,tipo_acao,detalhes,pedido_id")
            .in_("tipo_acao", list(_TIPOS_CONSULTA))
            .gte("created_at", desde)
            .order("created_at", desc=True)
            .limit(800)
            .execute()
        )
    )
    rows = list(resp.data or [])

    # Por pedido: guarda o evento mais recente (já vem desc).
    por_pedido: dict[str, dict] = {}
    for row in rows:
        oid = str(row.get("pedido_id") or "").strip()
        if not oid or oid in por_pedido:
            continue
        tipo = str(row.get("tipo_acao") or "").strip()
        if tipo in TIPOS_RESOLUCAO:
            # Último evento é resolução → não pendente
            por_pedido[oid] = {"resolvido": True}
            continue
        if tipo not in TIPOS_ERRO:
            continue
        por_pedido[oid] = {
            "resolvido": False,
            "order_id": oid,
            "tipo": tipo,
            "erro": row.get("detalhes") or _LABEL_TIPO.get(tipo, tipo),
            "categoria": _LABEL_TIPO.get(tipo, tipo),
            "usuario": row.get("usuario"),
            "created_at": row.get("created_at"),
        }

    pendentes = [v for v in por_pedido.values() if not v.get("resolvido")]
    pendentes.sort(key=lambda x: _parse_ts(x.get("created_at")), reverse=True)
    pendentes = pendentes[: max(1, min(limite, 200))]

    cache: dict[str, dict] = {}
    items: list[dict] = []
    for p in pendentes:
        oid = p["order_id"]
        if oid not in cache:
            cache[oid] = _enrich_pedido(oid)
        ped = cache.get(oid) or {}
        items.append(
            {
                "order_id": oid,
                "tipo": p.get("tipo"),
                "categoria": p.get("categoria"),
                "erro": p.get("erro"),
                "usuario": p.get("usuario"),
                "created_at": p.get("created_at"),
                "pedido": ped.get("pedido"),
                "pedido_any": ped.get("pedido_any"),
                "cliente": ped.get("cliente"),
                "mkp": ped.get("mkp"),
                "status_any": ped.get("status_any"),
                "data_coleta": ped.get("data_coleta"),
            }
        )
    return {"items": items, "total": len(items)}


def contar_erros_finalizacao_pendentes(*, dias: int = 14) -> int:
    """Mesmo critério de listar_erros_finalizacao_pendentes, sem enrich BQ."""
    client = get_client()
    desde = (datetime.now(timezone.utc) - timedelta(days=max(1, dias))).isoformat()
    resp = executar_com_retry(
        lambda: (
            client.table("logs")
            .select("tipo_acao,pedido_id")
            .in_("tipo_acao", list(_TIPOS_CONSULTA))
            .gte("created_at", desde)
            .order("created_at", desc=True)
            .limit(800)
            .execute()
        )
    )
    por_pedido: dict[str, bool] = {}
    for row in resp.data or []:
        oid = str(row.get("pedido_id") or "").strip()
        if not oid or oid in por_pedido:
            continue
        tipo = str(row.get("tipo_acao") or "").strip()
        if tipo in TIPOS_RESOLUCAO:
            por_pedido[oid] = False
        elif tipo in TIPOS_ERRO:
            por_pedido[oid] = True
    return sum(1 for pendente in por_pedido.values() if pendente)


def resolver_erro_finalizacao(order_id: str, usuario: str) -> dict:
    oid = str(order_id or "").strip()
    if not oid:
        raise ValueError("order_id é obrigatório.")
    log_evento(
        usuario,
        "FINALIZACAO_ERRO_RESOLVIDO",
        "Erro de conferência/etiqueta marcado como resolvido na fila.",
        oid,
    )
    return {"ok": True}
