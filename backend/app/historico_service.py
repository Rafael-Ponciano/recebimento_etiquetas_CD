from __future__ import annotations

import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from typing import Any

from fastapi import HTTPException

from .config import settings
from .supabase_client import executar_com_retry, get_client
from .supabase_pedidos import (
    linhas_pedido_snake,
    pedidos_por_data_pedido_snake,
    pedidos_por_ids_snake,
)
from .timeutil import bounds_periodo_br, hoje_br

PAGE = 1000

def _status_historico() -> list[str]:

    visto: set[str] = set()
    out: list[str] = []
    for s in (
        settings.status_coleta_hoje,
        settings.status_agendado,
        settings.status_parcial,
        settings.sheets_status_feito,
        "Conferido",
        "Recebido",
        "FEITO",
        "Recebido Parcial",
        "AG AJUSTE",
        "Entregue",
        "Enviado",
    ):
        if s and s not in visto:
            visto.add(s)
            out.append(s)
    return out

LOGS_IGNORAR_TIMELINE = {
    "LOGIN_SUCCESS",
    "LOGIN_FAILED",
    "LOGOUT",
    "PERFIL_ATUALIZADO",
    "SENHA_ALTERADA",
    "CONFERENCIA_ENVIADA",
    "CONFERENCIA_ITENS",
    "CONFERENCIA_JA_FEITA",
    "CONFERENCIA_TIMING",
}

_RE_ERROR_IMPRESSAO = (
    "erro na impressão",
    "exceção ao imprimir",
    "erro código",
    "ghostscript",
    "arquivo não encontrado para impressão",
)

TITULOS_LOG_TIMELINE: dict[str, tuple[str, str | None]] = {
    "FINALIZACAO_OK": ("Pedido finalizado", "Recebimento concluído."),
    "FINALIZACAO_CORRIGIDA": (
        "Pedido corrigido",
        "Pendência de impressão resolvida — status Conferido.",
    ),
    "FINALIZACAO_AVISO_IMPRESSAO": (
        "Pedido conferido — falha na impressão",
        "Conferência ok; reimprimir etiqueta/DANFE.",
    ),
    "FINALIZACAO_PENDENTE": (
        "Finalização incompleta",
        "Recebimento ok; status do pedido não foi alterado para Conferido.",
    ),
    "FINALIZACAO_AGENDADO": (
        "Recebimento concluído",
        "Coleta agendada — AnyMarket e etiqueta ficam para a data da coleta.",
    ),
    "FINALIZACAO_AG_AJUSTE": ("Pedido em AG AJUSTE", None),
    "ERRO_SHEETS": ("Falha na planilha (Check B2C)", None),
    "SHEETS_OK": ("Planilha Check B2C atualizada", None),
    "SHEETS_ERRO_RESOLVIDO": ("Erro Sheets marcado como resolvido", None),
    "FINALIZACAO_ERRO_RESOLVIDO": ("Erro de finalização marcado como resolvido", None),
    "ERRO_FINALIZACAO": ("Falha na finalização", None),
    "ERRO_RECEBIMENTO": ("Falha no recebimento", None),
    "ERRO_CONFERENCIA": ("Falha na conferência AnyMarket", None),
    "ERRO_NF_PEDIDO": (
        "NF Pedido ausente",
        "Emita a NF e conclua a finalização.",
    ),
    "ERRO_ETIQUETA": ("Falha ao baixar etiqueta/DANFE", None),
    "ERRO_IMPRESSAO": ("Falha na impressão", None),
    "ERRO_STATUS": ("Falha ao salvar status", None),
    "ERRO_CONTROLE_FINALIZACAO": ("Falha no controle de finalização", None),
    "IMPRESSAO": ("Etiqueta/DANFE enviada à impressora", None),
    "IMPRESSAO_BLOQUEADA": ("Impressão bloqueada", None),
    "CONFERENCIA_DESMARCADA": ("Conferência desmarcada", None),
    "BAIXA_MANUAL": ("Baixa manual de status", None),
    "ERRO_BAIXA_MANUAL": ("Falha na baixa manual", None),
    "ERROR": ("Erro", None),
}

def _paginar(builder_factory, page_size: int = PAGE) -> list[dict]:
    linhas: list[dict] = []
    inicio = 0
    while True:
        def _lote(inicio=inicio):
            return builder_factory().range(inicio, inicio + page_size - 1).execute()

        resp = executar_com_retry(_lote, tentativas=3, espera_base=0.4)
        lote = resp.data or []
        linhas.extend(lote)
        if len(lote) < page_size:
            break
        inicio += page_size
    return linhas

def _texto(valor: Any) -> str:
    if valor is None:
        return ""
    texto = str(valor).strip()
    if texto.lower() in {"nan", "none", "null"}:
        return ""
    if texto.endswith(".0") and texto.replace(".", "", 1).isdigit():
        return texto[:-2]
    return texto

def _iso(valor: Any) -> str | None:
    if valor is None or valor == "":
        return None
    if isinstance(valor, datetime):
        return valor.isoformat()
    return str(valor)

def _agrupar_pedidos(linhas: list[dict]) -> dict[str, dict]:
    agrupados: dict[str, dict] = {}
    for row in linhas:
        order_id = _texto(row.get("id_any"))
        if not order_id:
            continue
        atual = agrupados.get(order_id)
        item = _texto(row.get("item"))
        if not atual:
            agrupados[order_id] = {
                "id_any": order_id,
                "pedido": _texto(row.get("pedido")) or None,
                "pedido_any": _texto(row.get("pedido_any")) or None,
                "cliente": _texto(row.get("cliente")) or None,
                "mkp": _texto(row.get("mkp")) or None,
                "status_any": _texto(row.get("status_any")) or None,
                "data_pedido": _iso(row.get("data_pedido")),
                "data_coleta": _iso(row.get("data_coleta")),
                "itens": [item] if item else [],
                "qtnd_total": int(row.get("qtnd") or 0),
            }
            continue
        if item and item not in atual["itens"]:
            atual["itens"].append(item)
        atual["qtnd_total"] += int(row.get("qtnd") or 0)

        if row.get("status_any") in ("Conferido", "Recebido", "FEITO"):
            atual["status_any"] = row.get("status_any")
    return agrupados

def _carregar_recebimentos(order_ids: list[str]) -> list[dict]:
    if not order_ids:
        return []
    client = get_client()
    eventos: list[dict] = []

    for i in range(0, len(order_ids), 200):
        lote = order_ids[i : i + 200]

        def factory(ids=lote):
            return (
                client.table("conferencia_recebimentos")
                .select(
                    "order_id,quantidade,operador,recebido_em,line_key,sku,seller,"
                    "quantidade_acumulada,quantidade_total"
                )
                .in_("order_id", ids)
                .order("recebido_em", desc=False)
            )

        eventos.extend(_paginar(factory))
    return eventos

def _carregar_recebimentos_periodo(
    data_ini: date,
    data_fim: date,
    usuario: str | None = None,
) -> list[dict]:

    client = get_client()
    ini, fim = bounds_periodo_br(data_ini, data_fim)
    usuario_termo = (usuario or "").strip()

    def factory():
        q = (
            client.table("conferencia_recebimentos")
            .select(
                "order_id,quantidade,operador,recebido_em,line_key,sku,seller,"
                "quantidade_acumulada,quantidade_total"
            )
            .gte("recebido_em", ini)
            .lte("recebido_em", fim)
            .order("recebido_em", desc=False)
        )
        if usuario_termo:
            q = q.ilike("operador", f"%{usuario_termo}%")
        return q

    return _paginar(factory)

def _carregar_pedidos_por_ids(order_ids: list[str]) -> list[dict]:
    return pedidos_por_ids_snake(order_ids)

def _carregar_pedidos_por_data_pedido(data_ini: date, data_fim: date) -> list[dict]:
    return pedidos_por_data_pedido_snake(
        data_ini, data_fim, status_any_in=_status_historico()
    )

def _carregar_itens_conferencia(order_id: str) -> list[dict]:
    client = get_client()
    resp = (
        client.table("conferencia_itens")
        .select("*")
        .eq("order_id", str(order_id))
        .execute()
    )
    return resp.data or []

def _carregar_logs_pedido(order_id: str) -> list[dict]:
    client = get_client()
    resp = (
        client.table("logs")
        .select("created_at,usuario,tipo_acao,detalhes,pedido_id")
        .eq("pedido_id", str(order_id))
        .order("created_at", desc=False)
        .limit(500)
        .execute()
    )
    return resp.data or []

def _tags_historico_por_ids(
    order_ids: list[str], status_por_id: dict[str, str]
) -> dict[str, str | None]:

    if not order_ids:
        return {}
    client = get_client()
    teve_pendencia: set[str] = set()
    teve_aviso_imp: set[str] = set()
    foi_corr: set[str] = set()
    for i in range(0, len(order_ids), 150):
        lote = [str(x) for x in order_ids[i : i + 150]]
        try:
            resp = (
                client.table("logs")
                .select("pedido_id,tipo_acao,detalhes")
                .in_("pedido_id", lote)
                .in_(
                    "tipo_acao",
                    [
                        "FINALIZACAO_AG_AJUSTE",
                        "FINALIZACAO_PENDENTE",
                        "FINALIZACAO_AVISO_IMPRESSAO",
                        "FINALIZACAO_CORRIGIDA",
                        "FINALIZACAO_OK",
                        "ERRO_IMPRESSAO",
                    ],
                )
                .limit(3000)
                .execute()
            )
        except Exception:
            continue
        for row in resp.data or []:
            oid = _texto(row.get("pedido_id"))
            tipo = _texto(row.get("tipo_acao"))
            det = _texto(row.get("detalhes")).casefold()
            if not oid:
                continue
            if tipo in {"FINALIZACAO_AG_AJUSTE", "FINALIZACAO_PENDENTE"}:
                teve_pendencia.add(oid)
            if tipo in {"FINALIZACAO_AVISO_IMPRESSAO", "ERRO_IMPRESSAO"}:
                teve_aviso_imp.add(oid)
            if tipo == "FINALIZACAO_CORRIGIDA" or (
                tipo == "FINALIZACAO_OK" and "reimpressão ok" in det
            ):
                foi_corr.add(oid)

    out: dict[str, str | None] = {}
    for oid in order_ids:
        st = (status_por_id.get(oid) or "").casefold()
        if oid in foi_corr:
            out[oid] = "corrigido"
        elif st == "ag ajuste" or oid in teve_pendencia:
            out[oid] = "erro"
        elif oid in teve_aviso_imp and st in {"conferido", "recebido", "feito"}:

            out[oid] = "erro"
        else:
            out[oid] = None
    return out

def _resumo_recebimentos(eventos: list[dict]) -> dict[str, Any]:
    operadores = _operadores_unicos(eventos)
    usuario_finalizou = _usuario_ultima_peca(eventos)
    ultimo = None
    for e in eventos:
        ts = e.get("recebido_em")
        if ts and (ultimo is None or str(ts) > str(ultimo)):
            ultimo = ts
    return {
        "operadores": operadores,
        "usuario_finalizou": usuario_finalizou,
        "ultimo_recebimento": _iso(ultimo),
        "qtd_recebimentos": len(eventos),
    }


def _base_pedido_vazio(order_id: str) -> dict[str, Any]:
    return {
        "id_any": order_id,
        "pedido": None,
        "pedido_any": None,
        "cliente": None,
        "mkp": None,
        "status_any": None,
        "data_pedido": None,
        "data_coleta": None,
        "itens": [],
        "qtnd_total": 0,
    }


def _montar_item_historico(order_id: str, base: dict, eventos: list[dict]) -> dict:
    resumo = _resumo_recebimentos(eventos)
    return {
        **base,
        **resumo,
        "ultimo_recebimento": resumo["ultimo_recebimento"] or base.get("data_pedido"),
        "itens_resumo": ", ".join(base["itens"][:3])
        + ("…" if len(base["itens"]) > 3 else ""),
        "qtd_itens": len(base["itens"]),
        "tag": None,
    }


def listar_historico(
    data_ini: date | None = None,
    data_fim: date | None = None,
    usuario: str | None = None,
    pedido: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:

    if data_ini is None:
        data_ini = hoje_br()
    if data_fim is None:
        data_fim = hoje_br()
    if offset < 0:
        offset = 0

    recebimentos = _carregar_recebimentos_periodo(data_ini, data_fim, usuario)
    por_pedido: dict[str, list[dict]] = defaultdict(list)
    for ev in recebimentos:
        oid = _texto(ev.get("order_id"))
        if oid:
            por_pedido[oid].append(ev)

    ids_candidatos: set[str] = set(por_pedido.keys())
    termo_pedido = (pedido or "").strip()

    # Sem recebimentos no período, mas filtro de pedido: busca no cache BQ
    if termo_pedido and not ids_candidatos:
        for row in _carregar_pedidos_por_data_pedido(data_ini, data_fim):
            oid = _texto(row.get("id_any"))
            blob = " ".join(
                [
                    oid,
                    _texto(row.get("pedido")),
                    _texto(row.get("pedido_any")),
                ]
            ).casefold()
            if termo_pedido.casefold() in blob and oid:
                ids_candidatos.add(oid)

    # Caminho rápido (caso comum): sem filtro de pedido → pagina antes de enriquecer
    if not termo_pedido:
        resumos: list[tuple[str, dict]] = []
        for order_id, eventos in por_pedido.items():
            if not eventos:
                continue
            r = _resumo_recebimentos(eventos)
            resumos.append((order_id, r))
        resumos.sort(
            key=lambda t: t[1].get("ultimo_recebimento") or "",
            reverse=True,
        )
        total = len(resumos)
        if limit == 0:
            pagina = resumos
        else:
            pagina = resumos[offset : offset + limit]
        ids_pagina = [oid for oid, _ in pagina]
        agrupados = _agrupar_pedidos(_carregar_pedidos_por_ids(ids_pagina))
        items: list[dict] = []
        for order_id, resumo in pagina:
            base = agrupados.get(order_id) or _base_pedido_vazio(order_id)
            items.append(
                {
                    **base,
                    **resumo,
                    "ultimo_recebimento": resumo["ultimo_recebimento"]
                    or base.get("data_pedido"),
                    "itens_resumo": ", ".join(base["itens"][:3])
                    + ("…" if len(base["itens"]) > 3 else ""),
                    "qtd_itens": len(base["itens"]),
                    "tag": None,
                }
            )
        return {"total": total, "items": items}

    # Com filtro de pedido: precisa enriquecer candidatos para casar pedido/pedido_any
    linhas = _carregar_pedidos_por_ids(sorted(ids_candidatos))
    agrupados = _agrupar_pedidos(linhas)
    for oid in ids_candidatos:
        if oid not in agrupados:
            agrupados[oid] = _base_pedido_vazio(oid)

    termo = termo_pedido.casefold()
    agrupados = {
        oid: base
        for oid, base in agrupados.items()
        if termo
        in " ".join(
            [
                _texto(base.get("id_any")),
                _texto(base.get("pedido")),
                _texto(base.get("pedido_any")),
            ]
        ).casefold()
    }

    items = []
    for order_id, base in agrupados.items():
        eventos = por_pedido.get(order_id, [])
        if not eventos and order_id not in ids_candidatos:
            continue
        items.append(_montar_item_historico(order_id, base, eventos))

    items.sort(
        key=lambda r: r.get("ultimo_recebimento") or r.get("data_pedido") or "",
        reverse=True,
    )
    total = len(items)
    if limit == 0:
        pagina_items = items
    else:
        pagina_items = items[offset : offset + limit]
    return {"total": total, "items": pagina_items}

def _seller_fraco(seller: str) -> bool:
    chave = _texto(seller).casefold()
    return chave in {
        "",
        "aguardando vendedor",
        "padrão",
        "padrao",
        "nan",
        "none",
        "null",
    }

def _parece_sku_hash(sku: str) -> bool:
    texto = _texto(sku)
    if len(texto) < 10:
        return False
    # SKU interno Any (ex.: 8784e002b8dd014)
    return bool(re.fullmatch(r"[0-9a-f]{10,}", texto.casefold()))

def _linhas_nomes_de_rows(rows: list[dict]) -> list[dict]:
    linhas: list[dict] = []
    vistos: set[str] = set()
    for row in rows:
        nome = _texto(row.get("item"))
        if not nome:
            continue
        chave_nome = nome.casefold()
        if chave_nome in vistos:
            continue
        vistos.add(chave_nome)
        linhas.append(
            {
                "nome": nome,
                "ean": _texto(row.get("ean")).casefold(),
                "seller": _texto(row.get("filial_seller")),
            }
        )
    return linhas


def _linhas_nomes_pedido(order_id: str, rows: list[dict] | None = None) -> list[dict]:
    return _linhas_nomes_de_rows(rows if rows is not None else linhas_pedido_snake(order_id))

def _mapa_nomes_por_pedido(order_id: str) -> dict[str, str]:
    """Compat: mapa simples ean/seller → nome (usado se necessário)."""
    mapa: dict[str, str] = {}
    for row in _linhas_nomes_pedido(order_id):
        nome = row["nome"]
        if row["ean"]:
            mapa[row["ean"]] = nome
        seller = _texto(row["seller"]).casefold()
        if seller and not _seller_fraco(seller):
            mapa[f"seller:{seller}"] = nome
        mapa[nome.casefold()] = nome
    return mapa

def _seller_bate(a: str, b: str) -> bool:
    na = _texto(a).casefold()
    nb = _texto(b).casefold()
    if _seller_fraco(na) and _seller_fraco(nb):
        return True
    return bool(na and nb and na == nb)

def _resolver_nomes_recebimentos(
    recebimentos: list[dict], linhas_pedido: list[dict]
) -> list[str]:
    """Resolve o nome amigável de cada recebimento (evita mostrar hash da Any)."""
    n = len(recebimentos)
    nomes: list[str | None] = [None] * n
    usados: set[int] = set()

    # 1) EAN == SKU
    for i, ev in enumerate(recebimentos):
        sku = _texto(ev.get("sku")).casefold()
        if not sku:
            continue
        for j, row in enumerate(linhas_pedido):
            if j in usados:
                continue
            if row["ean"] and row["ean"] == sku:
                nomes[i] = row["nome"]
                usados.add(j)
                break

    # 2) Seller único (exato)
    for i, ev in enumerate(recebimentos):
        if nomes[i]:
            continue
        seller = _texto(ev.get("seller"))
        if _seller_fraco(seller):
            continue
        hits = [
            j
            for j, row in enumerate(linhas_pedido)
            if j not in usados and _seller_bate(row["seller"], seller)
        ]
        if len(hits) == 1:
            nomes[i] = linhas_pedido[hits[0]]["nome"]
            usados.add(hits[0])

    # 3) Seller fraco (Aguardando Vendedor) × linhas com seller fraco / sobra única
    for i, ev in enumerate(recebimentos):
        if nomes[i]:
            continue
        seller = _texto(ev.get("seller"))
        if not _seller_fraco(seller):
            continue
        hits = [
            j
            for j, row in enumerate(linhas_pedido)
            if j not in usados and _seller_fraco(row["seller"])
        ]
        if len(hits) == 1:
            nomes[i] = linhas_pedido[hits[0]]["nome"]
            usados.add(hits[0])

    # 4) Eliminação: sobrou 1 linha para 1 evento
    for i, ev in enumerate(recebimentos):
        if nomes[i]:
            continue
        rest = [j for j in range(len(linhas_pedido)) if j not in usados]
        if len(rest) == 1:
            nomes[i] = linhas_pedido[rest[0]]["nome"]
            usados.add(rest[0])
        elif len(linhas_pedido) == 1:
            nomes[i] = linhas_pedido[0]["nome"]

    # 5) Fallback final — nunca preferir hash ilegível
    out: list[str] = []
    for i, ev in enumerate(recebimentos):
        if nomes[i]:
            out.append(nomes[i])
            continue
        sku = _texto(ev.get("sku"))
        if sku and not _parece_sku_hash(sku):
            out.append(sku)
        elif linhas_pedido:
            # melhor um nome real do pedido do que o hash
            sobra = [linhas_pedido[j]["nome"] for j in range(len(linhas_pedido)) if j not in usados]
            out.append(sobra[0] if len(sobra) == 1 else "Item")
        else:
            out.append("Item")
    return out

def _nome_item_timeline(sku: str, seller: str, mapa: dict[str, str], itens: list[str]) -> str:
    sku_n = _texto(sku).casefold()
    if sku_n and sku_n in mapa:
        return mapa[sku_n]
    seller_n = _texto(seller).casefold()
    if seller_n and not _seller_fraco(seller_n) and f"seller:{seller_n}" in mapa:
        return mapa[f"seller:{seller_n}"]
    if len(itens) == 1:
        return itens[0]
    for chave, nome in mapa.items():
        if chave.startswith("seller:"):
            continue
        if sku_n and (sku_n in chave or chave in sku_n):
            return nome
    if sku_n and _parece_sku_hash(sku_n):
        return itens[0] if len(itens) == 1 else "Item"
    return _texto(sku) or "Item"

def _operadores_unicos(recebimentos: list[dict]) -> list[str]:
    vistos: set[str] = set()
    out: list[str] = []
    ordenados = sorted(
        recebimentos,
        key=lambda e: str(e.get("recebido_em") or ""),
    )
    for e in ordenados:
        op = _texto(e.get("operador"))
        if not op or op in vistos:
            continue
        vistos.add(op)
        out.append(op)
    return out

def _usuario_ultima_peca(recebimentos: list[dict]) -> str | None:
    if not recebimentos:
        return None
    ultimo = max(
        recebimentos,
        key=lambda e: str(e.get("recebido_em") or ""),
    )
    return _texto(ultimo.get("operador")) or None

def _ordem_evento_timeline(ev: dict) -> tuple:
    em = ev.get("em") or ""
    tipo = _texto(ev.get("tipo"))
    acao = _texto((ev.get("meta") or {}).get("tipo_acao"))
    # Bloco 1 = encerramento: sempre por último, mesmo se o Sheets
    # tiver timestamp um pouco depois (sync após o log de finalização).
    if acao.startswith("FINALIZACAO_") or tipo in {"finalizacao", "encerramento"}:
        bloco = 1
    else:
        bloco = 0
    if tipo in {"item_recebido", "item_completo"}:
        faixa = 20 if tipo == "item_completo" else 10
    elif acao == "CONFERENCIA_DESMARCADA":
        faixa = 5
    elif acao in {"BAIXA_MANUAL", "ERRO_BAIXA_MANUAL"}:
        faixa = 58
    elif acao in {"IMPRESSAO", "IMPRESSAO_BLOQUEADA", "ERRO_IMPRESSAO", "ERRO_ETIQUETA"}:
        faixa = 40
    elif tipo == "planilha" or acao in {"SHEETS_OK", "ERRO_SHEETS", "SHEETS_ERRO_RESOLVIDO"}:
        faixa = 50
    elif acao.startswith("FINALIZACAO_"):
        faixa = 60
    elif acao.startswith("ERRO_"):
        faixa = 45
    else:
        faixa = 30
    return (bloco, em, faixa, _texto(ev.get("titulo")), _texto(ev.get("detalhe")))

def obter_timeline(order_id: str) -> dict[str, Any]:
    order_id = str(order_id).strip()
    resp_data = linhas_pedido_snake(order_id)

    if not resp_data:
        raise HTTPException(status_code=404, detail=f"Pedido {order_id} não encontrado.")

    agrupados = _agrupar_pedidos(resp_data)
    base = agrupados.get(order_id) or next(iter(agrupados.values()), None)
    if not base:
        raise HTTPException(status_code=404, detail=f"Pedido {order_id} não encontrado.")

    with ThreadPoolExecutor(max_workers=3) as pool:
        fut_rec = pool.submit(_carregar_recebimentos, [order_id])
        fut_itens = pool.submit(_carregar_itens_conferencia, order_id)
        fut_logs = pool.submit(_carregar_logs_pedido, order_id)
        recebimentos = fut_rec.result()
        itens = fut_itens.result()
        logs = fut_logs.result()
    itens_por_key = {_texto(i.get("line_key")): i for i in itens}
    linhas_nomes = _linhas_nomes_de_rows(resp_data)
    nomes_resolvidos = _resolver_nomes_recebimentos(recebimentos, linhas_nomes)
    nomes_pedido = list(base.get("itens") or [])
    tipos_log_vistos = {_texto(log.get("tipo_acao")) for log in logs}
    tem_log_sheets = bool(tipos_log_vistos & {"SHEETS_OK", "ERRO_SHEETS"})

    eventos: list[dict] = []
    ultimo_idx_por_linha: dict[str, int] = {}

    for idx_ev, ev in enumerate(recebimentos):
        sku = _texto(ev.get("sku")) or "?"
        seller = _texto(ev.get("seller"))
        nome_item = nomes_resolvidos[idx_ev] if idx_ev < len(nomes_resolvidos) else (
            nomes_pedido[0] if len(nomes_pedido) == 1 else ("Item" if _parece_sku_hash(sku) else sku)
        )
        qtd = int(ev.get("quantidade") or 0)
        acum = int(ev.get("quantidade_acumulada") or 0)
        total = int(ev.get("quantidade_total") or 0)
        operador = _texto(ev.get("operador")) or "—"
        line_key = _texto(ev.get("line_key"))
        completo = total > 0 and acum >= total
        status_item = (
            settings.sheets_status_feito
            if completo
            else settings.sheets_status_parcial
            if acum > 0
            else "Pendente"
        )
        partes = [f"+{qtd} un.", f"{acum}/{total}", "completo" if completo else "parcial"]
        if seller:
            partes.append(f"seller {seller}")

        eventos.append(
            {
                "em": _iso(ev.get("recebido_em")),
                "tipo": "item_completo" if completo else "item_recebido",
                "titulo": nome_item,
                "detalhe": " · ".join(partes),
                "usuario": operador,
                "meta": {
                    "sku": sku,
                    "nome": nome_item,
                    "seller": seller,
                    "line_key": line_key,
                    "completo": completo,
                },
            }
        )

        if tem_log_sheets:
            continue

        estado = itens_por_key.get(line_key) if line_key else None
        if estado is not None and estado.get("sheet_sync_ok") is not None:
            idx = len(eventos)
            eventos.append(
                {
                    "em": _iso(ev.get("recebido_em")),
                    "tipo": "planilha",
                    "titulo": "Planilha Check B2C atualizada",
                    "detalhe": f"{nome_item} → {status_item}",
                    "usuario": operador,
                    "meta": {
                        "ok": True,
                        "sku": sku,
                        "nome": nome_item,
                        "status": status_item,
                        "line_key": line_key,
                    },
                }
            )
            if line_key:
                ultimo_idx_por_linha[line_key] = idx

    if not tem_log_sheets:
        for line_key, idx in ultimo_idx_por_linha.items():
            estado = itens_por_key.get(line_key)
            if estado is None or bool(estado.get("sheet_sync_ok")):
                continue
            ev = eventos[idx]
            ev["titulo"] = "Falha ao atualizar planilha"
            ev["detalhe"] = _texto(estado.get("sheet_sync_error")) or "Erro desconhecido"
            ev["meta"] = {**(ev.get("meta") or {}), "ok": False, "tag": "erro"}

    pular_ok_se_agendado = "FINALIZACAO_AGENDADO" in tipos_log_vistos

    tem_erro_tipado = any(
        t.startswith("ERRO_") for t in tipos_log_vistos if t
    )

    for log in logs:
        tipo = _texto(log.get("tipo_acao"))
        if not tipo or tipo in LOGS_IGNORAR_TIMELINE:
            continue
        if tipo == "FINALIZACAO_OK" and pular_ok_se_agendado:
            continue

        detalhe_log = _texto(log.get("detalhes"))

        if tipo == "ERROR":
            baixo = detalhe_log.casefold()
            if any(p in baixo for p in _RE_ERROR_IMPRESSAO):
                continue

        titulo_padrao, detalhe_padrao = TITULOS_LOG_TIMELINE.get(tipo, (None, None))
        if tipo in {
            "FINALIZACAO_OK",
            "FINALIZACAO_AGENDADO",
            "FINALIZACAO_CORRIGIDA",
            "FINALIZACAO_AVISO_IMPRESSAO",
            "FINALIZACAO_PENDENTE",
        } and detalhe_padrao:
            detalhe = detalhe_padrao if tipo not in {"FINALIZACAO_CORRIGIDA"} else (
                detalhe_log or detalhe_padrao
            )
            if tipo in {"FINALIZACAO_AVISO_IMPRESSAO", "FINALIZACAO_PENDENTE"} and detalhe_log:
                detalhe = detalhe_log or detalhe_padrao
        elif tipo == "FINALIZACAO_AG_AJUSTE" and tem_erro_tipado:

            if "]: " in detalhe_log or detalhe_log.upper().startswith("ERRO_"):
                detalhe = "Recebimento ok; pendências na finalização (ver falhas abaixo)."
            else:
                detalhe = detalhe_log or detalhe_padrao or ""
        else:
            detalhe = detalhe_log or detalhe_padrao or ""

        eh_erro = (
            tipo.startswith("ERRO_")
            or tipo
            in {
                "FINALIZACAO_AG_AJUSTE",
                "FINALIZACAO_PENDENTE",
                "FINALIZACAO_AVISO_IMPRESSAO",
            }
            or (tipo == "ERROR")
        )
        tipo_ui = "planilha" if tipo in {"SHEETS_OK", "ERRO_SHEETS"} else "sistema"
        usuario_log = _texto(log.get("usuario")) or "—"
        if tipo in {
            "FINALIZACAO_OK",
            "FINALIZACAO_AGENDADO",
            "FINALIZACAO_CORRIGIDA",
        }:
            ultimo_op = _usuario_ultima_peca(recebimentos)
            if ultimo_op:
                usuario_log = ultimo_op
        eventos.append(
            {
                "em": _iso(log.get("created_at")),
                "tipo": tipo_ui,
                "titulo": titulo_padrao or tipo.replace("_", " ").title(),
                "detalhe": detalhe,
                "usuario": usuario_log,
                "meta": {
                    "tipo_acao": tipo,
                    "ok": False if tipo == "ERRO_SHEETS" else (True if tipo == "SHEETS_OK" else None),
                    "tag": "erro" if eh_erro else ("corrigido" if tipo == "FINALIZACAO_CORRIGIDA" else None),
                },
            }
        )

    vistos: set[tuple] = set()
    unicos: list[dict] = []
    for ev in eventos:
        chave = (ev.get("em"), ev.get("tipo"), ev.get("titulo"), ev.get("detalhe"), ev.get("usuario"))
        if chave in vistos:
            continue
        vistos.add(chave)
        unicos.append(ev)

    unicos.sort(key=_ordem_evento_timeline)

    operadores = _operadores_unicos(recebimentos)
    usuario_finalizou = _usuario_ultima_peca(recebimentos)

    status_atual = _texto(base.get("status_any"))
    teve_pendencia = bool(
        tipos_log_vistos
        & {"FINALIZACAO_AG_AJUSTE", "FINALIZACAO_PENDENTE", "FINALIZACAO_AVISO_IMPRESSAO"}
    )
    foi_corrigido = "FINALIZACAO_CORRIGIDA" in tipos_log_vistos

    if not foi_corrigido:
        for log in logs:
            if _texto(log.get("tipo_acao")) == "FINALIZACAO_OK" and "reimpressão ok" in _texto(
                log.get("detalhes")
            ).casefold():
                foi_corrigido = True
                break
    com_erro = (not foi_corrigido) and (
        status_atual.casefold() == "ag ajuste"
        or "FINALIZACAO_PENDENTE" in tipos_log_vistos
        or "FINALIZACAO_AVISO_IMPRESSAO" in tipos_log_vistos
        or (teve_pendencia and status_atual.casefold() not in {"conferido", "recebido", "feito"})
    )

    if (
        not foi_corrigido
        and "FINALIZACAO_AVISO_IMPRESSAO" in tipos_log_vistos
        and status_atual.casefold() in {"conferido", "recebido", "feito"}
    ):
        com_erro = True

    return {
        "pedido": {
            **base,
            "operadores": operadores,
            "usuario_finalizou": usuario_finalizou,
            "ultimo_recebimento": _iso(
                max((e.get("recebido_em") for e in recebimentos), default=None)
            ),
            "tag": "corrigido" if foi_corrigido else ("erro" if com_erro else None),
        },
        "timeline": unicos,
    }
