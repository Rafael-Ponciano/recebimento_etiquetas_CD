from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from .pedidos_service import (
    TARGET_STATUSES,
    STATUS_FORA_FILA,
    _atualizar_status_local,
    _norm_id_any,
    _salvar_status_no_supabase,
    _status_any_local,
    get_pedidos_df,
)
from .supabase_client import log_evento
from .supabase_pedidos import linhas_pedido_snake
from . import status_manual_service

STATUS_BAIXA_MANUAL = tuple(
    dict.fromkeys(
        [
            *TARGET_STATUSES,
            *STATUS_FORA_FILA,
            "Cancelado",
            "A conferir",
            "Em separação",
        ]
    )
)

def _texto(valor: Any) -> str:
    if valor is None:
        return ""
    texto = str(valor).strip()
    if texto.lower() in {"nan", "none", "null"}:
        return ""
    if texto.endswith(".0") and texto.replace(".", "", 1).isdigit():
        return texto[:-2]
    return texto

def listar_status_permitidos() -> list[str]:
    return list(STATUS_BAIXA_MANUAL)

def _buscar_no_cache_local(termo: str) -> list[dict]:
    try:
        df = get_pedidos_df(force_refresh=False)
    except Exception:
        return []
    if df is None or df.empty:
        return []

    termo_cf = termo.casefold()
    cols = [c for c in ("Pedido", "Pedido Any", "Pedido Seller", "Cliente", "id_any") if c in df.columns]
    if not cols:
        return []

    mascara = False
    for col in cols:
        serie = df[col].astype(str).str.strip().str.casefold()
        mascara = mascara | serie.eq(termo_cf) | serie.str.contains(termo_cf, regex=False, na=False)

    if not getattr(mascara, "any", lambda: False)():
        return []

    subset = df.loc[mascara].drop_duplicates(subset=["id_any"], keep="first")
    out: list[dict] = []
    for _, row in subset.head(80).iterrows():
        out.append(
            {
                "id_any": row.get("id_any"),
                "pedido": row.get("Pedido"),
                "pedido_any": row.get("Pedido Any"),
                "pedido_seller": row.get("Pedido Seller"),
                "cliente": row.get("Cliente"),
                "mkp": row.get("Mkp"),
                "status_any": row.get("Status Any"),
                "data_pedido": row.get("Data"),
                "data_coleta": row.get("Data Coleta"),
                "filial_seller": row.get("filial_seller"),
            }
        )
    return out

def buscar_pedidos(termo: str, *, limite: int = 30) -> list[dict]:
    termo = _texto(termo)
    if len(termo) < 2:
        raise HTTPException(status_code=400, detail="Informe ao menos 2 caracteres para buscar.")

    linhas: list[dict] = []
    oid = _norm_id_any(termo)

    if oid.isdigit():
        for row in linhas_pedido_snake(oid):
            linhas.append(
                {
                    "id_any": row.get("id_any"),
                    "pedido": row.get("pedido"),
                    "pedido_any": row.get("pedido_any"),
                    "pedido_seller": row.get("pedido_seller"),
                    "cliente": row.get("cliente"),
                    "mkp": row.get("mkp"),
                    "status_any": row.get("status_any"),
                    "data_pedido": row.get("data_pedido"),
                    "data_coleta": row.get("data_coleta"),
                    "filial_seller": row.get("filial_seller"),
                }
            )

    if not linhas:
        linhas.extend(_buscar_no_cache_local(termo))

    agrupados: dict[str, dict] = {}
    for row in linhas:
        order_id = _norm_id_any(row.get("id_any"))
        if not order_id:
            continue
        if order_id not in agrupados:
            agrupados[order_id] = {
                "id_any": order_id,
                "pedido": _texto(row.get("pedido")) or None,
                "pedido_any": _texto(row.get("pedido_any")) or None,
                "pedido_seller": _texto(row.get("pedido_seller")) or None,
                "cliente": _texto(row.get("cliente")) or None,
                "mkp": _texto(row.get("mkp")) or None,
                "status_any": _texto(row.get("status_any")) or None,
                "data_pedido": row.get("data_pedido"),
                "data_coleta": row.get("data_coleta"),
                "filial_seller": _texto(row.get("filial_seller")) or None,
            }

    items = list(agrupados.values())
    termo_cf = termo.casefold()

    def _relevancia(p: dict) -> int:
        if p["id_any"] == oid:
            return 0
        for chave in ("pedido", "pedido_any", "pedido_seller"):
            valor = (p.get(chave) or "").casefold()
            if valor == termo_cf:
                return 1
            if termo_cf in valor:
                return 2
        if termo_cf in (p.get("cliente") or "").casefold():
            return 3
        return 9

    items.sort(key=lambda p: (_relevancia(p), str(p.get("data_pedido") or "")))
    return items[: max(1, min(limite, 50))]

def _status_no_banco(oid: str) -> str | None:
    mapa = status_manual_service.mapa_status_manual()
    if oid in mapa:
        return mapa[oid]
    linhas = linhas_pedido_snake(oid)
    if linhas:
        return _texto(linhas[0].get("status_any")) or ""
    return None

def aplicar_baixa_manual(
    order_id: str,
    novo_status: str,
    usuario: str,
    observacao: str = "",
) -> dict:
    oid = _norm_id_any(order_id)
    if not oid:
        raise HTTPException(status_code=400, detail="Pedido inválido.")

    status = _texto(novo_status)
    if status not in STATUS_BAIXA_MANUAL:
        raise HTTPException(
            status_code=400,
            detail=f"Status '{status}' não permitido para baixa manual.",
        )

    status_banco = _status_no_banco(oid)
    if status_banco is None:
        raise HTTPException(status_code=404, detail=f"Pedido {oid} não encontrado.")

    status_atual = status_banco or _texto(_status_any_local(oid))

    if status_atual == status:
        return {
            "ok": True,
            "order_id": oid,
            "status_anterior": status_atual,
            "status_novo": status,
            "mensagem": f"Pedido {oid} já estava em '{status}'. Nada alterado.",
            "alterado": False,
        }

    try:
        _salvar_status_no_supabase(
            oid, status, exigir_linha=True, permitir_saida_cancelado=True
        )
    except Exception as e:
        log_evento(
            usuario,
            "ERRO_BAIXA_MANUAL",
            f"Falha ao gravar status {status} no pedido {oid}: {e}",
            oid,
        )
        raise HTTPException(status_code=502, detail=f"Falha ao atualizar status: {e}") from e

    obs = _texto(observacao)
    try:
        status_manual_service.salvar_status_manual(
            oid, status, usuario, observacao=obs
        )
    except Exception as e:
        log_evento(
            usuario,
            "ERRO_BAIXA_MANUAL",
            f"Status gravado em pedidos, mas falhou override manual: {e}",
            oid,
        )
        raise HTTPException(
            status_code=502,
            detail=(
                f"Status atualizado, mas a tabela de baixa manual falhou: {e}. "
                "Rode supabase/baixa_manual_status.sql no Supabase."
            ),
        ) from e

    _atualizar_status_local(oid, status, permitir_saida_cancelado=True)

    detalhe = f"Baixa manual: '{status_atual or '—'}' → '{status}'"
    if obs:
        detalhe = f"{detalhe}. Obs: {obs}"

    log_evento(usuario, "BAIXA_MANUAL", detalhe, oid)

    return {
        "ok": True,
        "order_id": oid,
        "status_anterior": status_atual or None,
        "status_novo": status,
        "mensagem": f"Status do pedido {oid} atualizado: {status_atual or '—'} → {status}.",
        "alterado": True,
    }
