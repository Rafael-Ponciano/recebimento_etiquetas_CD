"""Fonte de pedidos: BigQuery (base) + pedidos_status_manual (status operacional)."""

from __future__ import annotations

from typing import Any

import pandas as pd

from . import status_manual_service
from .bigquery_pedidos import ler_pedidos_do_bigquery

_DISPLAY_PARA_SNAKE = {
    "id_any": "id_any",
    "Pedido": "pedido",
    "Pedido Any": "pedido_any",
    "Pedido Seller": "pedido_seller",
    "Data": "data_pedido",
    "Data Coleta": "data_coleta",
    "Cliente": "cliente",
    "CPF": "cpf",
    "NF Venda": "nf_venda",
    "NF Seller": "nf_seller",
    "ean": "ean",
    "Item": "item",
    "QTND": "qtnd",
    "filial_seller": "filial_seller",
    "Mkp": "mkp",
    "Status Any": "status_any",
    "status_nf": "status_nf",
    "status_pedido": "status_pedido",
    "tempo_integracao": "tempo_integracao",
}


def _norm_id(order_id: Any) -> str:
    oid = str(order_id or "").strip()
    if oid.endswith(".0") and oid[:-2].lstrip("-").isdigit():
        oid = oid[:-2]
    return oid


def _aplicar_status_manual(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty or "Status Any" not in df.columns:
        return df
    mapa = status_manual_service.mapa_status_manual()
    if not mapa:
        return df
    out = df.copy()
    for idx, oid in out["id_any"].items():
        st = mapa.get(_norm_id(oid))
        if st:
            out.at[idx, "Status Any"] = st
    return out


def aplicar_status_manual(df: pd.DataFrame) -> pd.DataFrame:
    """Aplica os overrides de pedidos_status_manual sobre um DF já carregado.

    Público de propósito: o cache do BigQuery (15 min, alinhado ao ETL) é
    separado do overlay de status, que é barato e reaplica bem mais rápido.
    """
    return _aplicar_status_manual(df)


def ler_pedidos_do_supabase() -> pd.DataFrame:
    """Nome legado: lê do BigQuery e aplica overrides de status do Supabase."""
    df = ler_pedidos_do_bigquery()
    return _aplicar_status_manual(df)


def atualizar_status_pedido(order_id: str, novo_status: str) -> bool:
    """Persiste status operacional em pedidos_status_manual (leve)."""
    oid = _norm_id(order_id)
    status = str(novo_status or "").strip()
    if not oid or not status:
        return False
    try:
        status_manual_service.salvar_status_manual(
            oid, status, usuario="sistema", observacao="status_app"
        )
        return True
    except Exception as e:
        import logging

        logging.getLogger(__name__).exception(
            "Falha ao salvar status_manual %s → %s: %s", oid, status, e
        )
        return False


def _df_rows_to_snake(subset: pd.DataFrame) -> list[dict]:
    """Converte um subset do DF de pedidos para lista snake_case (uma passagem)."""
    if subset is None or subset.empty:
        return []
    present = [(d, s) for d, s in _DISPLAY_PARA_SNAKE.items() if d in subset.columns]
    out: list[dict] = []
    for _, row in subset.iterrows():
        item: dict[str, Any] = {}
        for display, snake in present:
            val = row.get(display)
            if pd.isna(val):
                item[snake] = None
            else:
                item[snake] = val
        item["id_any"] = _norm_id(item.get("id_any") or row.get("id_any"))
        out.append(item)
    return out


def linhas_pedido_snake(order_id: str) -> list[dict]:
    """Linhas do pedido no formato snake_case (histórico / enrich)."""
    from .pedidos_service import get_pedidos_df

    oid = _norm_id(order_id)
    if not oid:
        return []
    try:
        df = get_pedidos_df(force_refresh=False)
    except Exception:
        return []
    if df is None or df.empty or "id_any" not in df.columns:
        return []

    ids = df["id_any"].astype(str).map(_norm_id)
    return _df_rows_to_snake(df.loc[ids == oid])


def pedidos_por_ids_snake(order_ids: list[str]) -> list[dict]:
    wanted = {_norm_id(x) for x in order_ids if _norm_id(x)}
    if not wanted:
        return []
    from .pedidos_service import get_pedidos_df

    try:
        df = get_pedidos_df(force_refresh=False)
    except Exception:
        return []
    if df is None or df.empty or "id_any" not in df.columns:
        return []
    ids = df["id_any"].astype(str).map(_norm_id)
    return _df_rows_to_snake(df.loc[ids.isin(wanted)])


def pedidos_por_data_pedido_snake(
    data_ini,
    data_fim,
    *,
    status_any_in: list[str] | None = None,
) -> list[dict]:
    from .pedidos_service import get_pedidos_df

    try:
        df = get_pedidos_df(force_refresh=False)
    except Exception:
        return []
    if df is None or df.empty or "Data" not in df.columns:
        return []

    out = df.copy()
    out["_data"] = pd.to_datetime(out["Data"], errors="coerce")
    ini = pd.Timestamp(data_ini)
    fim = pd.Timestamp(data_fim) + pd.Timedelta(days=1) - pd.Timedelta(microseconds=1)
    mascara = (out["_data"] >= ini) & (out["_data"] <= fim)
    if status_any_in:
        st = out.get("Status Any", pd.Series("", index=out.index)).astype(str)
        mascara = mascara & st.isin(status_any_in)
    return _df_rows_to_snake(out.loc[mascara])
