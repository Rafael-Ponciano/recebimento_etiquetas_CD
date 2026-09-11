import json
import os
import re
import threading
import time
import unicodedata
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import pandas as pd
from . import anymarket
from .config import get_external_path, settings
from .google_sheets import atualizar_status_item_planilha
from .supabase_client import log_evento, get_client, executar_com_retry
from . import performance_service
from .supabase_pedidos import (
    aplicar_status_manual,
    atualizar_status_pedido,
    ler_pedidos_do_supabase,
)
from .bigquery_pedidos import ler_pedidos_do_bigquery
from .printing import print_pdf
from .timeutil import hoje_br

_itens_cache: dict[str, dict] = {}
_TZ_BR = ZoneInfo("America/Sao_Paulo")

def _fmt_data_br(valor) -> str | None:
    if valor is None:
        return None
    if isinstance(valor, datetime):
        dt = valor
    else:
        texto = str(valor).strip()
        if not texto:
            return None
        try:
            dt = datetime.fromisoformat(texto.replace("Z", "+00:00"))
        except ValueError:
            return texto
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo("UTC"))
    return dt.astimezone(_TZ_BR).strftime("%d/%m/%Y %H:%M")

class _Cronometro:

    def __init__(self) -> None:
        self._inicio = time.perf_counter()
        self._ultimo = self._inicio
        self._etapas: list[tuple[str, float]] = []

    def marca(self, nome: str) -> float:
        agora = time.perf_counter()
        ms = round((agora - self._ultimo) * 1000, 1)
        self._etapas.append((nome, ms))
        self._ultimo = agora
        return ms

    def resumo(self) -> dict:
        total = round((time.perf_counter() - self._inicio) * 1000, 1)
        lista: list[dict] = []
        acum = 0.0
        for nome, ms in self._etapas:
            acum = round(acum + float(ms), 1)
            lista.append(
                {
                    "etapa": nome,
                    "ms": float(ms),
                    "acumulado_ms": acum,
                }
            )
        # dict só para compat; a fonte da verdade é etapas_lista (ordem + acumulado).
        etapas_dict = {item["etapa"]: item["ms"] for item in lista}
        partes = [f"{item['etapa']} {item['ms']:.0f}ms" for item in lista]
        partes.append(f"total {total:.0f}ms")
        return {
            "etapas_ms": etapas_dict,
            "etapas_lista": lista,
            "total_ms": total,
            "texto": " · ".join(partes),
        }

COLUNAS = [
    "id_any", "Pedido", "Data", "Data Coleta", "Cliente", "CPF", "Status Any",
    "Item", "QTND", "filial_seller", "Pedido Seller", "Pedido Any", "Mkp",
    "NF Venda", "NF Seller", "ean", "status_nf", "status_pedido", "tempo_integracao",
]

TARGET_STATUSES = [
    "Em separação", "Conferido", "Recebido", "A conferir", "FEITO",
    "FALTANDO ITEM", "Recebido Parcial", "AG AJUSTE", "Recebido - Pendência Any",
    "Ag. Coleta",
]
STATUS_CONFERIDO = "Conferido"
STATUS_RECEBIDO = "Recebido"
STATUS_AG_COLETA = "Ag. Coleta"
STATUS_FORA_FILA = frozenset({"Entregue", "Enviado"})
STATUS_LOTE_CONFERIR = frozenset({"em separação", "a conferir"})
SELLER_AGUARDANDO = "Aguardando Vendedor"

def _normalizar_texto_produto(valor) -> str:
    texto = unicodedata.normalize("NFD", str(valor or ""))
    texto = "".join(ch for ch in texto if unicodedata.category(ch) != "Mn")
    return " ".join(texto.casefold().split())

def _classificar_produto_lote(item) -> str:
    n = _normalizar_texto_produto(item)
    if not n:
        return "outro"
    if "vonixx" in n:
        return "vonixx"
    if (
        "wd40" in n
        or "wd-40" in n
        or "wd 40" in n
        or ("desengripante" in n and "wd" in n)
    ):
        return "wd"
    if (
        "702358" in n
        or "702366" in n
        or ("desengraxante" in n and ("h7" in n or "h-7" in n or "h 7" in n))
    ):
        return "h7"
    return "outro"

def _pedido_elegivel_lote_produto(order_id: str) -> tuple[bool, str]:
    linha_df = _linha_df_pedido(order_id)
    if linha_df is None or linha_df.empty:
        return False, "Pedido sem itens locais para validar WD/H7/Vonixx."
    classes: set[str] = set()
    for _, row in linha_df.iterrows():
        classes.add(_classificar_produto_lote(row.get("Item")))
    if classes == {"wd"}:
        return True, "wd"
    if classes == {"h7"}:
        return True, "h7"
    if classes == {"vonixx"}:
        return True, "vonixx"
    if classes == {"wd", "h7"}:
        return True, "wd_h7"
    return (
        False,
        "Conferência em lote só para pedidos exclusivos de WD, H7, Vonixx ou WD+H7 "
        "(sem misturar com outros produtos).",
    )

INVALIDOS_SELLER = {"", "nan", "none", "null", "padrao", "padrão", "aguardando vendedor"}

def _status_coleta_hoje() -> str:
    return settings.status_coleta_hoje

def _status_agendado() -> str:
    return settings.status_agendado

def _status_parcial() -> str:
    return settings.status_parcial

def _status_recebido_pendente() -> str:
    return settings.status_recebido_pendente

def _sheets_feito() -> str:
    return settings.sheets_status_feito

def _sheets_parcial() -> str:
    return settings.sheets_status_parcial

def _status_impressao_livre() -> frozenset[str]:
    base = {"conferido", "recebido", "feito", "ag ajuste", "ag. coleta", "ag. coleta cd"}
    base.add(_status_coleta_hoje().casefold())
    base.add(_status_agendado().casefold())
    base.add(_sheets_feito().casefold())
    if settings.imprimir_em_parcial:
        base.add(_status_parcial().casefold())
        base.add("recebido parcial")
    return frozenset(base)

def _status_pedido_fechado() -> frozenset[str]:
    return frozenset(
        {
            "conferido",
            "recebido",
            "feito",
            "ag ajuste",
            "ag. coleta",
            "ag. coleta cd",
            _status_coleta_hoje().casefold(),
            _status_agendado().casefold(),
            _sheets_feito().casefold(),
        }
    )


def _eh_status_cancelado(status) -> bool:
    """Qualquer status com 'cancel' (Cancelado, cancelado, etc.), como na UI."""
    return "cancel" in str(status or "").casefold()


def _eh_status_imovel(status) -> bool:
    """Fechado no CD ou cancelado — não deve receber conferência/finalização."""
    st = str(status or "").strip().casefold()
    return st in _status_pedido_fechado() or _eh_status_cancelado(status)


MSG_STATUS_CANCELADO_BLOQUEADO = (
    "Pedido cancelado. Não é possível alterar o status. "
    "Use baixa manual (admin) para reabrir."
)


class StatusCanceladoBloqueado(RuntimeError):
    """Tentativa de sair de Cancelado sem baixa manual."""


SHEETS_STATUS_CANCELADO = "CANCELADO"

_cache = {"df": None, "loaded_at": 0.0}
_cache_bq = {"df": None, "loaded_at": 0.0}

def _norm_id_any(valor) -> str:

    texto = str(valor or "").strip()
    if texto.endswith(".0") and texto[:-2].lstrip("-").isdigit():
        return texto[:-2]
    return texto

def _chaves_order_id(order_id) -> list:

    oid = _norm_id_any(order_id)
    vistos: set = set()
    chaves: list = []
    for bruto in (oid, str(order_id or "").strip()):
        if not bruto or bruto in vistos:
            continue
        vistos.add(bruto)
        chaves.append(bruto)
        if str(bruto).isdigit():
            n = int(bruto)
            if n not in vistos:
                vistos.add(n)
                chaves.append(n)
    return chaves

def _mask_pedido(df: pd.DataFrame, order_id: str) -> pd.Series:
    oid = _norm_id_any(order_id)
    return df["id_any"].map(_norm_id_any) == oid

def _proxima_data_util(valor) -> pd.Timestamp:

    ts = pd.to_datetime(valor, errors="coerce")
    if pd.isna(ts):
        return ts
    d = pd.Timestamp(ts).normalize()
    wd = int(d.dayofweek)
    if wd == 5:
        return d + pd.Timedelta(days=2)
    if wd == 6:
        return d + pd.Timedelta(days=1)
    return d

def _hoje_negocio() -> pd.Timestamp:
    """'Hoje' operacional (respeita OFFSET_HORAS_TESTE do config)."""
    return pd.Timestamp(hoje_br())


def _computar_status_cd(df: pd.DataFrame) -> pd.DataFrame:
    hoje = _hoje_negocio()
    coleta_util = df["Data Coleta"].map(_proxima_data_util)

    # Finalização antecipada (coleta ainda no futuro) grava Status Any = STATUS_AGENDADO
    # ("Recebido" no config). No dia da coleta também exibe "Coleta Hoje"
    # (fluxo de Conferir AnyMarket/etiqueta continua pelo Status Any Recebido/FEITO).
    status_any_norm = df["Status Any"].fillna("").astype(str).str.strip()
    era_agendado = status_any_norm.isin(
        {
            STATUS_RECEBIDO,
            _status_agendado(),
            "FEITO",
            _sheets_feito(),
        }
    )

    conditions = [
        era_agendado & (coleta_util == hoje),
        (df["Status Any"].isin(TARGET_STATUSES)) & (coleta_util == hoje),
        (df["Status Any"].isin(TARGET_STATUSES)) & (coleta_util < hoje),
        (df["Status Any"].isin(TARGET_STATUSES)) & (coleta_util > hoje),
    ]
    agendado_label = "Agendado " + coleta_util.dt.strftime("%d/%m")
    status_cd = pd.Series("", index=df.index, dtype=object)
    status_cd = status_cd.mask(conditions[3], agendado_label)
    status_cd = status_cd.mask(conditions[2], "Atrasado")
    status_cd = status_cd.mask(conditions[1], "Coleta Hoje")
    status_cd = status_cd.mask(conditions[0], "Coleta Hoje")
    status_any = status_any_norm.mask(
        status_any_norm.str.casefold().isin({"", "nan", "none", "null"}), ""
    )
    status_cd = status_cd.mask(status_cd.astype(str).str.strip().eq(""), status_any)
    df.insert(0, "Status CD", status_cd)
    return df

def _base_do_bigquery(force_refresh: bool = False) -> pd.DataFrame:
    """Base crua do BigQuery, com cache próprio.

    O ETL popula a tabela a cada 15 min e o SELECT é sem WHERE (BigQuery cobra
    por bytes escaneados), então reler antes disso não traz linha nova — só
    custo. O overlay de status, que muda o tempo todo, tem TTL separado e
    bem menor em _carregar_do_zero().
    """
    agora = time.time()
    stale = (agora - _cache_bq["loaded_at"]) > settings.cache_pedidos_bq_ttl_seconds
    if force_refresh or _cache_bq["df"] is None or stale:
        df = ler_pedidos_do_bigquery()
        for col in COLUNAS:
            if col not in df.columns:
                df[col] = ""
        df = df[["id_any"] + [c for c in COLUNAS if c != "id_any"]]
        df.insert(0, "Check", False)
        df["Data"] = pd.to_datetime(df["Data"], errors="coerce")
        df["Data Coleta"] = pd.to_datetime(df["Data Coleta"], errors="coerce")
        _cache_bq.update({"df": df, "loaded_at": agora})
    return _cache_bq["df"]


def _carregar_do_zero(force_bq: bool = False) -> pd.DataFrame:
    """Reaplica o overlay (status manual + reparo + status CD) sobre a base."""
    df = aplicar_status_manual(_base_do_bigquery(force_refresh=force_bq).copy())
    df = _reparar_agendados_recebidos(df)
    df = _computar_status_cd(df)
    _cache.update({"df": df, "loaded_at": time.time()})
    return df


def _ids_com_saldo_completo(order_ids: Iterable[str] | None = None) -> set[str]:
    """Pedidos em que todas as linhas de conferencia_itens estão FEITO.

    `order_ids` restringe a consulta aos pedidos realmente candidatos. Sem ele a
    função varria a tabela inteira (dezenas de páginas de 1000 linhas por
    chamada), o que era a maior fonte de egress do projeto no Supabase.
    """
    alvos: list[str] = []
    if order_ids is not None:
        vistos: set[str] = set()
        for x in order_ids:
            # Manda a chave normalizada e a bruta: a coluna order_id pode estar
            # gravada com o sufixo ".0" herdado do ETL.
            for chave in (_norm_id_any(x), str(x or "").strip()):
                if chave and chave not in vistos:
                    vistos.add(chave)
                    alvos.append(chave)
        if not alvos:
            return set()

    try:
        client = get_client()
        rows: list = []
        if alvos:
            for i in range(0, len(alvos), 150):
                lote_ids = alvos[i : i + 150]
                resp = executar_com_retry(
                    lambda ids=lote_ids: client.table("conferencia_itens")
                    .select("order_id,quantidade_conferida,quantidade_total")
                    .in_("order_id", ids)
                    .execute()
                )
                rows.extend(list(resp.data or []))
        else:
            page_size = 1000
            inicio = 0
            while True:
                fim = inicio + page_size - 1
                resp = executar_com_retry(
                    lambda a=inicio, b=fim: client.table("conferencia_itens")
                    .select("order_id,quantidade_conferida,quantidade_total")
                    .range(a, b)
                    .execute()
                )
                lote = list(resp.data or [])
                rows.extend(lote)
                if len(lote) < page_size:
                    break
                inicio += page_size
                if inicio > 50000:
                    break
    except Exception:
        return set()
    por_pedido: dict[str, list] = {}
    for row in rows:
        oid = _norm_id_any(row.get("order_id"))
        if oid:
            por_pedido.setdefault(oid, []).append(row)
    feitos: set[str] = set()
    for oid, linhas in por_pedido.items():
        if not linhas:
            continue
        if all(
            int(r.get("quantidade_total") or 0) > 0
            and int(r.get("quantidade_conferida") or 0)
            >= int(r.get("quantidade_total") or 0)
            for r in linhas
        ):
            feitos.add(oid)
    return feitos


def _reparar_agendados_recebidos(df: pd.DataFrame) -> pd.DataFrame:
    """Agendado com saldo FEITO deve ficar Recebido (não preso em A conferir)."""
    if df is None or df.empty or "Status Any" not in df.columns:
        return df
    if "Data Coleta" not in df.columns:
        return df

    hoje = _hoje_negocio()
    coleta = pd.to_datetime(df["Data Coleta"], errors="coerce")
    status_cf = df["Status Any"].fillna("").astype(str).str.strip().str.casefold()
    fracos = status_cf.isin({"a conferir", "em separação", "em separacao", ""})
    mask = fracos & (coleta > hoje)
    if not mask.any():
        return df

    candidatos = [df.at[idx, "id_any"] for idx in df.index[mask]]
    feitos = _ids_com_saldo_completo(candidatos)
    if not feitos:
        return df

    from . import status_manual_service

    alvo = _status_agendado()
    out = df.copy()
    reparados = 0
    for idx in out.index[mask]:
        oid = _norm_id_any(out.at[idx, "id_any"])
        if oid not in feitos:
            continue
        out.at[idx, "Status Any"] = alvo
        try:
            status_manual_service.salvar_status_manual(
                oid,
                alvo,
                usuario="sistema",
                observacao="reparo_agendado_recebido",
            )
            reparados += 1
        except Exception as e:
            log_evento(
                "sistema",
                "ERRO_STATUS",
                f"Reparo agendado falhou para {oid}: {e}",
                oid,
            )
    if reparados:
        log_evento(
            "sistema",
            "REPARO_AGENDADO",
            f"{reparados} pedido(s) agendado(s) com saldo FEITO → {alvo}.",
            None,
        )
    return out


def get_pedidos_df(force_refresh: bool = False) -> pd.DataFrame:
    stale = (time.time() - _cache["loaded_at"]) > settings.cache_pedidos_ttl_seconds
    if force_refresh or _cache["df"] is None or stale:
        # force_refresh (botao Atualizar / pos-conferencia) invalida os dois
        # caches; o vencimento normal so refaz o overlay, que e barato.
        return _carregar_do_zero(force_bq=force_refresh)
    return _cache["df"]

def _garantir_pode_alterar_status(
    order_id: str,
    novo_status: str,
    *,
    permitir_saida_cancelado: bool = False,
) -> None:
    """Bloqueia sair de Cancelado, exceto baixa manual (admin)."""
    if permitir_saida_cancelado:
        return
    if _eh_status_cancelado(novo_status):
        return
    atual = _status_any_local(order_id)
    if _eh_status_cancelado(atual):
        raise StatusCanceladoBloqueado(MSG_STATUS_CANCELADO_BLOQUEADO)


def _salvar_status_no_supabase(
    order_id: str,
    novo_status: str,
    *,
    exigir_linha: bool = True,
    permitir_saida_cancelado: bool = False,
) -> bool:
    _garantir_pode_alterar_status(
        order_id,
        novo_status,
        permitir_saida_cancelado=permitir_saida_cancelado,
    )
    ok = atualizar_status_pedido(order_id, novo_status)
    if not ok:
        if exigir_linha:
            raise RuntimeError(
                f"Nenhuma linha do pedido {order_id} foi atualizada para {novo_status}."
            )
        return False

    # Garante persistência em pedidos_status_manual (fonte do overlay pós-BQ).
    try:
        from . import status_manual_service

        oid = _norm_id_any(order_id)
        gravado = status_manual_service.ler_status_manual(oid)
        if str(gravado or "").strip().casefold() != str(novo_status or "").strip().casefold():
            status_manual_service.salvar_status_manual(
                oid,
                novo_status,
                usuario="sistema",
                observacao="status_app_retry",
            )
            gravado = status_manual_service.ler_status_manual(oid)
            if str(gravado or "").strip().casefold() != str(novo_status or "").strip().casefold():
                raise RuntimeError(
                    f"Status {novo_status} não persistiu em pedidos_status_manual "
                    f"(lido: '{gravado or '—'}')."
                )
    except RuntimeError:
        if exigir_linha:
            raise
        return False
    except Exception as e:
        if exigir_linha:
            raise RuntimeError(
                f"Falha ao confirmar status {novo_status} do pedido {order_id}: {e}"
            ) from e
        return False
    return True


def _limpar_override_baixa_manual(order_id: str) -> None:
    """
    Antes: limpava pedidos_status_manual porque o status real ia em pedidos_recebimento.
    Agora a lista vem do BigQuery e o status operacional vive só em pedidos_status_manual —
    apagar aqui desfaz Conferido / A conferir e a UI volta ao status antigo do BQ.
    """
    return


def _limpar_override_se_fechou(order_id: str, status: str) -> None:
    # Mantido por compatibilidade de call sites; ver _limpar_override_baixa_manual.
    return


def _atualizar_status_local(
    order_id: str,
    novo_status: str,
    *,
    permitir_saida_cancelado: bool = False,
):
    _garantir_pode_alterar_status(
        order_id,
        novo_status,
        permitir_saida_cancelado=permitir_saida_cancelado,
    )
    df = _cache["df"]
    if df is None:
        return
    mask = _mask_pedido(df, order_id)
    if not mask.any():
        return
    df.loc[mask, "Status Any"] = novo_status
    df.loc[mask, "Check"] = False

    try:
        subset = df.loc[mask].drop(columns=["Status CD"], errors="ignore")
        subset = _computar_status_cd(subset.copy())
        df.loc[mask, "Status CD"] = subset["Status CD"].to_numpy()
    except Exception as e:
        log_evento("sistema", "ERRO_STATUS_CD", f"Falha ao recalcular Status CD de {order_id}: {e}", order_id)

def _normalizar_chave(valor) -> str:
    texto = unicodedata.normalize("NFKD", str(valor or ""))
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    return " ".join(texto.strip().casefold().split())

def _extrair_sku(item: dict) -> str:
    produto = item.get("product") or {}
    candidatos = (
        item.get("sku"),
        item.get("ean"),
        produto.get("sku") if isinstance(produto, dict) else None,
        produto.get("ean") if isinstance(produto, dict) else None,
        produto.get("id") if isinstance(produto, dict) else None,
        item.get("orderItemId"),
    )
    return str(next((v for v in candidatos if v not in (None, "")), "")).strip()

def _extrair_seller(item: dict) -> str:
    seller = (
        item.get("seller")
        or item.get("sellerName")
        or item.get("sellerId")
        or item.get("partner")
        or item.get("partnerId")
        or item.get("company")
    )
    if isinstance(seller, dict):
        seller = (
            seller.get("name")
            or seller.get("fantasyName")
            or seller.get("id")
            or seller.get("code")
        )
    return str(seller or "").strip()

def _line_key(order_id: str, sku: str, seller: str) -> str:
    return "|".join(
        (_normalizar_chave(order_id), _normalizar_chave(sku), _normalizar_chave(seller))
    )

def _seller_valido(valor) -> str:
    texto = str(valor or "").strip()
    if not texto or texto.casefold() in INVALIDOS_SELLER:
        return ""
    return texto

def _seller_local_por_sku(order_id: str) -> dict[str, str]:
    try:
        df = _cache["df"]
        if df is None:
            return {}
        linhas = df[_mask_pedido(df, order_id)]
    except Exception:
        return {}
    mapa: dict[str, str] = {}
    for _, row in linhas.iterrows():
        seller = _seller_valido(row.get("filial_seller"))
        if not seller:
            continue
        for chave in (row.get("ean"), row.get("Item")):
            normalizado = _normalizar_chave(chave)
            if normalizado and normalizado not in mapa:
                mapa[normalizado] = seller
    return mapa

def _resolver_seller(item: dict, sellers_locais: dict[str, str]) -> str:
    seller_api = _seller_valido(_extrair_seller(item))
    if seller_api:
        return seller_api
    sku = _extrair_sku(item)
    produto = item.get("product") or {}
    for candidato in (sku, item.get("ean"), produto.get("title"), item.get("description")):
        local = sellers_locais.get(_normalizar_chave(candidato))
        if local:
            return local
    unicos = sorted(set(sellers_locais.values()))
    if len(unicos) == 1:
        return unicos[0]
    return ""

def _ids_pedido_uteis(*valores) -> list[str]:

    vistos: set[str] = set()
    saida: list[str] = []
    for valor in valores:
        texto = str(valor or "").strip()
        if not texto or texto.casefold() in {"nan", "none", "null"}:
            continue
        chave = _normalizar_chave(texto)
        if chave in vistos:
            continue
        vistos.add(chave)
        saida.append(texto)
    return saida

def _part_numbers_texto(texto: str) -> set[str]:
    """Extrai possíveis part numbers de um título (ex.: ' - 2056', 'W936/8')."""
    bruto = str(texto or "").strip()
    if not bruto:
        return set()
    encontrados: set[str] = set()
    m = re.search(r"\s+-\s+([A-Za-z0-9][A-Za-z0-9./_-]*)\s*$", bruto)
    if m:
        encontrados.add(_normalizar_chave(m.group(1)))
    tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9./_-]*", bruto)
    for tok in reversed(tokens):
        if any(ch.isdigit() for ch in tok) and len(tok) >= 3:
            encontrados.add(_normalizar_chave(tok))
            break
    return {p for p in encontrados if p}


def _chaves_identidade_item(item: dict) -> set[str]:
    chaves: set[str] = set()
    produto = item.get("product") or {}
    for valor in (
        item.get("sku"),
        item.get("ean"),
        produto.get("sku") if isinstance(produto, dict) else None,
        produto.get("ean") if isinstance(produto, dict) else None,
    ):
        normalizado = _normalizar_chave(valor)
        if normalizado:
            chaves.add(normalizado)
            chaves.add(normalizado.replace("-", "").replace(" ", ""))
    return {c for c in chaves if c}


def _encontrar_linha_item(item: dict, linhas: pd.DataFrame) -> pd.Series | None:
    """Localiza a linha do DF/Supabase que corresponde ao item da Any.

    Nunca retorna a 'primeira linha do pedido' quando há vários itens —
    isso fazia o Filtro herdar o nome do Separador na sync do Sheets.
    """
    if linhas is None or linhas.empty:
        return None

    chaves = _chaves_identidade_item(item)
    partes_item = set(chaves)
    for texto in (
        (item.get("product") or {}).get("title") if isinstance(item.get("product"), dict) else None,
        item.get("description"),
        item.get("sku"),
    ):
        partes_item |= _part_numbers_texto(str(texto or ""))

    # 1) EAN / SKU na coluna ean do DF
    for _, row in linhas.iterrows():
        ean = _normalizar_chave(row.get("ean"))
        if not ean:
            continue
        ean_compacto = ean.replace("-", "").replace(" ", "")
        if ean in chaves or ean_compacto in chaves:
            return row

    # 2) Part number no fim do Item da planilha/DF
    for _, row in linhas.iterrows():
        item_txt = str(row.get("Item") or "")
        partes_row = _part_numbers_texto(item_txt)
        if partes_row & partes_item:
            return row
        item_compacto = _normalizar_chave(item_txt).replace("-", "").replace(" ", "")
        for chave in chaves:
            compacta = chave.replace("-", "").replace(" ", "")
            if len(compacta) >= 4 and compacta in item_compacto:
                return row

    # 3) Prefixo do título Any × Item local
    titulo = _normalizar_chave(
        (item.get("product") or {}).get("title") or item.get("description")
    )
    if titulo and len(titulo) >= 8:
        for _, row in linhas.iterrows():
            item_local = _normalizar_chave(row.get("Item"))
            if not item_local or len(item_local) < 8:
                continue
            if (
                titulo == item_local
                or titulo[:20] in item_local
                or item_local[:20] in titulo
                or titulo in item_local
                or item_local in titulo
            ):
                return row

    # 3b) Tokens fortes em comum (Any "COLA 793 TEKBOND" × Pedidos "Adesivo… 793… Tekbond")
    toks_titulo = _tokens_significativos_nome(titulo)
    if len(toks_titulo) >= 2:
        hits_token: list[pd.Series] = []
        for _, row in linhas.iterrows():
            inter = toks_titulo & _tokens_significativos_nome(str(row.get("Item") or ""))
            if len(inter) >= 2:
                hits_token.append(row)
        if len(hits_token) == 1:
            return hits_token[0]

    # 4) Seller único neste pedido
    seller = _normalizar_chave(item.get("seller"))
    if seller and seller not in {"aguardando vendedor", "padrao", "padrão"}:
        hits = [
            row
            for _, row in linhas.iterrows()
            if _normalizar_chave(row.get("filial_seller")) == seller
        ]
        if len(hits) == 1:
            return hits[0]

    # 5) Pedido de um único item
    if len(linhas) == 1:
        return linhas.iloc[0]

    return None


_STOP_TOKENS_NOME = frozenset(
    {
        "para",
        "com",
        "sem",
        "the",
        "and",
        "de",
        "da",
        "do",
        "das",
        "dos",
        "em",
        "ml",
        "cm",
        "mm",
        "kg",
        "un",
        "und",
        "unds",
        "pcs",
        "kit",
        "pack",
    }
)


def _tokens_significativos_nome(texto: str) -> set[str]:
    toks = set(_normalizar_chave(texto).split())
    saida: set[str] = set()
    for t in toks:
        if t in _STOP_TOKENS_NOME:
            continue
        # "20g" / "300ml" — pouco discriminantes
        if re.fullmatch(r"\d+[a-z]+", t):
            continue
        if t.isdigit():
            if len(t) >= 3:
                saida.add(t)
            continue
        if len(t) >= 3:
            saida.add(t)
    return saida


def _nomes_item_do_df(linhas: pd.DataFrame | None) -> list[str]:
    if linhas is None or linhas.empty:
        return []
    vistos: set[str] = set()
    saida: list[str] = []
    for _, row in linhas.iterrows():
        nome = str(row.get("Item") or "").strip()
        if not nome or nome.casefold() == "nan":
            continue
        chave = _normalizar_chave(nome)
        if not chave or chave in vistos:
            continue
        vistos.add(chave)
        saida.append(nome)
    return saida


def _nome_item_local(order_id: str, item: dict, linhas: pd.DataFrame | None = None) -> str:

    if linhas is None:
        try:
            df = get_pedidos_df()
            linhas = df[_mask_pedido(df, order_id)]
        except Exception:
            return ""
    if linhas is None or linhas.empty:
        return ""

    row = _encontrar_linha_item(item, linhas)
    if row is not None:
        nome = str(row.get("Item") or "").strip()
        if nome and nome.casefold() != "nan":
            return nome

    # Fallback: título Any ≠ Item do Pedidos (ex.: COLA 793… × Adesivo… Tekbond).
    # Usa overlap de tokens para não cair só no nome da Any.
    titulo = _normalizar_chave(
        (item.get("product") or {}).get("title") or item.get("description")
    )
    toks_titulo = _tokens_significativos_nome(titulo)
    if toks_titulo:
        hits: list[str] = []
        for nome in _nomes_item_do_df(linhas):
            inter = toks_titulo & _tokens_significativos_nome(nome)
            if len(inter) >= 2:
                hits.append(nome)
        if len(hits) == 1:
            return hits[0]

    nomes = _nomes_item_do_df(linhas)
    if len(nomes) == 1:
        return nomes[0]
    return ""


def _nomes_alternativos_item(
    item: dict,
    nome_produto: str,
    titulo_any: str,
    linha_df: pd.DataFrame,
) -> list[str]:
    """Candidatos extras somente do item conferido.

    Nunca inclui os demais produtos do mesmo pedido, pois todos compartilham
    os IDs I/P no Check B2C e isso atualizaria mais de uma linha.
    """
    nomes_alt: list[str] = []
    vistos = {_normalizar_chave(nome_produto)} if nome_produto else set()

    def _add(valor: str) -> None:
        texto = str(valor or "").strip()
        if not texto or texto.casefold() == "nan":
            return
        chave = _normalizar_chave(texto)
        if not chave or chave in vistos:
            return
        vistos.add(chave)
        nomes_alt.append(texto)

    _add(titulo_any)
    row = _encontrar_linha_item(item, linha_df) if not linha_df.empty else None
    if row is not None:
        _add(str(row.get("Item") or ""))
    return nomes_alt

def _agrupar_itens_por_sku_seller(order_id: str, itens: list[dict]) -> list[dict]:

    sellers_locais = _seller_local_por_sku(order_id)
    agrupados: dict[str, dict] = {}
    for item in itens:
        sku = _extrair_sku(item)
        seller = _resolver_seller(item, sellers_locais) or SELLER_AGUARDANDO
        chave = _line_key(order_id, sku, seller)
        quantidade = int(item.get("quantity") or 0)
        item_id = str(item.get("orderItemId") or "")

        if chave not in agrupados:
            agrupados[chave] = {
                **item,
                "line_key": chave,
                "sku": sku,
                "seller": seller,
                "quantity": 0,
                "orderItemIds": [],
            }
        agrupados[chave]["quantity"] += quantidade
        if item_id:
            agrupados[chave]["orderItemIds"].append(item_id)

    return list(agrupados.values())

def _pegar_itens_anymarket_cacheados(order_id: str):
    hit = _itens_cache.get(_norm_id_any(order_id))
    if not hit:
        return None
    if (time.time() - hit["ts"]) > settings.cache_itens_ttl_seconds:
        return None
    return hit.get("raw")

def _atualizar_cache_item_local(
    order_id: str,
    line_key: str,
    *,
    quantidade_conferida: int,
    status: str,
    usuario: str,
    quantidade_evento: int,
):
    hit = _itens_cache.get(_norm_id_any(order_id))
    if not hit or not hit.get("itens"):
        return
    for item in hit["itens"]:
        if item.get("line_key") != line_key:
            continue
        item["quantidade_conferida"] = quantidade_conferida
        item["status"] = status
        item["conferido_por"] = usuario
        item["data_conferencia"] = _fmt_data_br(datetime.now(tz=_TZ_BR)) or datetime.now().strftime("%d/%m/%Y %H:%M")
        item["ultimo_operador"] = usuario
        hist = list(item.get("historico") or [])
        hist.append(
            {
                "quantidade": quantidade_evento,
                "operador": usuario,
                "recebido_em": datetime.now().isoformat(),
            },
        )
        item["historico"] = hist
        ops = list(item.get("operadores") or [])
        if usuario and usuario not in ops:
            ops.append(usuario)
        item["operadores"] = ops
        break
    hit["ts"] = time.time()

def obter_itens_pedido(order_id: str, *, force_refresh: bool = False):
    oid = _norm_id_any(order_id)
    agora = time.time()
    hit = _itens_cache.get(oid)
    if not force_refresh:
        if hit and (agora - hit["ts"]) <= settings.cache_itens_ttl_seconds and hit.get("itens") is not None:
            return hit["itens"]

    def _fetch_am():
        return anymarket.get_order_items(order_id)

    def _fetch_sb():
        client = get_client()
        res_data: list = []
        hist_data: list = []
        for chave in _chaves_order_id(order_id):
            res = executar_com_retry(
                lambda c=chave: client.table("conferencia_itens")
                .select("order_id,line_key,item_id,sku,seller,quantidade_total,quantidade_conferida,status,conferido_por,data_conferencia,sheet_sync_ok,sheet_sync_error,finalizado_em")
                .eq("order_id", c)
                .execute()
            )
            if res.data:
                res_data = list(res.data)
                hist = executar_com_retry(
                    lambda c=chave: client.table("conferencia_recebimentos")
                    .select("line_key,quantidade,operador,recebido_em")
                    .eq("order_id", c)
                    .order("recebido_em", desc=True)
                    .execute()
                )
                hist_data = list(hist.data or [])
                break
        return res_data, hist_data

    # Pausa pré-baixa de PDF para não disputar a AnyMarket com o GET de itens.
    pref = None
    try:
        from . import etiqueta_prefetch as pref

        pref.pausar_por_conferencia()
    except Exception:
        pref = None

    itens_anymarket = None
    res_data: list = []
    hist_data: list = []
    am_erro: Exception | None = None
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            f_am = executor.submit(_fetch_am)
            f_sb = executor.submit(_fetch_sb)
            try:
                itens_anymarket = f_am.result()
            except Exception as e:
                am_erro = e
            try:
                res_data, hist_data = f_sb.result()
            except Exception:
                # Saldo local falhou: ainda dá para mostrar itens da AM com 0 conferido.
                res_data, hist_data = [], []
    finally:
        if pref is not None:
            try:
                pref.retomar_apos_conferencia()
            except Exception:
                pass

    if itens_anymarket is None:
        # Preferível degradar com cache antigo a devolver 502 no modal.
        if hit and hit.get("itens") is not None:
            return hit["itens"]
        raise RuntimeError(
            f"Falha ao carregar itens da AnyMarket: {am_erro or 'erro desconhecido'}"
        ) from am_erro

    if not itens_anymarket:
        _itens_cache[oid] = {"ts": agora, "itens": [], "raw": []}
        return []

    itens = _agrupar_itens_por_sku_seller(order_id, itens_anymarket)

    estado_map, estado_por_item_id = _mapas_estado_conferencia(res_data)
    historico_map: dict[str, list[dict]] = {}
    for evento in hist_data:
        historico_map.setdefault(evento["line_key"], []).append(evento)

    for item in itens:
        estado = _estado_item_conferencia(item, estado_map, estado_por_item_id)
        if estado:
            item["quantity"] = max(
                int(item["quantity"]),
                int(estado.get("quantidade_total") or 0),
            )
            quantidade_conferida = int(estado.get("quantidade_conferida") or 0)
            item["quantidade_conferida"] = quantidade_conferida
            item["status"] = (
                _sheets_feito()
                if quantidade_conferida >= int(item["quantity"])
                else _sheets_parcial() if quantidade_conferida > 0 else "Pendente"
            )
            item["conferido_por"] = estado.get("conferido_por")
            item["data_conferencia"] = _fmt_data_br(estado.get("data_conferencia"))
        else:
            item["quantidade_conferida"] = 0
            item["status"] = "Pendente"
        # Histórico pode estar na line_key antiga (seller diferente no recebimento).
        lk_hist = str((estado or {}).get("line_key") or item["line_key"])
        hist = list(historico_map.get(lk_hist, []))
        if lk_hist != item["line_key"]:
            hist.extend(historico_map.get(item["line_key"], []))
        hist.sort(key=lambda e: str(e.get("recebido_em") or ""))
        item["historico"] = hist
        ops: list[str] = []
        vistos_ops: set[str] = set()
        for ev in hist:
            op = str(ev.get("operador") or "").strip()
            if op and op not in vistos_ops:
                vistos_ops.add(op)
                ops.append(op)
        item["operadores"] = ops
        if hist:
            ultimo_ev = hist[-1]
            item["ultimo_operador"] = str(ultimo_ev.get("operador") or "").strip() or None
            hora_hist = _fmt_data_br(ultimo_ev.get("recebido_em"))
            if hora_hist:
                item["data_conferencia"] = hora_hist
        else:
            item["ultimo_operador"] = item.get("conferido_por")

        try:
            item["nome_tabela"] = _nome_item_local(order_id, item) or ""
        except Exception:
            item["nome_tabela"] = ""

    _itens_cache[oid] = {"ts": agora, "itens": itens, "raw": itens_anymarket}
    return itens

def _registrar_recebimento_atomico(
    order_id: str, item: dict, quantidade: int, usuario: str
) -> dict:

    client = get_client()
    resposta = executar_com_retry(
        lambda: client.rpc(
            "registrar_recebimento_item",
            {
                "p_order_id": str(order_id),
                "p_line_key": item["line_key"],
                "p_item_id": str((item.get("orderItemIds") or [""])[0]),
                "p_sku": item["sku"],
                "p_seller": item["seller"],
                "p_quantidade_total": int(item["quantity"]),
                "p_quantidade": quantidade,
                "p_operador": usuario,
            },
        ).execute()
    )
    dados = resposta.data
    if isinstance(dados, list):
        dados = dados[0] if dados else None
    if not dados:
        raise RuntimeError("O banco não retornou o saldo atualizado.")
    return dados

def _mapas_estado_conferencia(res_data: list) -> tuple[dict, dict]:
    """Índices de conferencia_itens: por line_key e por item_id (fallback)."""
    estado_map = {r.get("line_key"): r for r in res_data if r.get("line_key")}
    estado_por_item_id: dict = {}
    for r in res_data:
        iid = str(r.get("item_id") or "").strip()
        if iid:
            estado_por_item_id[iid] = r
    return estado_map, estado_por_item_id

def _estado_item_conferencia(
    item: dict, estado_map: dict, estado_por_item_id: dict
) -> dict | None:
    """
    Mesma regra de obter_itens_pedido: casa por line_key e, se o seller/SKU
    mudou (ex.: Aguardando Vendedor), tenta item_id gravado no recebimento.
    """
    estado = estado_map.get(item.get("line_key"))
    if estado:
        return estado
    for item_id in item.get("orderItemIds") or []:
        iid = str(item_id or "").strip()
        if not iid:
            continue
        estado = estado_por_item_id.get(iid)
        if estado:
            return estado
    return None

def _todas_linhas_feitas(order_id: str, itens: list[dict]) -> bool:

    if not itens:
        return False
    client = get_client()
    res_data: list = []
    for chave in _chaves_order_id(order_id):
        resposta = (
            client.table("conferencia_itens")
            .select(
                "line_key,item_id,quantidade_conferida,quantidade_total,status"
            )
            .eq("order_id", chave)
            .execute()
        )
        if resposta.data:
            res_data = list(resposta.data)
            break
    if not res_data:
        return False

    estado_map, estado_por_item_id = _mapas_estado_conferencia(res_data)

    for item in itens:
        row = _estado_item_conferencia(item, estado_map, estado_por_item_id)
        if not row:
            return False
        qtd = int(row.get("quantidade_conferida") or 0)
        total = int(item.get("quantity") or row.get("quantidade_total") or 0)
        if total <= 0 or qtd < total:
            return False
    return True

def _tentar_iniciar_finalizacao(order_id: str, usuario: str) -> bool:
    resposta = executar_com_retry(
        lambda: get_client().rpc(
            "tentar_iniciar_finalizacao_pedido",
            {"p_order_id": str(order_id), "p_operador": usuario},
        ).execute(),
        tentativas=3,
        espera_base=0.35,
    )
    dados = resposta.data
    if isinstance(dados, list):
        dados = dados[0] if dados else False
    return dados is True


def _concluir_finalizacao(order_id: str, status_pedido: str) -> None:
    """Marca a finalização como concluída; se a RPC falhar, força liberação do lock."""
    oid = str(order_id)
    status = str(status_pedido or "")
    try:
        executar_com_retry(
            lambda: get_client().rpc(
                "concluir_finalizacao_pedido",
                {"p_order_id": oid, "p_status": status},
            ).execute(),
            tentativas=4,
            espera_base=0.4,
        )
        return
    except Exception as e_concluir:
        # Conflito de rede (ex.: WinError 10035) não pode deixar o lock preso.
        try:
            _liberar_lock_finalizacao(oid)
        except Exception as e_liberar:
            raise RuntimeError(
                f"Falha ao concluir lock ({e_concluir}); "
                f"fallback liberar também falhou ({e_liberar})"
            ) from e_liberar


def _liberar_lock_finalizacao(order_id: str) -> None:
    """Libera o lock com retry e fallbacks; só falha se todas as estratégias falharem."""
    oid = str(order_id)
    client = get_client()
    estrategias = (
        lambda: client.rpc(
            "liberar_lock_finalizacao_pedido", {"p_order_id": oid}
        ).execute(),
        lambda: (
            client.table("conferencia_finalizacoes")
            .delete()
            .eq("order_id", oid)
            .execute()
        ),
        lambda: (
            client.table("conferencia_finalizacoes")
            .update(
                {
                    "status": "PROCESSANDO",
                    "iniciado_em": "2000-01-01T00:00:00+00:00",
                    "finalizado_em": None,
                }
            )
            .eq("order_id", oid)
            .execute()
        ),
    )
    erros: list[str] = []
    for estrategia in estrategias:
        try:
            executar_com_retry(estrategia, tentativas=3, espera_base=0.35)
            return
        except Exception as e:
            erros.append(str(e))
    raise RuntimeError(
        "Falha ao liberar lock de finalização: " + " | ".join(erros)
    )


def _registrar_sync_sheets(
    order_id: str,
    line_key: str,
    sheet_res: dict,
    usuario: str,
) -> None:
    """Persiste o resultado real do Sheets sem gerar uma falsa falha de planilha."""
    try:
        executar_com_retry(
            lambda: get_client().rpc(
                "registrar_resultado_sync_sheets",
                {
                    "p_order_id": str(order_id),
                    "p_line_key": line_key,
                    "p_ok": bool(sheet_res.get("ok")),
                    "p_erro": None if sheet_res.get("ok") else sheet_res.get("mensagem"),
                },
            ).execute()
        )
    except Exception as e:
        try:
            executar_com_retry(
                lambda: (
                    get_client()
                    .table("conferencia_itens")
                    .update(
                        {
                            "sheet_sync_ok": bool(sheet_res.get("ok")),
                            "sheet_sync_error": (
                                None if sheet_res.get("ok") else sheet_res.get("mensagem")
                            ),
                        }
                    )
                    .eq("order_id", str(order_id))
                    .eq("line_key", line_key)
                    .execute()
                )
            )
        except Exception as fallback_error:
            # O Sheets já foi tentado. Esta falha é somente no controle interno;
            # não deve aparecer ao operador como se a planilha não tivesse atualizado.
            log_evento(
                usuario,
                "ERRO_CONTROLE_SHEETS",
                (
                    "Falha ao registrar resultado do Sheets via RPC "
                    f"({e}) e fallback ({fallback_error})."
                ),
                order_id,
            )


def _consultar_lock_finalizacao(order_id: str) -> dict | None:
    """Linha de controle do lock; None quando não dá para inspecionar."""
    try:
        resposta = executar_com_retry(
            lambda: (
                get_client()
                .table("conferencia_finalizacoes")
                .select("*")
                .eq("order_id", str(order_id))
                .limit(1)
                .execute()
            ),
            tentativas=2,
            espera_base=0.25,
        )
    except Exception:
        return None
    dados = resposta.data or []
    return dados[0] if dados else None


def _lock_finalizacao_orfao(row: dict) -> bool:
    """Só é órfão depois do TTL — lock recente pertence a quem está finalizando agora."""
    if row.get("finalizado_em"):
        return True
    status = str(row.get("status") or "").strip().casefold()
    if status and status != "processando":
        return True

    iniciado_raw = row.get("iniciado_em")
    if not iniciado_raw:
        return True
    try:
        iniciado = datetime.fromisoformat(str(iniciado_raw).replace("Z", "+00:00"))
    except ValueError:
        return True
    if iniciado.tzinfo is None:
        iniciado = iniciado.replace(tzinfo=timezone.utc)
    limite = datetime.now(timezone.utc) - timedelta(
        seconds=settings.lock_finalizacao_ttl_seconds
    )
    return iniciado < limite


def _adquirir_lock_finalizacao(order_id: str, usuario: str) -> bool:
    """Adquire o lock; dono atual reusa; outro operador pode tomar o lock."""
    try:
        if _tentar_iniciar_finalizacao(order_id, usuario):
            return True
    except Exception as e:
        log_evento(
            usuario,
            "ERRO_CONTROLE_FINALIZACAO",
            f"Falha ao iniciar lock de finalização: {e}",
            order_id,
        )
        # Segue para tentativa de liberar + reassumir.

    row = _consultar_lock_finalizacao(order_id)
    dono = str((row or {}).get("operador") or "").strip()
    usuario_norm = str(usuario or "").strip()
    mesmo = bool(dono and dono.casefold() == usuario_norm.casefold())

    # Mesmo operador já é dono: reusa o lock sem liberar (não derruba pos-impressão).
    if row is not None and mesmo and not _lock_finalizacao_orfao(row):
        log_evento(
            usuario,
            "LOCK_FINALIZACAO",
            (
                "Retomando lock próprio ainda ativo "
                f"(desde {row.get('iniciado_em')})."
            ),
            order_id,
        )
        return True

    if row is None:
        motivo = "sem visibilidade da linha; forçando liberação"
    elif _lock_finalizacao_orfao(row):
        motivo = f"órfão após {settings.lock_finalizacao_ttl_seconds}s"
    elif mesmo:
        motivo = "retomada de lock órfão do mesmo operador"
    else:
        motivo = f"tomada de {dono or 'outro operador'}"

    try:
        _liberar_lock_finalizacao(order_id)
        log_evento(
            usuario,
            "LOCK_FINALIZACAO",
            (
                f"Lock liberado ({motivo}; dono anterior: {dono or 'desconhecido'}; "
                f"desde {(row or {}).get('iniciado_em')})."
            ),
            order_id,
        )
    except Exception as e:
        log_evento(
            usuario,
            "ERRO_CONTROLE_FINALIZACAO",
            f"Falha ao liberar lock para reassumir ({motivo}): {e}",
            order_id,
        )
        return False

    time.sleep(0.2)
    try:
        if _tentar_iniciar_finalizacao(order_id, usuario):
            return True
    except Exception as e:
        log_evento(
            usuario,
            "ERRO_CONTROLE_FINALIZACAO",
            f"Falha ao reassumir lock após liberação: {e}",
            order_id,
        )
        return False

    log_evento(
        usuario,
        "LOCK_FINALIZACAO_OCUPADO",
        (
            "Não foi possível adquirir o lock após liberação "
            f"({motivo}; dono anterior: {dono or 'desconhecido'})."
        ),
        order_id,
    )
    return False

def _executar_finalizacao_com_lock(
    order_id: str,
    usuario: str,
    linha_df: pd.DataFrame,
    erros_iniciais: list[dict] | None = None,
    crono: _Cronometro | None = None,
    sheet_pendente: dict | None = None,
    forcar_conferencia: bool = False,
) -> dict:

    resultado: dict | None = None
    status_liberacao = _status_manter_apos_falha(order_id)
    liberar_agora = True
    try:
        resultado = _finalizar_pedido_completo(
            order_id,
            usuario,
            linha_df,
            erros_iniciais=erros_iniciais,
            crono=crono,
            sheet_pendente=sheet_pendente,
            forcar_conferencia=forcar_conferencia,
        )
        status_liberacao = resultado.get("status_pedido") or status_liberacao
        if resultado.get("liberar_lock_em_background"):
            liberar_agora = False
        return {
            "ok": True,
            "pedido_concluido": True,
            "status_pedido": status_liberacao,
            "mensagem": resultado.get("mensagem") or "Pedido concluído.",
            "erros": resultado.get("erros") or [],
            "tempos": resultado.get("tempos"),
            "impressao_disparada": bool(resultado.get("impressao_disparada")),
        }
    except Exception as e:
        log_evento(usuario, "ERRO_FINALIZACAO", str(e), order_id)
        if crono is not None:
            crono.marca("erro_finalizacao")
        status_liberacao = _status_manter_apos_falha(order_id)
        try:
            _atualizar_status_local(order_id, status_liberacao)
            _salvar_status_no_supabase(order_id, status_liberacao, exigir_linha=False)
        except Exception as e2:
            log_evento(
                usuario,
                "ERRO_STATUS",
                f"Falha ao gravar status após erro de finalização: {e2}",
                order_id,
            )
        return {
            "ok": False,
            "pedido_concluido": True,
            "status_pedido": status_liberacao,
            "mensagem": f"Falha na finalização: {e}",
            "erros": [
                {
                    "tipo": "ERRO_FINALIZACAO",
                    "etapa": "finalizar",
                    "mensagem": str(e),
                }
            ],
            "tempos": crono.resumo() if crono else None,
        }
    finally:
        if liberar_agora:
            try:
                _concluir_finalizacao(order_id, status_liberacao)
            except Exception as e:
                log_evento(
                    usuario,
                    "ERRO_CONTROLE_FINALIZACAO",
                    f"Falha ao liberar lock de finalização: {e}",
                    order_id,
                )

def conferir_item_parcial(
    order_id: str,
    line_key: str,
    quantidade: int,
    usuario: str,
    forcar_conferencia: bool = False,
) -> dict:
    crono = _Cronometro()
    if quantidade <= 0:
        return {"ok": False, "mensagem": "A quantidade deve ser maior que zero."}

    status_atual = _status_any_local(order_id)
    if _eh_status_cancelado(status_atual):
        log_evento(
            usuario,
            "STATUS_CANCELADO_BLOQUEADO",
            MSG_STATUS_CANCELADO_BLOQUEADO,
            order_id,
        )
        return {
            "ok": False,
            "mensagem": MSG_STATUS_CANCELADO_BLOQUEADO,
            "tempos": crono.resumo(),
        }

    # Sempre lê saldo fresco do banco (evita cache stale + clique duplo).
    itens = obter_itens_pedido(order_id, force_refresh=True)
    crono.marca("carregar_itens")
    if not itens:
        return {"ok": False, "mensagem": "Itens não encontrados.", "tempos": crono.resumo()}

    item = next((i for i in itens if i.get("line_key") == line_key), None)
    if not item:
        return {
            "ok": False,
            "mensagem": "Linha de SKU/Seller não encontrada.",
            "tempos": crono.resumo(),
        }

    qtd_total = int(item.get("quantity") or 0)
    qtd_atual = int(item.get("quantidade_conferida") or 0)
    saldo_pendente = qtd_total - qtd_atual

    if saldo_pendente <= 0:
        novo_status_item = _sheets_feito()
        return {
            "ok": True,
            "novo_status": novo_status_item,
            "quantidade_conferida": qtd_atual,
            "saldo_pendente": 0,
            "pedido_concluido": False,
            "mensagem": "Item já estava totalmente conferido.",
            "erros": [],
            "tempos": crono.resumo(),
        }

    if quantidade > saldo_pendente:
        quantidade = saldo_pendente

    try:
        estado = _registrar_recebimento_atomico(order_id, item, quantidade, usuario)
    except Exception as e:
        msg = str(e)
        if "saldo pendente" in msg.casefold():
            # Corrida: outro request já zerou o saldo — sincroniza UI sem refinalizar.
            itens = obter_itens_pedido(order_id, force_refresh=True)
            item_atual = next((i for i in itens if i.get("line_key") == line_key), item)
            qtd_atual = int(item_atual.get("quantidade_conferida") or 0)
            qtd_total = int(item_atual.get("quantity") or qtd_total)
            saldo = max(0, qtd_total - qtd_atual)
            feito = qtd_atual >= qtd_total and qtd_total > 0
            novo_status_item = (
                _sheets_feito()
                if feito
                else _sheets_parcial() if qtd_atual > 0 else "Pendente"
            )
            _atualizar_cache_item_local(
                order_id,
                line_key,
                quantidade_conferida=qtd_atual,
                status=novo_status_item,
                usuario=usuario,
                quantidade_evento=0,
            )
            log_evento(
                usuario,
                "RECEBIMENTO_JA_CONFERIDO",
                f"Saldo 0 na corrida; sincronizado ({qtd_atual}/{qtd_total}).",
                order_id,
            )
            return {
                "ok": True,
                "novo_status": novo_status_item,
                "quantidade_conferida": qtd_atual,
                "saldo_pendente": saldo,
                "pedido_concluido": False,
                "mensagem": (
                    "Item já estava totalmente conferido."
                    if feito
                    else f"Saldo atualizado: restam {saldo} unidade(s)."
                ),
                "erros": [],
                "tempos": crono.resumo(),
            }
        log_evento(usuario, "ERRO_RECEBIMENTO", msg, order_id)
        return {
            "ok": False,
            "mensagem": f"Não foi possível salvar o recebimento: {e}",
            "tempos": crono.resumo(),
        }
    crono.marca("supabase_recebimento")

    nova_qtd = int(estado["quantidade_conferida"])
    if nova_qtd == qtd_total:
        novo_status_item = _sheets_feito()
    elif nova_qtd > 0:
        novo_status_item = _sheets_parcial()
    else:
        novo_status_item = "Pendente"

    df = get_pedidos_df()
    linha_df = df[_mask_pedido(df, order_id)]
    nome_produto = _nome_item_local(order_id, item, linha_df)
    titulo_any = str(
        (item.get("product") or {}).get("title")
        or item.get("description")
        or ""
    ).strip()
    if not nome_produto:
        nome_produto = titulo_any

    ids_brutos: list = [order_id]
    if not linha_df.empty:
        for _, row in linha_df.iterrows():
            ids_brutos.extend(
                [
                    row.get("Pedido Any"),
                    row.get("Pedido"),
                    row.get("Pedido Seller"),
                ]
            )
    ids_pedido = _ids_pedido_uteis(*ids_brutos)

    nomes_alt = _nomes_alternativos_item(item, nome_produto, titulo_any, linha_df)

    _atualizar_cache_item_local(
        order_id,
        line_key,
        quantidade_conferida=nova_qtd,
        status=novo_status_item,
        usuario=usuario,
        quantidade_evento=quantidade,
    )
    item["quantidade_conferida"] = nova_qtd
    item["status"] = novo_status_item

    todos_feitos = _todas_linhas_feitas(order_id, itens)
    crono.marca("checar_pedido_completo")

    erros_sheet: list[dict] = []
    sheet_pendente: dict | None = None

    if todos_feitos:
        sheet_pendente = {
            "item": item,
            "nova_qtd": nova_qtd,
            "novo_status": novo_status_item,
            "ids_pedido": ids_pedido,
            "nome_produto": nome_produto,
            "nomes_alt": nomes_alt,
        }
    else:
        sheet_res = atualizar_status_item_planilha(
            ids_pedido=ids_pedido,
            sku=item["sku"],
            seller=item["seller"],
            nome_produto=nome_produto,
            quantidade_conferida=nova_qtd,
            novo_status=novo_status_item,
            nomes_alternativos=nomes_alt,
            quantidade_total=int(item.get("quantity") or qtd_total or 0),
        )
        crono.marca("sheets_check_b2c")
        if sheet_res.get("ok"):
            log_evento(
                usuario,
                "SHEETS_OK",
                f"{nome_produto} → {novo_status_item}",
                order_id,
            )
        else:
            erro = {
                "tipo": "ERRO_SHEETS",
                "etapa": "atualizar_item",
                "mensagem": sheet_res.get("mensagem", "Falha desconhecida no Sheets."),
            }
            erros_sheet.append(erro)
            log_evento(usuario, erro["tipo"], erro["mensagem"], order_id)
        _registrar_sync_sheets(order_id, line_key, sheet_res, usuario)
        crono.marca("supabase_sync_sheets")

    if todos_feitos:
        if not _adquirir_lock_finalizacao(order_id, usuario):
            crono.marca("lock_finalizacao")

            if sheet_pendente:
                erros_sheet.extend(
                    _sincronizar_item_no_sheets(
                        order_id,
                        sheet_pendente["item"],
                        sheet_pendente["nova_qtd"],
                        sheet_pendente["novo_status"],
                        usuario,
                        linha_df,
                    )
                )
                crono.marca("sheets_check_b2c")

            status_lock = _status_manter_apos_falha(order_id)
            try:
                _atualizar_status_local(order_id, status_lock)
                _salvar_status_no_supabase(order_id, status_lock)
            except Exception as e:
                erros_sheet.append(
                    {
                        "tipo": "ERRO_STATUS",
                        "etapa": "salvar_status_lock",
                        "mensagem": str(e),
                    }
                )
                log_evento(usuario, "ERRO_STATUS", str(e), order_id)
            tempos = crono.resumo()
            performance_service.registrar_tempos_conferencia(
                order_id,
                usuario,
                tempos,
                pedido_concluido=True,
                status_pedido=status_lock,
            )
            return {
                "ok": True,
                "novo_status": novo_status_item,
                "quantidade_conferida": nova_qtd,
                "saldo_pendente": 0,
                "pedido_concluido": True,
                "status_pedido": status_lock,
                "mensagem": (
                    "Último item recebido, mas a finalização não conseguiu o lock. "
                    f"Status permanece {status_lock}. Use 'Concluir finalização' para retentar."
                ),
                "erros": erros_sheet
                + [
                    {
                        "tipo": "ERRO_FINALIZACAO",
                        "etapa": "lock_finalizacao",
                        "mensagem": "Lock de finalização indisponível após retentativa.",
                    }
                ],
                "tempos": tempos,
            }
        crono.marca("lock_finalizacao")
        resultado = _executar_finalizacao_com_lock(
            order_id,
            usuario,
            linha_df,
            erros_iniciais=erros_sheet,
            crono=crono,
            sheet_pendente=sheet_pendente,
            forcar_conferencia=forcar_conferencia,
        )
        tempos = resultado.get("tempos") or crono.resumo()
        performance_service.registrar_tempos_conferencia(
            order_id,
            usuario,
            tempos,
            pedido_concluido=True,
            status_pedido=resultado.get("status_pedido"),
        )
        return {
            "ok": bool(resultado.get("ok")),
            "novo_status": novo_status_item,
            "quantidade_conferida": nova_qtd,
            "saldo_pendente": qtd_total - nova_qtd,
            "pedido_concluido": True,
            "status_pedido": resultado.get("status_pedido"),
            "mensagem": resultado.get("mensagem"),
            "erros": resultado.get("erros") or [],
            "tempos": tempos,
            "impressao_disparada": bool(resultado.get("impressao_disparada")),
        }

    status_parcial = _status_parcial()
    try:
        _atualizar_status_local(order_id, status_parcial)
        _salvar_status_no_supabase(order_id, status_parcial)
    except Exception as e:
        erro = {
            "tipo": "ERRO_STATUS",
            "etapa": "salvar_recebido_parcial",
            "mensagem": str(e),
        }
        erros_sheet.append(erro)
        log_evento(usuario, erro["tipo"], erro["mensagem"], order_id)
    crono.marca("status_recebido_parcial")

    if erros_sheet:
        detalhe = erros_sheet[0].get("mensagem") or "planilha não atualizou"
        mensagem = f"Conferido no app · {detalhe}"
    else:
        mensagem = f"Item atualizado ({novo_status_item})."
    tempos = crono.resumo()
    performance_service.registrar_tempos_conferencia(
        order_id,
        usuario,
        tempos,
        pedido_concluido=False,
        status_pedido=status_parcial,
    )
    return {
        "ok": True,
        "novo_status": novo_status_item,
        "quantidade_conferida": nova_qtd,
        "saldo_pendente": qtd_total - nova_qtd,
        "pedido_concluido": False,
        "mensagem": mensagem,
        "erros": erros_sheet,
        "tempos": tempos,
    }

def _pedido_agendado(linha_df: pd.DataFrame | None) -> bool:

    if linha_df is None or linha_df.empty or "Data Coleta" not in linha_df.columns:
        return False
    try:
        coleta = pd.to_datetime(linha_df["Data Coleta"].iloc[0], errors="coerce")
    except Exception:
        return False
    if pd.isna(coleta):
        return False
    hoje = _hoje_negocio()
    coleta_util = _proxima_data_util(coleta)
    if pd.isna(coleta_util):
        return False
    return pd.Timestamp(coleta_util).normalize() > hoje


def _coleta_util_eh_hoje(linha_df: pd.DataFrame | None) -> bool:
    if linha_df is None or linha_df.empty or "Data Coleta" not in linha_df.columns:
        return False
    try:
        coleta = pd.to_datetime(linha_df["Data Coleta"].iloc[0], errors="coerce")
    except Exception:
        return False
    if pd.isna(coleta):
        return False
    hoje = _hoje_negocio()
    coleta_util = _proxima_data_util(coleta)
    if pd.isna(coleta_util):
        return False
    return pd.Timestamp(coleta_util).normalize() == hoje


def _status_recebido_antecipado(status) -> bool:
    """Recebido/FEITO de finalização antecipada (vira Coleta Hoje no dia da coleta)."""
    st = str(status or "").strip()
    if not st or _eh_status_cancelado(st):
        return False
    return st.casefold() in {
        STATUS_RECEBIDO.casefold(),
        _status_agendado().casefold(),
        "feito",
        _sheets_feito().casefold(),
    }


def _era_agendado_liberar_hoje(
    order_id: str, linha_df: pd.DataFrame | None = None
) -> bool:
    """Recebido cedo + coleta hoje → falta AnyMarket/etiqueta (Sheets já marcado)."""
    if not _status_recebido_antecipado(_status_any_local(order_id)):
        return False
    df = linha_df if linha_df is not None else _linha_df_pedido(order_id)
    return _coleta_util_eh_hoje(df)

def _ja_estava_feito(ok: bool, mensagem: str) -> bool:

    if ok:
        return True
    msg = (mensagem or "").lower()
    return "já foi conferido" in msg or "já havia sido" in msg

def _erros_so_impressao(erros: list[dict]) -> bool:

    if not erros:
        return False
    return all(str(e.get("tipo") or "") == "ERRO_IMPRESSAO" for e in erros)

def _status_sucesso_finalizacao(agendado: bool) -> str:

    return _status_agendado() if agendado else _status_coleta_hoje()

def _status_manter_apos_falha(order_id: str) -> str:
    """Status a manter quando a finalização falha (AnyMarket/etiqueta/NF etc.).

    Só é chamada depois que os itens já foram 100% recebidos fisicamente —
    todo chamador garante isso via `_todas_linhas_feitas` antes de chegar
    aqui (ver AGENTS.md §4.6). Por isso, se o status atual ainda for só um
    placeholder de "conferência em andamento" (`Recebido Parcial`, vazio,
    `AG AJUSTE`/`Finalizando` legados), ele é trocado por
    `status_recebido_pendente` — não faz sentido o pedido continuar
    rotulado como "falta receber item" quando o que falta, na verdade, é só
    resolver o erro de finalização. Se já estiver num status terminal
    (Conferido, Recebido, FEITO, Cancelado etc.), mantém como está.
    """
    st = _status_any_local(order_id) or ""
    st_cf = st.casefold()
    placeholders_pos_recebimento = {
        "finalizando",
        "ag ajuste",
        "",
        _status_parcial().casefold(),
        "recebido parcial",
    }
    if st_cf in placeholders_pos_recebimento:
        return _status_recebido_pendente()
    return st


def _finalizar_pedido_completo(
    order_id: str,
    usuario: str,
    _linha_df: pd.DataFrame,
    erros_iniciais: list[dict] | None = None,
    crono: _Cronometro | None = None,
    sheet_pendente: dict | None = None,
    forcar_conferencia: bool = False,
) -> dict:

    crono = crono or _Cronometro()
    erros: list[dict] = list(erros_iniciais or [])

    status_atual = _status_any_local(order_id)
    if _eh_status_cancelado(status_atual):
        return {
            "ok": False,
            "status_pedido": status_atual,
            "mensagem": MSG_STATUS_CANCELADO_BLOQUEADO,
            "erros": [
                {
                    "tipo": "ERRO_STATUS",
                    "etapa": "cancelado",
                    "mensagem": MSG_STATUS_CANCELADO_BLOQUEADO,
                }
            ],
            "tempos": crono.resumo(),
            "impressao_disparada": False,
            "liberar_lock_em_background": False,
        }
    agendado = _pedido_agendado(_linha_df)
    # Agendado normalmente pula Any/etiqueta; flag força o fluxo de coleta hoje.
    tratar_agendado = agendado and not forcar_conferencia
    impressao_disparada = False

    if not tratar_agendado:

        try:
            env_ok, env_msg = anymarket.enviar_para_conferencia(order_id, usuario)
            if not _ja_estava_feito(env_ok, env_msg):
                erros.append(
                    {
                        "tipo": "ERRO_CONFERENCIA",
                        "etapa": "enviar_para_conferencia",
                        "mensagem": env_msg,
                    }
                )
        except Exception as e:
            erros.append(
                {
                    "tipo": "ERRO_CONFERENCIA",
                    "etapa": "enviar_para_conferencia",
                    "mensagem": str(e),
                }
            )
        crono.marca("am_enviar_conferencia")

        try:
            itens_am = _pegar_itens_anymarket_cacheados(order_id)
            conf_ok, conf_msg = anymarket.conferir_produtos(
                order_id, usuario, itens=itens_am
            )
            if not _ja_estava_feito(conf_ok, conf_msg):
                erros.append(
                    {
                        "tipo": "ERRO_CONFERENCIA",
                        "etapa": "conferir_produtos",
                        "mensagem": conf_msg,
                    }
                )
        except Exception as e:
            erros.append(
                {
                    "tipo": "ERRO_CONFERENCIA",
                    "etapa": "conferir_produtos",
                    "mensagem": str(e),
                }
            )
        crono.marca("am_conferir_itens")

        oid = _norm_id_any(order_id)
        etiqueta_path = get_external_path(f"downloads/etiqueta_{oid}.pdf")
        danfe_path = get_external_path(f"downloads/danfe_{oid}.pdf")

        try:
            from . import etiqueta_prefetch

            etiqueta_prefetch.pausar_por_conferencia()
            try:
                with ThreadPoolExecutor(max_workers=2) as executor:
                    futures: dict = {}
                    if os.path.exists(etiqueta_path):
                        def _eti_cache(path=etiqueta_path, pedido=oid):
                            anymarket.garantir_etiqueta_magalu_1_pagina(pedido, path)
                            return True, "já em cache local"

                        futures["eti"] = executor.submit(_eti_cache)
                    else:
                        futures["eti"] = executor.submit(
                            anymarket.baixar_etiqueta,
                            oid,
                            etiqueta_path,
                        )
                    if os.path.exists(danfe_path):
                        futures["danfe"] = executor.submit(lambda: (True, "já em cache local"))
                    else:
                        futures["danfe"] = executor.submit(
                            anymarket.baixar_documento,
                            anymarket.get_link_danfe(oid),
                            danfe_path,
                        )
                    eti_ok, eti_msg = futures["eti"].result()
                    danfe_ok, danfe_msg = futures["danfe"].result()
            finally:
                etiqueta_prefetch.retomar_apos_conferencia()
        except Exception as e:
            eti_ok, eti_msg = False, str(e)
            danfe_ok, danfe_msg = False, str(e)
        crono.marca("download_etiqueta_danfe")

        if not eti_ok:
            erros.append({"tipo": "ERRO_ETIQUETA", "etapa": "download_etiqueta", "mensagem": eti_msg})
        if not danfe_ok:
            erros.append({"tipo": "ERRO_ETIQUETA", "etapa": "download_danfe", "mensagem": danfe_msg})

        etiqueta_impressa_ok = False
        if eti_ok:
            try:
                anymarket.garantir_etiqueta_magalu_1_pagina(oid, etiqueta_path)
                imp_ok, imp_msg = print_pdf(etiqueta_path, usuario)
                if not imp_ok:
                    erros.append(
                        {"tipo": "ERRO_IMPRESSAO", "etapa": "impressao_etiqueta", "mensagem": imp_msg}
                    )
                else:
                    etiqueta_impressa_ok = True
            except Exception as e:
                erros.append(
                    {"tipo": "ERRO_IMPRESSAO", "etapa": "impressao_etiqueta", "mensagem": str(e)}
                )
        crono.marca("impressao_etiqueta")

        if danfe_ok:
            try:
                imp_ok, imp_msg = print_pdf(danfe_path, usuario)
                if not imp_ok:
                    erros.append(
                        {"tipo": "ERRO_IMPRESSAO", "etapa": "impressao_danfe", "mensagem": imp_msg}
                    )
            except Exception as e:
                erros.append(
                    {"tipo": "ERRO_IMPRESSAO", "etapa": "impressao_danfe", "mensagem": str(e)}
                )
        crono.marca("impressao_danfe")
        # Só sinaliza “etiqueta saiu” quando a impressão da etiqueta OK —
        # aí o front pode fechar o modal com segurança.
        impressao_disparada = etiqueta_impressa_ok
    else:
        crono.marca("agendado_sem_am")

    if not erros:
        status_pedido = _status_sucesso_finalizacao(tratar_agendado)
        if not tratar_agendado:
            log_evento(
                usuario,
                "FINALIZACAO_OK",
                f"Pedido {order_id} finalizado com sucesso"
                + (
                    " (conferência forçada em agendado)."
                    if agendado and forcar_conferencia
                    else (
                        " (liberar hoje — era agendado)."
                        if _status_recebido_antecipado(status_atual)
                        and _coleta_util_eh_hoje(_linha_df)
                        else "."
                    )
                ),
                order_id,
            )
        mensagem = (
            "Pedido concluído e enviado à impressora."
            if not tratar_agendado
            else "Pedido agendado recebido. AnyMarket/etiqueta ficam para a data da coleta."
        )
    elif _erros_so_impressao(erros):
        status_pedido = _status_sucesso_finalizacao(tratar_agendado)
        resumo = "; ".join(f"{e['tipo']}[{e['etapa']}]: {e['mensagem']}" for e in erros)
        log_evento(
            usuario,
            "FINALIZACAO_AVISO_IMPRESSAO",
            f"Pedido {order_id} finalizado ({status_pedido}) com falha de impressão.",
            order_id,
        )
        for e in erros:
            log_evento(usuario, e["tipo"], f"{e['etapa']}: {e['mensagem']}", order_id)
        mensagem = (
            f"Pedido {status_pedido.lower()}, mas a impressão falhou. Use Reimprimir. — {resumo}"
        )
    else:
        status_pedido = _status_manter_apos_falha(order_id)
        resumo = "; ".join(f"{e['tipo']}[{e['etapa']}]: {e['mensagem']}" for e in erros)
        tipos_unicos = sorted({e["tipo"] for e in erros})
        log_evento(
            usuario,
            "FINALIZACAO_PENDENTE",
            f"Finalização incompleta ({', '.join(tipos_unicos)}); status permanece {status_pedido}.",
            order_id,
        )
        for e in erros:
            log_evento(usuario, e["tipo"], f"{e['etapa']}: {e['mensagem']}", order_id)
        mensagem = (
            f"Recebimento ok; finalização incompleta — status permanece {status_pedido}. {resumo}"
        )

    try:
        _atualizar_status_local(order_id, status_pedido)
        _salvar_status_no_supabase(order_id, status_pedido)
        _limpar_override_se_fechou(order_id, status_pedido)
    except Exception as e:
        erro_status = {
            "tipo": "ERRO_STATUS",
            "etapa": "salvar_status_pedido",
            "mensagem": str(e),
        }
        erros.append(erro_status)
        log_evento(usuario, erro_status["tipo"], erro_status["mensagem"], order_id)
        status_pedido = _status_manter_apos_falha(order_id)
        _atualizar_status_local(order_id, status_pedido)
        try:
            _salvar_status_no_supabase(order_id, status_pedido)
        except Exception as erro_ajuste:
            log_evento(
                usuario,
                "ERRO_STATUS",
                f"Também falhou ao salvar status de fallback: {erro_ajuste}",
                order_id,
            )
        mensagem = (
            f"Recebimento concluído, mas o status não pôde ser salvo: {e}. "
            f"Status permanece {status_pedido}."
        )
    crono.marca("salvar_status")

    status_para_lock = status_pedido
    sheet_ctx = sheet_pendente

    # Agendado: recebimento no CD (Sheets FEITO) é síncrono; AM/etiqueta ficam para a coleta.
    if tratar_agendado:
        if sheet_ctx:
            erros_sheet = _sincronizar_item_no_sheets(
                order_id,
                sheet_ctx["item"],
                sheet_ctx["nova_qtd"],
                sheet_ctx["novo_status"],
                usuario,
                _linha_df,
            )
            erros.extend(erros_sheet)
            crono.marca("sheets_check_b2c")
            if erros_sheet:
                detalhe = erros_sheet[0].get("mensagem") or "planilha não atualizou"
                mensagem = f"Agendado recebido · {detalhe}"
        log_evento(
            usuario,
            "FINALIZACAO_AGENDADO",
            (
                f"Pedido {order_id} agendado: recebimento ok, sem AnyMarket/etiqueta."
                if not any(e.get("tipo") == "ERRO_SHEETS" for e in erros)
                else (
                    f"Pedido {order_id} agendado recebido; planilha com pendência."
                )
            ),
            order_id,
        )
        try:
            _concluir_finalizacao(order_id, status_para_lock)
        except Exception as e:
            log_evento(
                usuario,
                "ERRO_CONTROLE_FINALIZACAO",
                f"Falha ao liberar lock (agendado): {e}",
                order_id,
            )
        return {
            "ok": True,
            "status_pedido": status_pedido,
            "mensagem": mensagem,
            "erros": erros,
            "tempos": crono.resumo(),
            "impressao_disparada": False,
            "liberar_lock_em_background": False,
        }

    def _continuar_pos_impressao() -> None:
        try:
            # Coleta hoje: Sheets em background (modal já pode ter fechado na etiqueta).
            if sheet_ctx:
                _sincronizar_item_no_sheets(
                    order_id,
                    sheet_ctx["item"],
                    sheet_ctx["nova_qtd"],
                    sheet_ctx["novo_status"],
                    usuario,
                    _linha_df,
                )
        except Exception as e:
            log_evento(usuario, "ERRO_SHEETS", f"pos_impressao: {e}", order_id)
        finally:
            try:
                _concluir_finalizacao(order_id, status_para_lock)
            except Exception as e:
                log_evento(
                    usuario,
                    "ERRO_CONTROLE_FINALIZACAO",
                    f"Falha ao liberar lock após impressão: {e}",
                    order_id,
                )

    threading.Thread(
        target=_continuar_pos_impressao,
        name=f"pos-impressao-{order_id}",
        daemon=True,
    ).start()

    return {
        "status_pedido": status_pedido,
        "mensagem": mensagem,
        "erros": erros,
        "tempos": crono.resumo(),
        "impressao_disparada": impressao_disparada,
        "liberar_lock_em_background": True,
        "ok": True,
    }

def _status_any_local(order_id: str) -> str:
    df = get_pedidos_df()
    if df is None or df.empty or "Status Any" not in df.columns:
        return ""
    linhas = df[_mask_pedido(df, order_id)]
    if linhas.empty:
        return ""
    return str(linhas["Status Any"].iloc[0] or "").strip()

def _linha_df_pedido(order_id: str) -> pd.DataFrame:
    df = get_pedidos_df()
    if df is None or df.empty:
        return pd.DataFrame()
    return df[_mask_pedido(df, order_id)].copy()

def _sincronizar_item_no_sheets(
    order_id: str,
    item: dict,
    nova_qtd: int,
    novo_status_item: str,
    usuario: str,
    linha_df: pd.DataFrame,
) -> list[dict]:

    erros_sheet: list[dict] = []
    # Pedido cancelado: planilha deve refletir CANCELADO, nunca FEITO/parcial.
    if _eh_status_cancelado(_status_any_local(order_id)):
        novo_status_item = SHEETS_STATUS_CANCELADO

    nome_produto = _nome_item_local(order_id, item, linha_df)
    titulo_any = str(
        (item.get("product") or {}).get("title")
        or item.get("description")
        or ""
    ).strip()
    if not nome_produto:
        nome_produto = titulo_any

    ids_brutos: list = [order_id]
    if not linha_df.empty:
        for _, row in linha_df.iterrows():
            ids_brutos.extend(
                [
                    row.get("Pedido Any"),
                    row.get("Pedido"),
                    row.get("Pedido Seller"),
                ]
            )
    ids_pedido = _ids_pedido_uteis(*ids_brutos)

    nomes_alt = _nomes_alternativos_item(item, nome_produto, titulo_any, linha_df)

    sheet_res = atualizar_status_item_planilha(
        ids_pedido=ids_pedido,
        sku=item["sku"],
        seller=item["seller"],
        nome_produto=nome_produto,
        quantidade_conferida=nova_qtd,
        novo_status=novo_status_item,
        nomes_alternativos=nomes_alt,
        quantidade_total=int(item.get("quantity") or 0),
    )
    if sheet_res.get("ok"):
        log_evento(
            usuario,
            "SHEETS_OK",
            f"{nome_produto} → {novo_status_item}",
            order_id,
        )
    else:
        erro = {
            "tipo": "ERRO_SHEETS",
            "etapa": "atualizar_item",
            "mensagem": sheet_res.get("mensagem", "Falha desconhecida no Sheets."),
        }
        erros_sheet.append(erro)
        log_evento(usuario, erro["tipo"], erro["mensagem"], order_id)
    _registrar_sync_sheets(order_id, item["line_key"], sheet_res, usuario)
    return erros_sheet

def conferir_pedido_integral(order_id: str, usuario: str) -> dict:

    status_any = _status_any_local(order_id)
    if status_any.casefold() not in STATUS_LOTE_CONFERIR:
        return {
            "ok": False,
            "mensagem": (
                f"Status '{status_any or '—'}' não permite conferência em lote. "
                "Use apenas Em separação ou A conferir."
            ),
        }

    ok_produto, info_produto = _pedido_elegivel_lote_produto(order_id)
    if not ok_produto:
        return {"ok": False, "mensagem": info_produto}

    try:
        itens = obter_itens_pedido(order_id, force_refresh=True)
    except Exception as e:
        return {"ok": False, "mensagem": f"Falha ao buscar itens: {e}"}
    if not itens:
        return {"ok": False, "mensagem": "Itens não encontrados."}

    linha_df = _linha_df_pedido(order_id)
    erros: list[dict] = []
    itens_atualizados = 0

    for item in itens:
        qtd_total = int(item.get("quantity") or 0)
        qtd_atual = int(item.get("quantidade_conferida") or 0)
        saldo = qtd_total - qtd_atual
        if saldo <= 0:
            continue
        try:
            estado = _registrar_recebimento_atomico(order_id, item, saldo, usuario)
        except Exception as e:
            log_evento(usuario, "ERRO_RECEBIMENTO", str(e), order_id)
            return {
                "ok": False,
                "mensagem": f"Falha ao registrar recebimento ({item.get('sku')}): {e}",
            }
        nova_qtd = int(estado["quantidade_conferida"])
        erros.extend(
            _sincronizar_item_no_sheets(
                order_id, item, nova_qtd, _sheets_feito(), usuario, linha_df
            )
        )
        item["quantidade_conferida"] = nova_qtd
        item["status"] = _sheets_feito()
        _atualizar_cache_item_local(
            order_id,
            item["line_key"],
            quantidade_conferida=nova_qtd,
            status=_sheets_feito(),
            usuario=usuario,
            quantidade_evento=saldo,
        )
        itens_atualizados += 1

    if not _todas_linhas_feitas(order_id, itens):
        return {
            "ok": False,
            "mensagem": "Não foi possível zerar o saldo de todos os itens do pedido.",
            "erros": erros,
        }

    if not _adquirir_lock_finalizacao(order_id, usuario):
        status_lock = _status_manter_apos_falha(order_id)
        try:
            _atualizar_status_local(order_id, status_lock)
            _salvar_status_no_supabase(order_id, status_lock)
        except Exception as e:
            log_evento(usuario, "ERRO_STATUS", str(e), order_id)
        return {
            "ok": True,
            "pedido_concluido": True,
            "status_pedido": status_lock,
            "mensagem": (
                "Itens recebidos, mas a finalização não conseguiu o lock. "
                f"Status permanece {status_lock}. Use 'Concluir finalização' para retentar."
            ),
            "erros": erros,
        }

    resultado = _executar_finalizacao_com_lock(
        order_id, usuario, linha_df, erros_iniciais=erros
    )
    log_evento(
        usuario,
        "CONFERENCIA_LOTE",
        f"Pedido {order_id} conferido integralmente ({itens_atualizados} linha(s)).",
        order_id,
    )
    return {
        "ok": bool(resultado.get("ok")),
        "pedido_concluido": True,
        "status_pedido": resultado.get("status_pedido"),
        "mensagem": resultado.get("mensagem"),
        "erros": resultado.get("erros") or [],
    }


def lote_fase_conferir(
    order_id: str, usuario: str, forcar_conferencia: bool = False
) -> dict:
    """Recebe 100% + AnyMarket. Sem download, impressão nem planilha."""
    oid = _norm_id_any(order_id)
    status_any = (_status_any_local(oid) or "").strip()
    status_cf = status_any.casefold()

    if status_cf in _status_pedido_fechado() or status_cf == "ag ajuste" or _eh_status_cancelado(
        status_any
    ):
        return {
            "ok": True,
            "fase": "conferir",
            "order_id": oid,
            "ja_feito": True,
            "status_pedido": status_any,
            "agendado": _pedido_agendado(_linha_df_pedido(oid)) and not forcar_conferencia,
            "mensagem": f"Pedido já estava em status '{status_any}'.",
        }

    if status_cf not in STATUS_LOTE_CONFERIR:
        return {
            "ok": False,
            "fase": "conferir",
            "order_id": oid,
            "mensagem": (
                f"Status '{status_any or '—'}' não permite conferência em lote. "
                "Use apenas Em separação ou A conferir."
            ),
        }

    ok_produto, info_produto = _pedido_elegivel_lote_produto(oid)
    if not ok_produto:
        return {
            "ok": False,
            "fase": "conferir",
            "order_id": oid,
            "mensagem": info_produto,
        }

    try:
        itens = obter_itens_pedido(oid, force_refresh=True)
    except Exception as e:
        return {
            "ok": False,
            "fase": "conferir",
            "order_id": oid,
            "mensagem": f"Falha ao buscar itens: {e}",
        }
    if not itens:
        return {
            "ok": False,
            "fase": "conferir",
            "order_id": oid,
            "mensagem": "Itens não encontrados.",
        }

    for item in itens:
        qtd_total = int(item.get("quantity") or 0)
        qtd_atual = int(item.get("quantidade_conferida") or 0)
        saldo = qtd_total - qtd_atual
        if saldo <= 0:
            continue
        try:
            estado = _registrar_recebimento_atomico(oid, item, saldo, usuario)
        except Exception as e:
            msg = str(e)
            if "saldo pendente" in msg.casefold():
                continue
            log_evento(usuario, "ERRO_RECEBIMENTO", msg, oid)
            return {
                "ok": False,
                "fase": "conferir",
                "order_id": oid,
                "mensagem": f"Falha ao registrar recebimento ({item.get('sku')}): {e}",
            }
        nova_qtd = int(estado["quantidade_conferida"])
        item["quantidade_conferida"] = nova_qtd
        item["status"] = _sheets_feito()
        _atualizar_cache_item_local(
            oid,
            item["line_key"],
            quantidade_conferida=nova_qtd,
            status=_sheets_feito(),
            usuario=usuario,
            quantidade_evento=saldo,
        )

    if not _todas_linhas_feitas(oid, itens):
        return {
            "ok": False,
            "fase": "conferir",
            "order_id": oid,
            "mensagem": "Não foi possível zerar o saldo de todos os itens do pedido.",
        }

    if not _adquirir_lock_finalizacao(oid, usuario):
        return {
            "ok": False,
            "fase": "conferir",
            "order_id": oid,
            "mensagem": "Lock de finalização indisponível. Tente novamente em instantes.",
        }

    linha_df = _linha_df_pedido(oid)
    agendado = _pedido_agendado(linha_df)
    pular_any = agendado and not forcar_conferencia
    erros: list[dict] = []
    status_pedido = _status_manter_apos_falha(oid)

    try:
        if not pular_any:
            try:
                env_ok, env_msg = anymarket.enviar_para_conferencia(oid, usuario)
                if not _ja_estava_feito(env_ok, env_msg):
                    erros.append(
                        {
                            "tipo": "ERRO_CONFERENCIA",
                            "etapa": "enviar_para_conferencia",
                            "mensagem": env_msg,
                        }
                    )
            except Exception as e:
                erros.append(
                    {
                        "tipo": "ERRO_CONFERENCIA",
                        "etapa": "enviar_para_conferencia",
                        "mensagem": str(e),
                    }
                )

            try:
                itens_am = _pegar_itens_anymarket_cacheados(oid)
                conf_ok, conf_msg = anymarket.conferir_produtos(
                    oid, usuario, itens=itens_am
                )
                if not _ja_estava_feito(conf_ok, conf_msg):
                    erros.append(
                        {
                            "tipo": "ERRO_CONFERENCIA",
                            "etapa": "conferir_produtos",
                            "mensagem": conf_msg,
                        }
                    )
            except Exception as e:
                erros.append(
                    {
                        "tipo": "ERRO_CONFERENCIA",
                        "etapa": "conferir_produtos",
                        "mensagem": str(e),
                    }
                )

        if erros:
            status_pedido = _status_manter_apos_falha(oid)
            try:
                _atualizar_status_local(oid, status_pedido)
                _salvar_status_no_supabase(oid, status_pedido, exigir_linha=False)
            except Exception:
                pass
            for e in erros:
                log_evento(usuario, e["tipo"], f"{e['etapa']}: {e['mensagem']}", oid)
            return {
                "ok": False,
                "fase": "conferir",
                "order_id": oid,
                "status_pedido": status_pedido,
                "agendado": pular_any,
                "mensagem": erros[0]["mensagem"],
                "erros": erros,
            }

        status_pedido = _status_sucesso_finalizacao(pular_any)
        try:
            _atualizar_status_local(oid, status_pedido)
            _salvar_status_no_supabase(oid, status_pedido)
            _limpar_override_se_fechou(oid, status_pedido)
        except Exception as e:
            log_evento(usuario, "ERRO_STATUS", str(e), oid)
            return {
                "ok": False,
                "fase": "conferir",
                "order_id": oid,
                "mensagem": f"Conferência ok, mas falhou ao salvar status: {e}",
            }

        log_evento(
            usuario,
            "CONFERENCIA_LOTE",
            f"Lote fase conferir OK ({status_pedido})"
            + (" [forçado]" if agendado and forcar_conferencia else "")
            + ".",
            oid,
        )
        return {
            "ok": True,
            "fase": "conferir",
            "order_id": oid,
            "status_pedido": status_pedido,
            "agendado": pular_any,
            "mensagem": (
                "Recebimento + AnyMarket ok."
                if not pular_any
                else "Recebimento ok (agendado — sem Any/etiqueta agora)."
            ),
        }
    finally:
        try:
            _concluir_finalizacao(oid, status_pedido)
        except Exception as e:
            log_evento(
                usuario,
                "ERRO_CONTROLE_FINALIZACAO",
                f"Falha ao liberar lock (lote conferir): {e}",
                oid,
            )


def lote_fase_baixar(
    order_id: str, usuario: str, forcar_conferencia: bool = False
) -> dict:
    """Baixa etiqueta + DANFE em paralelo (reusa cache local)."""
    oid = _norm_id_any(order_id)
    linha_df = _linha_df_pedido(oid)
    if _pedido_agendado(linha_df) and not forcar_conferencia:
        return {
            "ok": True,
            "fase": "baixar",
            "order_id": oid,
            "pulado": True,
            "etiqueta_ok": True,
            "danfe_ok": True,
            "mensagem": "Agendado — download fica para a data da coleta.",
        }

    etiqueta_path = get_external_path(f"downloads/etiqueta_{oid}.pdf")
    danfe_path = get_external_path(f"downloads/danfe_{oid}.pdf")

    try:
        from . import etiqueta_prefetch

        etiqueta_prefetch.pausar_por_conferencia()
        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                if os.path.exists(etiqueta_path):
                    def _eti_cache(path=etiqueta_path, pedido=oid):
                        anymarket.garantir_etiqueta_magalu_1_pagina(pedido, path)
                        return True, "cache"

                    f_eti = executor.submit(_eti_cache)
                else:
                    f_eti = executor.submit(
                        anymarket.baixar_etiqueta,
                        oid,
                        etiqueta_path,
                    )
                if os.path.exists(danfe_path):
                    f_danfe = executor.submit(lambda: (True, "cache"))
                else:
                    f_danfe = executor.submit(
                        anymarket.baixar_documento,
                        anymarket.get_link_danfe(oid),
                        danfe_path,
                    )
                eti_ok, eti_msg = f_eti.result()
                danfe_ok, danfe_msg = f_danfe.result()
        finally:
            etiqueta_prefetch.retomar_apos_conferencia()
    except Exception as e:
        return {
            "ok": False,
            "fase": "baixar",
            "order_id": oid,
            "etiqueta_ok": False,
            "danfe_ok": False,
            "mensagem": str(e),
        }

    ok = bool(eti_ok and danfe_ok)
    if not ok:
        partes = []
        if not eti_ok:
            partes.append(f"etiqueta: {eti_msg}")
        if not danfe_ok:
            partes.append(f"DANFE: {danfe_msg}")
        log_evento(usuario, "ERRO_ETIQUETA", "; ".join(partes), oid)
    else:
        log_evento(usuario, "DOWNLOAD_OK", "Etiqueta + DANFE prontos (lote).", oid)

    return {
        "ok": ok,
        "fase": "baixar",
        "order_id": oid,
        "etiqueta_ok": bool(eti_ok),
        "danfe_ok": bool(danfe_ok),
        "mensagem": (
            "Documentos baixados."
            if ok
            else "; ".join(
                p
                for p, cond in (
                    (f"etiqueta: {eti_msg}", not eti_ok),
                    (f"DANFE: {danfe_msg}", not danfe_ok),
                )
                if cond
            )
        ),
    }


def lote_fase_imprimir(
    order_id: str, usuario: str, forcar_conferencia: bool = False
) -> dict:
    """Imprime PDFs locais (etiqueta depois DANFE)."""
    oid = _norm_id_any(order_id)
    if _pedido_agendado(_linha_df_pedido(oid)) and not forcar_conferencia:
        return {
            "ok": True,
            "fase": "imprimir",
            "order_id": oid,
            "pulado": True,
            "etiqueta_ok": True,
            "danfe_ok": True,
            "mensagem": "Agendado — impressão fica para a data da coleta.",
        }

    etiqueta_path = get_external_path(f"downloads/etiqueta_{oid}.pdf")
    danfe_path = get_external_path(f"downloads/danfe_{oid}.pdf")
    erros: list[str] = []
    eti_ok = danfe_ok = False

    if not os.path.exists(etiqueta_path):
        erros.append("PDF da etiqueta não encontrado — baixe antes.")
    else:
        try:
            anymarket.garantir_etiqueta_magalu_1_pagina(oid, etiqueta_path)
            eti_ok, eti_msg = print_pdf(etiqueta_path, usuario)
            if not eti_ok:
                erros.append(eti_msg)
        except Exception as e:
            erros.append(str(e))

    if not os.path.exists(danfe_path):
        erros.append("PDF da DANFE não encontrado — baixe antes.")
    else:
        try:
            danfe_ok, danfe_msg = print_pdf(danfe_path, usuario)
            if not danfe_ok:
                erros.append(danfe_msg)
        except Exception as e:
            erros.append(str(e))

    ok = bool(eti_ok and danfe_ok and not erros)
    if not ok:
        log_evento(usuario, "ERRO_IMPRESSAO", "; ".join(erros) or "falha", oid)

    return {
        "ok": ok,
        "fase": "imprimir",
        "order_id": oid,
        "etiqueta_ok": bool(eti_ok),
        "danfe_ok": bool(danfe_ok),
        "mensagem": "Impressão enviada." if ok else ("; ".join(erros) or "Falha na impressão."),
    }


def lote_fase_planilha(order_id: str, usuario: str) -> dict:
    """Marca FEITO na planilha (recebimento CD) — independente de impressão."""
    oid = _norm_id_any(order_id)
    try:
        itens = obter_itens_pedido(oid, force_refresh=True)
    except Exception as e:
        return {
            "ok": False,
            "fase": "planilha",
            "order_id": oid,
            "mensagem": f"Falha ao carregar itens: {e}",
        }
    if not itens:
        return {
            "ok": False,
            "fase": "planilha",
            "order_id": oid,
            "mensagem": "Itens não encontrados para marcar na planilha.",
        }

    linha_df = _linha_df_pedido(oid)
    erros: list[dict] = []
    marcados = 0
    for item in itens:
        qtd_conf = int(item.get("quantidade_conferida") or 0)
        qtd_total = int(item.get("quantity") or 0)
        # Planilha = recebimento no CD: usa conferido, senão total do pedido.
        nova_qtd = qtd_conf if qtd_conf > 0 else qtd_total
        if nova_qtd <= 0:
            continue
        sheet_erros = _sincronizar_item_no_sheets(
            oid, item, nova_qtd, _sheets_feito(), usuario, linha_df
        )
        if sheet_erros:
            erros.extend(sheet_erros)
        else:
            marcados += 1

    ok = len(erros) == 0 and marcados > 0
    if marcados == 0 and not erros:
        return {
            "ok": False,
            "fase": "planilha",
            "order_id": oid,
            "mensagem": "Nenhuma linha para marcar na planilha.",
        }
    if erros:
        return {
            "ok": False,
            "fase": "planilha",
            "order_id": oid,
            "marcados": marcados,
            "mensagem": erros[0].get("mensagem") or "Falha ao marcar planilha.",
            "erros": erros,
        }
    log_evento(
        usuario,
        "SHEETS_OK",
        f"Lote planilha: {marcados} linha(s) FEITO.",
        oid,
    )
    return {
        "ok": True,
        "fase": "planilha",
        "order_id": oid,
        "marcados": marcados,
        "mensagem": f"{marcados} linha(s) marcadas como FEITO na planilha.",
    }


_LOTE_FASES = {
    "conferir": lote_fase_conferir,
    "baixar": lote_fase_baixar,
    "imprimir": lote_fase_imprimir,
    "planilha": lote_fase_planilha,
}


def executar_lote_passo(
    order_id: str,
    fase: str,
    usuario: str,
    forcar_conferencia: bool = False,
) -> dict:
    fase_norm = (fase or "").strip().casefold()
    if fase_norm == "conferir":
        return lote_fase_conferir(
            order_id, usuario, forcar_conferencia=forcar_conferencia
        )
    if fase_norm == "baixar":
        return lote_fase_baixar(
            order_id, usuario, forcar_conferencia=forcar_conferencia
        )
    if fase_norm == "imprimir":
        return lote_fase_imprimir(
            order_id, usuario, forcar_conferencia=forcar_conferencia
        )
    if fase_norm == "planilha":
        return lote_fase_planilha(order_id, usuario)
    return {
        "ok": False,
        "fase": fase,
        "order_id": _norm_id_any(order_id),
        "mensagem": f"Fase inválida: {fase}. Use conferir, baixar, imprimir ou planilha.",
    }

def _resetar_saldos_conferencia(order_id: str, usuario: str) -> list[dict]:

    oid = _norm_id_any(order_id)
    client = get_client()
    erros: list[dict] = []

    try:
        resp = client.rpc("resetar_saldo_conferencia", {"p_order_id": oid}).execute()
        n = resp.data
        if isinstance(n, list):
            n = n[0] if n else 0
        n = int(n or 0)
        # RPC ok: completa limpeza de sync Sheets + histórico de recebimentos.
        if n > 0:
            for chave in _chaves_order_id(order_id):
                try:
                    client.table("conferencia_itens").update(
                        {"sheet_sync_ok": True, "sheet_sync_error": None}
                    ).eq("order_id", chave).execute()
                except Exception:
                    pass
                try:
                    client.table("conferencia_recebimentos").delete().eq(
                        "order_id", chave
                    ).execute()
                except Exception:
                    pass
        _itens_cache.pop(oid, None)
        _itens_cache.pop(str(order_id), None)
        for chave in _chaves_order_id(order_id):
            _itens_cache.pop(str(chave), None)
        return erros
    except Exception as e_rpc:
        msg_rpc = str(e_rpc)

        if "resetar_saldo_conferencia" not in msg_rpc.casefold() and "PGRST202" not in msg_rpc:

            erros.append(
                {
                    "tipo": "ERRO_RECEBIMENTO",
                    "etapa": "resetar_saldo_rpc",
                    "mensagem": msg_rpc,
                }
            )

    payload = {
        "quantidade_conferida": 0,
        "status": "Pendente",
        "conferido_por": None,
        "data_conferencia": None,
        "sheet_sync_ok": True,
        "sheet_sync_error": None,
    }

    rows: list[dict] = []
    for chave in _chaves_order_id(order_id):
        try:
            check = (
                client.table("conferencia_itens")
                .select("id,order_id,line_key,quantidade_conferida,status")
                .eq("order_id", chave)
                .execute()
            )
            if check.data:
                rows = list(check.data)
                break
        except Exception:
            continue

    atualizados = 0
    perm_denied = False
    for r in rows:
        row_id = r.get("id")
        if row_id is None:
            continue
        try:
            resp = (
                client.table("conferencia_itens")
                .update(payload)
                .eq("id", row_id)
                .execute()
            )
            if resp.data:
                atualizados += len(resp.data)
            else:

                atualizados += 1
        except Exception as e:
            texto = str(e)
            if "42501" in texto or "permission denied" in texto.casefold():
                perm_denied = True
            # Colunas sheet_sync_* podem não existir em bases antigas — tenta sem elas.
            if "sheet_sync" in texto.casefold():
                try:
                    resp = (
                        client.table("conferencia_itens")
                        .update(
                            {
                                "quantidade_conferida": 0,
                                "status": "Pendente",
                                "conferido_por": None,
                                "data_conferencia": None,
                            }
                        )
                        .eq("id", row_id)
                        .execute()
                    )
                    if resp.data:
                        atualizados += len(resp.data)
                    else:
                        atualizados += 1
                    continue
                except Exception as e2:
                    texto = str(e2)
                    if "42501" in texto or "permission denied" in texto.casefold():
                        perm_denied = True
            erros.append(
                {
                    "tipo": "ERRO_RECEBIMENTO",
                    "etapa": "resetar_saldo",
                    "mensagem": f"id={row_id}: {e}",
                }
            )

    # Histórico de recebimentos — senão o saldo “volta” na UI.
    for chave in _chaves_order_id(order_id):
        try:
            client.table("conferencia_recebimentos").delete().eq("order_id", chave).execute()
        except Exception as e:
            erros.append(
                {
                    "tipo": "ERRO_RECEBIMENTO",
                    "etapa": "limpar_recebimentos",
                    "mensagem": str(e),
                }
            )

    if perm_denied or (rows and atualizados == 0):
        for chave in _chaves_order_id(order_id):
            try:
                client.table("conferencia_itens").delete().eq("order_id", chave).execute()
                perm_denied = False
                atualizados = max(atualizados, len(rows) or 1)
                break
            except Exception as e:
                texto = str(e)
                if "42501" in texto or "permission denied" in texto.casefold():
                    perm_denied = True
                erros.append(
                    {
                        "tipo": "ERRO_RECEBIMENTO",
                        "etapa": "resetar_saldo_delete",
                        "mensagem": str(e),
                    }
                )

    ainda = 0
    for chave in _chaves_order_id(order_id):
        try:
            check = (
                client.table("conferencia_itens")
                .select("quantidade_conferida,status")
                .eq("order_id", chave)
                .execute()
            )
        except Exception:
            continue
        ainda = sum(
            1
            for r in (check.data or [])
            if int(r.get("quantidade_conferida") or 0) > 0
            or str(r.get("status") or "").casefold() == "feito"
        )
        if check.data is not None:
            break

    if ainda or perm_denied:
        sql_fix = (
            "No SQL Editor do Supabase rode:\n"
            "1) backend/sql/resetar_saldo_conferencia.sql  (cria a RPC)\n"
            f"2) UPDATE conferencia_itens SET quantidade_conferida=0, status='Pendente', "
            f"conferido_por=NULL, data_conferencia=NULL WHERE order_id='{oid}';"
        )
        erros.append(
            {
                "tipo": "ERRO_RECEBIMENTO",
                "etapa": "resetar_saldo",
                "mensagem": (
                    f"Sem permissão de UPDATE em conferencia_itens (role anon). "
                    f"Linhas ainda FEITO: {ainda}. {sql_fix}"
                ),
            }
        )
        log_evento(
            usuario,
            "ERRO_RECEBIMENTO",
            f"Reset saldo pedido {oid}: permission denied / {ainda} linha(s) restantes.",
            order_id,
        )

    _itens_cache.pop(oid, None)
    _itens_cache.pop(str(order_id), None)
    for chave in _chaves_order_id(order_id):
        _itens_cache.pop(str(chave), None)
    return erros

def desmarcar_conferencia_pedido(order_id: str, usuario: str) -> dict:

    try:
        status_atual = _status_any_local(order_id)
    except Exception as e:
        log_evento(
            usuario,
            "ERRO_STATUS",
            f"Não foi possível ler status local antes de desmarcar: {e}",
            order_id,
        )
        status_atual = ""

    status_cf = status_atual.casefold()
    status_parcial_cf = _status_parcial().casefold()
    status_recebido_pendente_cf = _status_recebido_pendente().casefold()
    status_ok = status_cf in {
        "conferido",
        "recebido",
        "feito",
        "a conferir",
        "recebido parcial",
        "faltando item",
        "ag ajuste",
        status_parcial_cf,
        status_recebido_pendente_cf,
        "",
    } or status_cf in _status_pedido_fechado()
    if status_atual and not status_ok:
        return {
            "ok": False,
            "mensagem": (
                f"Só é possível desmarcar pedidos Conferido, Recebido, Recebido Parcial, "
                f"FEITO, AG AJUSTE, '{_status_recebido_pendente()}' ou A conferir "
                f"(status atual: '{status_atual}')."
            ),
        }

    erros_reset = _resetar_saldos_conferencia(order_id, usuario)
    if erros_reset:
        return {
            "ok": False,
            "status_pedido": status_atual or None,
            "mensagem": (
                "Não foi possível zerar o saldo local. Conferência NÃO foi desmarcada. "
                "Rode backend/sql/resetar_saldo_conferencia.sql no Supabase e tente de novo."
            ),
            "erros": erros_reset,
            "anymarket_ok": None,
        }

    ok_am, msg_am = anymarket.desmarcar_conferencia(order_id, usuario)
    if not ok_am:
        log_evento(
            usuario,
            "ERROR",
            f"Uncheck AM falhou ({msg_am}); saldo local já zerado.",
            order_id,
        )

    _atualizar_status_local(order_id, "A conferir")
    atualizou_sb = False
    try:
        atualizou_sb = _salvar_status_no_supabase(
            order_id, "A conferir", exigir_linha=False
        )
        _limpar_override_baixa_manual(order_id)
    except Exception as e:
        log_evento(
            usuario,
            "ERRO_STATUS",
            f"Desmarcado; falha ao salvar status local: {e}",
            order_id,
        )

    try:
        _liberar_lock_finalizacao(order_id)
    except Exception as e:
        log_evento(
            usuario,
            "ERRO_CONTROLE_FINALIZACAO",
            f"Desmarcado; falha ao limpar lock de finalização: {e}",
            order_id,
        )

    log_evento(
        usuario,
        "CONFERENCIA_DESMARCADA",
        (
            f"{usuario} desmarcou a conferência."
            + (
                " Status local → A conferir."
                if atualizou_sb
                else " Pedido sem linha em pedidos_recebimento (só AnyMarket)."
            )
        ),
        order_id,
    )

    avisos: list[str] = []
    if not ok_am or "não confirmou" in (msg_am or "").casefold():
        avisos.append(msg_am)
    if not atualizou_sb:
        avisos.append("Sem linha em pedidos_recebimento (só AnyMarket).")

    return {
        "ok": True,
        "status_pedido": "A conferir" if atualizou_sb else (status_atual or None),
        "mensagem": (
            "Conferência desmarcada. Pedido liberado para conferir de novo. "
            "Se alterou a planilha Check B2C no teste, restaure o nome do item "
            "e o status (coluna H) manualmente."
            + ((" Aviso: " + " · ".join(a for a in avisos if a)) if avisos else "")
        ),
        "erros": [],
        "anymarket_ok": ok_am,
    }

def retomar_finalizacao_pedido(
    order_id: str, usuario: str, forcar_conferencia: bool = False
) -> dict:

    itens = obter_itens_pedido(order_id, force_refresh=True)
    if not itens:
        return {"ok": False, "mensagem": "Itens não encontrados."}

    if not _todas_linhas_feitas(order_id, itens):
        return {
            "ok": False,
            "mensagem": (
                "Ainda há saldo pendente neste pedido. "
                "Confira os itens (ou desmarque e confira de novo) antes de finalizar."
            ),
        }

    linha_df = _linha_df_pedido(order_id)
    status = _status_any_local(order_id)
    liberar_hoje = _era_agendado_liberar_hoje(order_id, linha_df) or (
        forcar_conferencia and _status_recebido_antecipado(status)
    )
    if _eh_status_imovel(status) and not liberar_hoje:
        return {
            "ok": True,
            "pedido_concluido": True,
            "status_pedido": status,
            "mensagem": f"Pedido já está em '{status}'. Nada a fazer.",
            "erros": [],
        }

    if not _adquirir_lock_finalizacao(order_id, usuario):
        return {
            "ok": False,
            "mensagem": "Não foi possível obter o lock de finalização. Tente de novo em instantes.",
        }

    # liberar_hoje: AM + etiqueta + Conferido; Sheets já foi marcado no recebimento antecipado
    # (retomar sem sheet_pendente não regrava a planilha).
    resultado = _executar_finalizacao_com_lock(
        order_id, usuario, linha_df, forcar_conferencia=forcar_conferencia or liberar_hoje
    )
    if liberar_hoje:
        log_evento(
            usuario,
            "FINALIZACAO_LIBERAR_HOJE",
            (
                "Era agendado no dia da coleta: AnyMarket/etiqueta "
                f"→ {resultado.get('status_pedido')} (Sheets já marcado)."
            ),
            order_id,
        )
    else:
        log_evento(
            usuario,
            "FINALIZACAO_RETOMADA",
            f"Finalização retomada → {resultado.get('status_pedido')}",
            order_id,
        )
    return {
        "ok": bool(resultado.get("ok")),
        "pedido_concluido": True,
        "status_pedido": resultado.get("status_pedido"),
        "mensagem": resultado.get("mensagem") or "Finalização concluída.",
        "erros": resultado.get("erros") or [],
        "tempos": resultado.get("tempos"),
        "impressao_disparada": bool(resultado.get("impressao_disparada")),
    }


def reatentar_sync_sheets_item(order_id: str, line_key: str, usuario: str) -> dict:
    """Reenvia o status do item ao Check B2C. Em sucesso, limpa o erro da fila."""
    from .sheets_erros_service import _parse_line_key

    oid = _norm_id_any(order_id)
    lk = str(line_key or "").strip()
    if not oid or not lk:
        return {"ok": False, "mensagem": "order_id e line_key são obrigatórios."}

    itens = obter_itens_pedido(oid, force_refresh=True)
    item = next((i for i in (itens or []) if str(i.get("line_key") or "") == lk), None)
    if item is None:
        client = get_client()
        row = None
        for chave in _chaves_order_id(oid):
            resp = (
                client.table("conferencia_itens")
                .select("order_id,line_key,sku,seller,quantidade_total,quantidade_conferida,status")
                .eq("order_id", chave)
                .eq("line_key", lk)
                .limit(1)
                .execute()
            )
            if resp.data:
                row = resp.data[0]
                break
        if not row:
            return {"ok": False, "mensagem": "Item não encontrado no pedido."}
        _o, sku, seller = _parse_line_key(lk)
        item = {
            "line_key": lk,
            "sku": sku or str(row.get("sku") or ""),
            "seller": seller or str(row.get("seller") or SELLER_AGUARDANDO),
            "quantity": int(row.get("quantidade_total") or 0),
            "quantidade_conferida": int(row.get("quantidade_conferida") or 0),
            "status": row.get("status") or "",
            "product": {"title": ""},
            "orderItemIds": [str(row.get("item_id") or "")],
        }

    qtd = int(item.get("quantidade_conferida") or 0)
    total = int(item.get("quantity") or 0)
    status_atual = str(item.get("status") or "").strip()
    feito = _sheets_feito()
    parcial = _sheets_parcial()
    status_pedido = _status_any_local(oid)

    if _eh_status_cancelado(status_pedido):
        novo_status = SHEETS_STATUS_CANCELADO
        if qtd <= 0:
            qtd = max(total, 1)
    elif total > 0 and qtd >= total:
        novo_status = feito
    elif qtd > 0:
        novo_status = parcial
    elif status_atual.casefold() in {feito.casefold(), "feito"}:
        novo_status = feito
        qtd = max(qtd, total)
    elif status_atual.casefold() in {parcial.casefold(), "faltando item"}:
        novo_status = parcial
        if qtd <= 0:
            return {
                "ok": False,
                "mensagem": "Item parcial sem quantidade conferida para sincronizar.",
            }
    else:
        return {
            "ok": False,
            "mensagem": "Item sem quantidade conferida para sincronizar na planilha.",
        }

    linha_df = _linha_df_pedido(oid)
    erros = _sincronizar_item_no_sheets(
        oid, item, qtd, novo_status, usuario, linha_df
    )
    if erros:
        return {
            "ok": False,
            "mensagem": erros[0].get("mensagem") or "Falha ao atualizar a planilha.",
            "erros": erros,
        }
    log_evento(
        usuario,
        "SHEETS_RETRY_OK",
        f"Retry Sheets OK ({lk}) → {novo_status}.",
        oid,
    )
    return {
        "ok": True,
        "mensagem": f"Planilha atualizada ({novo_status}).",
        "status_item": novo_status,
    }


def reatentar_finalizacao_erro(order_id: str, usuario: str) -> dict:
    """Retoma a finalização. Em sucesso (ou pedido já fechado), limpa a fila."""
    resultado = retomar_finalizacao_pedido(order_id, usuario)
    erros = list(resultado.get("erros") or [])
    msg = str(resultado.get("mensagem") or "")
    ja_fechado = "já está" in msg.casefold()

    if resultado.get("ok") and not erros:
        if ja_fechado:
            from . import finalizacao_erros_service

            finalizacao_erros_service.resolver_erro_finalizacao(order_id, usuario)
        return {
            "ok": True,
            "mensagem": msg or "Finalização concluída.",
            "status_pedido": resultado.get("status_pedido"),
            "erros": [],
        }

    detalhe = ""
    if erros:
        detalhe = str(erros[0].get("mensagem") or erros[0].get("tipo") or "")
    return {
        "ok": False,
        "mensagem": detalhe or msg or "Falha ao retomar a finalização.",
        "status_pedido": resultado.get("status_pedido"),
        "erros": erros,
    }


def _docs_impressao_pendentes(order_id: str) -> list[str]:

    client = get_client()
    try:
        resp = (
            client.table("logs")
            .select("created_at,tipo_acao,detalhes")
            .eq("pedido_id", str(order_id))
            .in_("tipo_acao", ["ERRO_IMPRESSAO", "IMPRESSAO", "ERROR"])
            .order("created_at", desc=False)
            .limit(200)
            .execute()
        )
    except Exception:
        return ["etiqueta", "danfe"]

    pendente = {"etiqueta": False, "danfe": False}
    viu_erro = False
    for log in resp.data or []:
        tipo = str(log.get("tipo_acao") or "")
        detalhe = str(log.get("detalhes") or "").casefold()
        if tipo == "ERRO_IMPRESSAO" or (
            tipo == "ERROR" and ("impressão" in detalhe or "impressao" in detalhe)
        ):
            marcou = False
            if "impressao_etiqueta" in detalhe or "etiqueta_" in detalhe:
                pendente["etiqueta"] = True
                marcou = True
            if "impressao_danfe" in detalhe or "danfe_" in detalhe:
                pendente["danfe"] = True
                marcou = True
            if not marcou:
                pendente["etiqueta"] = True
                pendente["danfe"] = True
            viu_erro = True
        elif tipo == "IMPRESSAO":
            if "etiqueta_" in detalhe:
                pendente["etiqueta"] = False
            if "danfe_" in detalhe:
                pendente["danfe"] = False

    if not viu_erro:
        return ["etiqueta", "danfe"]
    docs = [d for d, precisa in pendente.items() if precisa]
    return docs or ["etiqueta", "danfe"]

def _so_erros_impressao_no_ag_ajuste(order_id: str) -> bool:

    client = get_client()
    try:
        resp = (
            client.table("logs")
            .select("created_at,tipo_acao")
            .eq("pedido_id", str(order_id))
            .order("created_at", desc=True)
            .limit(80)
            .execute()
        )
    except Exception:
        return False
    for log in resp.data or []:
        tipo = str(log.get("tipo_acao") or "")
        if tipo in {"FINALIZACAO_AG_AJUSTE", "FINALIZACAO_AVISO_IMPRESSAO"}:
            return True
        if tipo.startswith("ERRO_") and tipo != "ERRO_IMPRESSAO":
            return False
        if tipo in {"FINALIZACAO_OK", "FINALIZACAO_AGENDADO", "FINALIZACAO_PENDENTE"}:
            return False
    return False

def reimprimir_pedido(
    order_id: str,
    usuario: str,
    status_hint: str | None = None,
    docs: list[str] | None = None,
    modo: str = "todos",
) -> dict:
    oid = _norm_id_any(order_id)
    status = (status_hint or _status_any_local(oid) or "").strip()
    if status.casefold() not in _status_impressao_livre():
        log_evento(
            usuario,
            "IMPRESSAO_BLOQUEADA",
            f"Status '{status or 'desconhecido'}' não libera impressão.",
            oid,
        )
        return {
            "ok": False,
            "mensagem": (
                f"Impressão não liberada para status '{status or 'desconhecido'}'. "
                "Finalize o pedido ou ajuste IMPRIMIR_EM_PARCIAL no config.ini."
            ),
            "passos": [],
        }
    etiqueta_path = get_external_path(f"downloads/etiqueta_{oid}.pdf")
    danfe_path = get_external_path(f"downloads/danfe_{oid}.pdf")

    modo_norm = (modo or "todos").strip().casefold()
    if modo_norm == "faltantes":
        alvo = _docs_impressao_pendentes(oid)
    elif docs:
        alvo = []
        for d in docs:
            nome = str(d or "").strip().casefold()
            if nome in {"etiqueta", "danfe"} and nome not in alvo:
                alvo.append(nome)
        if not alvo:
            alvo = ["etiqueta", "danfe"]
    else:
        alvo = ["etiqueta", "danfe"]

    passos: list[dict] = []
    quer_eti = "etiqueta" in alvo
    quer_danfe = "danfe" in alvo

    try:
        from . import etiqueta_prefetch

        etiqueta_prefetch.pausar_por_conferencia()
        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures: dict = {}
                if quer_eti:
                    if os.path.exists(etiqueta_path):
                        def _eti_cache(path=etiqueta_path, pedido=oid):
                            anymarket.garantir_etiqueta_magalu_1_pagina(pedido, path)
                            return True, "já em cache local"

                        futures["eti"] = executor.submit(_eti_cache)
                    else:
                        futures["eti"] = executor.submit(
                            anymarket.baixar_etiqueta,
                            oid,
                            etiqueta_path,
                        )
                if quer_danfe:
                    if os.path.exists(danfe_path):
                        futures["danfe"] = executor.submit(lambda: (True, "já em cache local"))
                    else:
                        futures["danfe"] = executor.submit(
                            anymarket.baixar_documento,
                            anymarket.get_link_danfe(oid),
                            danfe_path,
                        )
                eti_ok = danfe_ok = True
                eti_msg = danfe_msg = "não solicitado"
                if "eti" in futures:
                    eti_ok, eti_msg = futures["eti"].result()
                if "danfe" in futures:
                    danfe_ok, danfe_msg = futures["danfe"].result()
        finally:
            etiqueta_prefetch.retomar_apos_conferencia()
    except Exception as e:
        eti_ok = danfe_ok = False
        eti_msg = danfe_msg = str(e)

    if quer_eti:
        passos.append({"etapa": "etiqueta_download", "ok": eti_ok, "mensagem": eti_msg})
    if quer_danfe:
        passos.append({"etapa": "danfe_download", "ok": danfe_ok, "mensagem": danfe_msg})

    if quer_eti and eti_ok:
        anymarket.garantir_etiqueta_magalu_1_pagina(oid, etiqueta_path)
        ok, msg = print_pdf(etiqueta_path, usuario)
        passos.append({"etapa": "etiqueta_impressao", "ok": ok, "mensagem": msg})
    elif quer_eti and not eti_ok:
        passos.append(
            {
                "etapa": "etiqueta_impressao",
                "ok": False,
                "mensagem": "Sem PDF da etiqueta para imprimir.",
            }
        )

    if quer_danfe and danfe_ok:
        ok, msg = print_pdf(danfe_path, usuario)
        passos.append({"etapa": "danfe_impressao", "ok": ok, "mensagem": msg})
    elif quer_danfe and not danfe_ok:
        passos.append(
            {
                "etapa": "danfe_impressao",
                "ok": False,
                "mensagem": "Sem PDF da DANFE para imprimir.",
            }
        )

    ok_geral = all(p["ok"] for p in passos) if passos else False
    status_novo = None
    status_atual = _status_any_local(oid).casefold()
    if ok_geral and _so_erros_impressao_no_ag_ajuste(oid):
        try:
            if status_atual == "ag ajuste":
                _atualizar_status_local(oid, _status_coleta_hoje())
                _salvar_status_no_supabase(oid, _status_coleta_hoje(), exigir_linha=False)
                status_novo = _status_coleta_hoje()
                detalhe_corr = "Reimpressão ok — status AG AJUSTE → Conferido."
            else:
                detalhe_corr = "Reimpressão ok — pendência de impressão resolvida."
            log_evento(usuario, "FINALIZACAO_CORRIGIDA", detalhe_corr, oid)
        except Exception as e:
            log_evento(
                usuario,
                "ERRO_STATUS",
                f"Reimpressão ok, mas falhou ao atualizar status: {e}",
                oid,
            )

    return {
        "ok": ok_geral,
        "passos": passos,
        "docs": alvo,
        "status_pedido": status_novo,
        "mensagem": (
            f"Reimpressão: {', '.join(alvo)}."
            + (f" Status → {status_novo}." if status_novo else "")
        ),
    }

def reimprimir_lote(order_ids: list[str], usuario: str) -> dict:
    sucessos, erros = [], []
    for order_id in order_ids:
        resultado = reimprimir_pedido(order_id, usuario)
        if resultado["ok"]:
            sucessos.append(order_id)
        else:
            erros.append(
                {
                    "order_id": order_id,
                    "mensagem": next(
                        (p["mensagem"] for p in resultado["passos"] if not p["ok"]),
                        "erro desconhecido",
                    ),
                }
            )
    return {"sucessos": sucessos, "erros": erros}


def registrar_despacho_pedido(
    order_id: str,
    usuario: str,
    marketplace: str = "",
    chave_nfe: str = "",
    nf_venda: str = "",
) -> dict:
    """Registra despacho físico de um pedido conferido, mudando status para Ag. Coleta."""
    oid = _norm_id_any(order_id)
    if not oid:
        return {"ok": False, "mensagem": "ID do pedido não informado."}

    atual = (_status_any_local(oid) or "").strip()
    if not atual:
        from . import status_manual_service
        atual = (status_manual_service.ler_status_manual(oid) or "").strip()

    if _eh_status_cancelado(atual):
        return {
            "ok": False,
            "status": "Cancelado",
            "mensagem": f"Pedido {oid} cancelado. Não pode ser despachado!",
        }

    if atual.casefold() in ("ag. coleta", "ag. coleta cd"):
        return {
            "ok": True,
            "ja_bipado": True,
            "id_any": oid,
            "status_any": STATUS_AG_COLETA,
            "mensagem": f"Pedido {oid} já foi bipado para coleta anteriormente.",
        }

    fechados = _status_pedido_fechado()
    if atual.casefold() not in fechados:
        return {
            "ok": False,
            "status": atual,
            "mensagem": f"Pedido {oid} com status '{atual}'. É necessário conferir na bancada antes de despachar.",
        }

    _atualizar_status_local(oid, STATUS_AG_COLETA)
    _salvar_status_no_supabase(oid, STATUS_AG_COLETA, exigir_linha=False)

    agora_iso = datetime.now(timezone.utc).isoformat()
    detalhes_json = json.dumps(
        {
            "marketplace": marketplace,
            "chave_nfe": chave_nfe,
            "nf_venda": nf_venda,
            "despachado_em": agora_iso,
        }
    )
    log_evento(usuario, "DESPACHO", detalhes_json, oid)

    return {
        "ok": True,
        "ja_bipado": False,
        "id_any": oid,
        "status_any": STATUS_AG_COLETA,
        "horario_despacho": agora_iso,
        "operador": usuario,
        "mensagem": f"Pedido {oid} despachado com sucesso!",
    }


def estornar_despacho_pedido(
    order_id: str,
    usuario: str,
    motivo: str = "",
) -> dict:
    """Estorna despacho de um pedido, voltando status para Conferido."""
    oid = _norm_id_any(order_id)
    if not oid:
        return {"ok": False, "mensagem": "ID do pedido não informado."}

    atual = (_status_any_local(oid) or "").strip()
    if _eh_status_cancelado(atual):
        return {
            "ok": False,
            "status": "Cancelado",
            "mensagem": f"Pedido {oid} cancelado. Estorno não permitido.",
        }

    status_destino = _status_coleta_hoje()
    _atualizar_status_local(oid, status_destino)
    _salvar_status_no_supabase(oid, status_destino, exigir_linha=False)

    detalhes_json = json.dumps(
        {
            "status_anterior": atual,
            "status_novo": status_destino,
            "motivo": motivo or "Estorno de despacho solicitado pelo operador",
            "estornado_em": datetime.now(timezone.utc).isoformat(),
        }
    )
    log_evento(usuario, "DESPACHO_ESTORNO", detalhes_json, oid)

    return {
        "ok": True,
        "id_any": oid,
        "status_any": status_destino,
        "mensagem": f"Despacho do pedido {oid} estornado. Status voltou para {status_destino}.",
    }


def consultar_despachos_recentes(limite: int = 500) -> list[dict]:
    """Retorna despachos recentes da tabela logs para alimentar a tela de Despacho."""
    try:
        client = get_client()
        resp = executar_com_retry(
            lambda: client.table("logs")
            .select("id, usuario, tipo_acao, detalhes, pedido_id, created_at")
            .in_("tipo_acao", ["DESPACHO", "DESPACHO_ESTORNO"])
            .order("id", desc=True)
            .limit(limite)
            .execute()
        )
        return resp.data or []
    except Exception as e:
        import logging

        logging.getLogger(__name__).warning("Falha ao consultar logs de despacho: %s", e)
        return []

