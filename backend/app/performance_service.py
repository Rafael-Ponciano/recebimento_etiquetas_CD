from __future__ import annotations

from .supabase_client import get_client


def _payload_etapas(tempos: dict) -> list | dict:
    """Prefere lista ordenada (com acumulado); cai no dict antigo se não houver."""
    lista = tempos.get("etapas_lista")
    if isinstance(lista, list) and lista:
        return lista
    return tempos.get("etapas_ms") or {}


def registrar_tempos_conferencia(
    order_id: str,
    usuario: str,
    tempos: dict | None,
    *,
    pedido_concluido: bool = False,
    status_pedido: str | None = None,
) -> None:

    if not tempos:
        return
    try:
        etapas = _payload_etapas(tempos)
        total = tempos.get("total_ms")
        if total is None:
            if isinstance(etapas, list) and etapas:
                total = etapas[-1].get("acumulado_ms")
                if total is None:
                    total = round(sum(float(i.get("ms") or 0) for i in etapas), 1)
            elif isinstance(etapas, dict) and etapas:
                total = round(sum(float(v) for v in etapas.values()), 1)
        get_client().rpc(
            "registrar_conferencia_performance",
            {
                "p_order_id": str(order_id),
                "p_usuario": usuario,
                "p_total_ms": total,
                "p_etapas": etapas,
                "p_texto": tempos.get("texto"),
                "p_pedido_concluido": bool(pedido_concluido),
                "p_status_pedido": status_pedido,
            },
        ).execute()
    except Exception as e:
        print(f"[performance] Falha ao gravar tempos do pedido {order_id}: {e}")


def atualizar_tempo_cliente(order_id: str, total_ms: float, usuario: str | None = None) -> bool:
    """Atualiza o total da última amostra do pedido com o tempo sentido no cliente."""
    try:
        client = get_client()
        q = (
            client.table("conferencia_performance")
            .select("id")
            .eq("order_id", str(order_id))
            .order("created_at", desc=True)
            .limit(1)
        )
        if usuario:
            q = q.eq("usuario", usuario)
        resp = q.execute()
        rows = resp.data or []
        if not rows:
            return False
        row_id = rows[0]["id"]
        client.table("conferencia_performance").update(
            {"total_ms": round(float(total_ms), 1)}
        ).eq("id", row_id).execute()
        return True
    except Exception as e:
        print(f"[performance] Falha ao atualizar tempo cliente {order_id}: {e}")
        return False
