"""Leitura da base pesada de pedidos no BigQuery (projeto recebimento)."""

from __future__ import annotations

import logging
from functools import lru_cache

import pandas as pd
from google.cloud import bigquery
from google.oauth2 import service_account

from .config import resolve_data_file, settings

logger = logging.getLogger(__name__)

# Colunas BQ → nomes de exibição do app (iguais ao antigo Supabase).
_COLUNAS_BQ_PARA_DISPLAY = {
    "id_any": "id_any",
    "pedido": "Pedido",
    "pedido_any": "Pedido Any",
    "pedido_seller": "Pedido Seller",
    "data_pedido": "Data",
    "data_back": "Data Back",
    "data_coleta": "Data Coleta",
    "cliente": "Cliente",
    "cpf": "CPF",
    "nf_venda": "NF Venda",
    "nf_seller": "NF Seller",
    "ean": "ean",
    "item": "Item",
    "qtnd": "QTND",
    "filial_seller": "filial_seller",
    "mkp": "Mkp",
    "status_any": "Status Any",
    "status_nf": "status_nf",
    "status_pedido": "status_pedido",
}


def _para_datetime_naive(serie: pd.Series) -> pd.Series:
    out = pd.to_datetime(serie, errors="coerce")
    if isinstance(out.dtype, pd.DatetimeTZDtype):
        out = out.dt.tz_convert("America/Sao_Paulo").dt.tz_localize(None)
    return out


def _fmt_hms(td) -> str:
    if td is None or (isinstance(td, float) and pd.isna(td)):
        return ""
    try:
        if pd.isna(td):
            return ""
    except Exception:
        return ""
    try:
        total = int(td.total_seconds())
    except Exception:
        return ""
    sinal = "-" if total < 0 else ""
    total = abs(total)
    h, resto = divmod(total, 3600)
    m, s = divmod(resto, 60)
    return f"{sinal}{h:02d}:{m:02d}:{s:02d}"


def _calcular_tempo_integracao(df: pd.DataFrame) -> pd.DataFrame:
    """data_back − data_any (Data). Se data_back for null, usa agora (BRT).

    Exceção: pedido Cancelado que nunca chegou a integrar (data_back nulo)
    nunca vai ganhar um data_back — não existe evento de integração pra
    gravar. Nesse caso não conta "agora" (senão o tempo cresce pra sempre
    a cada refresh da lista); fica em branco.
    """
    out = df.copy()
    if "Data" not in out.columns:
        out["tempo_integracao"] = ""
        return out
    data_any = _para_datetime_naive(out["Data"])
    if "Data Back" in out.columns:
        data_back = _para_datetime_naive(out["Data Back"])
    else:
        data_back = pd.Series(pd.NaT, index=out.index)
    cancelado = (
        out["Status Any"].fillna("").astype(str).str.contains("cancel", case=False)
        if "Status Any" in out.columns
        else pd.Series(False, index=out.index)
    )
    agora = pd.Timestamp.now(tz="America/Sao_Paulo").tz_localize(None)
    fim = data_back.where(cancelado, data_back.fillna(agora))
    delta = fim - data_any
    out["tempo_integracao"] = delta.map(_fmt_hms)
    out.loc[data_any.isna(), "tempo_integracao"] = ""
    return out


@lru_cache(maxsize=1)
def _client_bq() -> bigquery.Client:
    caminho = resolve_data_file(settings.bq_credentials_file)
    credenciais = service_account.Credentials.from_service_account_file(caminho)
    return bigquery.Client(
        credentials=credenciais,
        project=settings.bq_project or credenciais.project_id,
    )


def ler_pedidos_do_bigquery() -> pd.DataFrame:
    tabela = settings.bq_tabela_pedidos
    sql = f"""
    SELECT
      CAST(id_any AS STRING) AS id_any,
      pedido,
      pedido_any,
      pedido_seller,
      data_pedido,
      data_back,
      data_coleta,
      cliente,
      cpf,
      nf_venda,
      nf_seller,
      ean,
      item,
      qtnd,
      filial_seller,
      mkp,
      status_any,
      status_nf,
      status_pedido
    FROM `{tabela}`
    """
    try:
        client = _client_bq()
        df = client.query(sql).to_dataframe(create_bqstorage_client=False)
    except Exception:
        logger.exception("Falha ao ler pedidos do BigQuery (%s)", tabela)
        raise

    if df is None or df.empty:
        vazio = pd.DataFrame(columns=list(_COLUNAS_BQ_PARA_DISPLAY.values()) + ["tempo_integracao"])
        return vazio

    df = df.rename(columns=_COLUNAS_BQ_PARA_DISPLAY)
    df["id_any"] = df["id_any"].astype(str).str.replace(r"\.0$", "", regex=True)

    for col in ("status_nf", "status_pedido"):
        if col not in df.columns:
            df[col] = ""

    if "filial_seller" in df.columns:
        invalidos = {"", "nan", "none", "null", "padrao", "padrão"}
        serie = df["filial_seller"].astype(str).str.strip()
        mascara = serie.str.casefold().isin(invalidos) | df["filial_seller"].isna()
        df.loc[mascara, "filial_seller"] = "Aguardando Vendedor"

    df = _calcular_tempo_integracao(df)
    return df
