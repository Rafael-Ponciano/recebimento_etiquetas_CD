from __future__ import annotations

from .supabase_client import get_client, log_evento, executar_com_retry
from .supabase_pedidos import linhas_pedido_snake


def _parse_line_key(line_key: str) -> tuple[str, str, str]:
    partes = str(line_key or "").split("|")
    if len(partes) >= 3:
        return partes[0], partes[1], "|".join(partes[2:])
    if len(partes) == 2:
        return partes[0], partes[1], ""
    return str(line_key or ""), "", ""


def _enrich_pedido(order_id: str) -> dict:
    rows = linhas_pedido_snake(order_id)
    if not rows:
        return {}
    base = dict(rows[0])
    itens = [str(r.get("item") or "").strip() for r in rows if str(r.get("item") or "").strip()]
    if itens:
        base["itens_resumo"] = itens
    return base


def listar_erros_sheets_pendentes(*, limite: int = 80) -> dict:
    client = get_client()
    resp = executar_com_retry(
        lambda: (
            client.table("conferencia_itens")
            .select(
                "order_id,line_key,sheet_sync_ok,sheet_sync_error,"
                "conferido_por,data_conferencia,quantidade_conferida,"
                "quantidade_total,status"
            )
            .eq("sheet_sync_ok", False)
            .not_.is_("sheet_sync_error", "null")
            .order("data_conferencia", desc=True)
            .limit(max(1, min(limite, 200)))
            .execute()
        )
    )
    rows = list(resp.data or [])
    items: list[dict] = []
    cache_pedidos: dict[str, dict] = {}
    for row in rows:
        order_id = str(row.get("order_id") or "")
        line_key = str(row.get("line_key") or "")
        _oid, sku, seller = _parse_line_key(line_key)
        if order_id not in cache_pedidos:
            cache_pedidos[order_id] = _enrich_pedido(order_id)
        ped = cache_pedidos.get(order_id) or {}
        items.append(
            {
                "order_id": order_id,
                "line_key": line_key,
                "sku": sku,
                "seller": seller,
                "erro": row.get("sheet_sync_error") or "Falha ao atualizar o Check B2C.",
                "conferido_por": row.get("conferido_por"),
                "data_conferencia": row.get("data_conferencia"),
                "status_item": row.get("status"),
                "quantidade_conferida": row.get("quantidade_conferida"),
                "quantidade_total": row.get("quantidade_total"),
                "pedido": ped.get("pedido"),
                "pedido_any": ped.get("pedido_any"),
                "cliente": ped.get("cliente"),
                "mkp": ped.get("mkp"),
                "status_any": ped.get("status_any"),
                "data_coleta": ped.get("data_coleta"),
            }
        )
    return {"items": items, "total": len(items)}


def contar_erros_sheets_pendentes() -> int:
    client = get_client()
    try:
        resp = executar_com_retry(
            lambda: (
                client.table("conferencia_itens")
                .select("line_key", count="exact")
                .eq("sheet_sync_ok", False)
                .not_.is_("sheet_sync_error", "null")
                .limit(1)
                .execute()
            )
        )
        if getattr(resp, "count", None) is not None:
            return int(resp.count)
    except Exception:
        pass
    # Fallback sem count exato
    return listar_erros_sheets_pendentes(limite=200)["total"]


def resolver_erro_sheets(order_id: str, line_key: str, usuario: str) -> dict:
    client = get_client()
    oid = str(order_id).strip()
    lk = str(line_key).strip()
    if not oid or not lk:
        raise ValueError("order_id e line_key são obrigatórios.")

    try:
        executar_com_retry(
            lambda: client.rpc(
                "registrar_resultado_sync_sheets",
                {
                    "p_order_id": oid,
                    "p_line_key": lk,
                    "p_ok": True,
                    "p_erro": None,
                },
            ).execute()
        )
    except Exception:
        # Fallback direto na tabela se a RPC falhar
        executar_com_retry(
            lambda: (
                client.table("conferencia_itens")
                .update(
                    {
                        "sheet_sync_ok": True,
                        "sheet_sync_error": None,
                    }
                )
                .eq("order_id", oid)
                .eq("line_key", lk)
                .execute()
            )
        )

    log_evento(
        usuario,
        "SHEETS_ERRO_RESOLVIDO",
        f"Erro Sheets marcado como resolvido ({lk}).",
        oid,
    )
    return {"ok": True}
