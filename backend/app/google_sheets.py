import os
import re
import time
import unicodedata
from functools import lru_cache
import gspread
import pandas as pd
from google.oauth2.service_account import Credentials as ServiceAccountCredentials
from .config import settings, resolve_data_file

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

_sheet_snapshot: dict[tuple[str, str], dict] = {}

@lru_cache
def autenticar_google_sheets():
    path = resolve_data_file(settings.google_credentials_file)
    if not os.path.exists(path):
        raise RuntimeError(f"Credenciais não encontradas: {path}")
    return ServiceAccountCredentials.from_service_account_file(path, scopes=SCOPES)

@lru_cache
def _cliente_gspread():
    return gspread.authorize(autenticar_google_sheets())

def _obter_snapshot_aba(sheet_id: str, aba: str, *, force: bool = False):
    chave = (sheet_id, aba)
    agora = time.time()
    cached = _sheet_snapshot.get(chave)
    if (
        not force
        and cached
        and agora - cached["ts"] < settings.sheets_cache_ttl_seconds
        and cached.get("worksheet") is not None
        and cached.get("values") is not None
    ):
        return cached["worksheet"], cached["values"]

    client = _cliente_gspread()
    worksheet = client.open_by_key(sheet_id).worksheet(aba)
    values = worksheet.get_all_values()
    _sheet_snapshot[chave] = {"ts": agora, "worksheet": worksheet, "values": values}
    return worksheet, values

def _patch_celulas_no_snapshot(
    sheet_id: str,
    aba: str,
    linhas: list[int],
    atualizacoes: dict[int, str],
):
    """atualizacoes: {coluna_1_based: valor}."""
    cached = _sheet_snapshot.get((sheet_id, aba))
    if not cached or not cached.get("values"):
        return
    values = cached["values"]
    max_col = max(atualizacoes) if atualizacoes else 0
    for num_linha in linhas:
        idx = num_linha - 1
        if idx < 0 or idx >= len(values):
            continue
        row = list(values[idx])
        while len(row) < max_col:
            row.append("")
        for col, valor in atualizacoes.items():
            row[col - 1] = valor
        values[idx] = row


def _patch_status_no_snapshot(sheet_id: str, aba: str, linhas: list[int], col_status: int, novo_status: str):
    _patch_celulas_no_snapshot(sheet_id, aba, linhas, {col_status: novo_status})

def _normalizar(valor) -> str:
    texto = unicodedata.normalize("NFKD", str(valor or ""))
    return "".join(c for c in texto if not unicodedata.combining(c)).strip().casefold()

def _id_util(valor) -> bool:
    normalizado = _normalizar(valor)
    return bool(normalizado) and normalizado not in {"nan", "none", "null", ""}

# Trecho mínimo para aceitar "contém" / prefixo. Sem isso, "A" casa com
# qualquer nome que tenha a letra "a" (ex.: SEPARADOR..., sku 8784e00...).
_MIN_TRECHO_NOME = 8

def _sku_final(texto: str) -> str:
    m = re.search(r"\s+-\s+([a-z0-9][a-z0-9./_-]*)\s*$", _normalizar(texto))
    return m.group(1) if m else ""

def _tokens_nome_sheets(texto: str) -> set[str]:
    stop = {
        "para", "com", "sem", "de", "da", "do", "das", "dos", "em",
        "ml", "cm", "mm", "kg", "un", "und", "kit", "pack",
    }
    saida: set[str] = set()
    for t in _normalizar(texto).split():
        if t in stop:
            continue
        if re.fullmatch(r"\d+[a-z]+", t):
            continue
        if t.isdigit():
            if len(t) >= 3:
                saida.add(t)
            continue
        if len(t) >= 3:
            saida.add(t)
    return saida


def _nome_bate(nome_produto: str, nome_planilha: str) -> bool:
    a = _normalizar(nome_produto)
    b = _normalizar(nome_planilha)
    if not a or not b:
        return False
    if a == b:
        return True

    # Substring / prefixo só com ambos os lados longos o bastante.
    if len(a) >= _MIN_TRECHO_NOME and len(b) >= _MIN_TRECHO_NOME:
        if a in b or b in a:
            return True
        if a[:20] in b or b[:20] in a:
            return True

    # Any e Pedidos/Check B2C com nomes comerciais diferentes, mas mesmos sinais
    # (ex.: "cola 793 tekbond - tb3092" × "adesivo … 793 … tekbond").
    inter = _tokens_nome_sheets(a) & _tokens_nome_sheets(b)
    if len(inter) >= 2:
        return True

    grupos = (
        {
            "wd40 spray multiusos desengripa lubrifica 300ml",
            "desengripante wd-40 - wd40",
            "desengripante wd-40 - wd-40",
            "desengripante wd-40 - wd40",
        },
        {
            "desengraxante para limpeza pesada spray 500ml h-7",
            "desengraxante h7 desengraxante - 702358",
            "desengraxante liquido h7 desengraxante - 702358",
        },
        {
            "kit 4 panos multiuso microfibra luxcar 35 cm x 35 cm",
            "toalha de microfibra luxcar - 3900",
        },
        {
            "cola 793 tekbond - tb3092",
            "adesivo instantaneo multiuso 793 20g tekbond",
        },
    )
    for grupo in grupos:
        if any(g in a or a in g for g in grupo) and any(g in b or b in g for g in grupo):
            return True

    # Part number no fim do título (" ... - 2056"). Exige igualdade do SKU,
    # ou que o lado curto da planilha SEJA o próprio part number.
    sku_a = _sku_final(a)
    sku_b = _sku_final(b)
    if sku_a and sku_b and sku_a == sku_b:
        return True
    if sku_a and len(sku_a) >= 4 and b.replace("-", "").replace(" ", "") == sku_a:
        return True
    if sku_b and len(sku_b) >= 4 and a.replace("-", "").replace(" ", "") == sku_b:
        return True
    return False

def _texto_obs_qtd_parcial(
    novo_status: str,
    quantidade_conferida: int,
    quantidade_total: int | None,
) -> str | None:
    """Retorna texto da coluna L, ou None para não alterar, ou '' para limpar.

    Só preenche quando falta quantidade do mesmo produto (parcial).
    Ao concluir (FEITO), limpa a observação residual.
    """
    qtd = int(quantidade_conferida or 0)
    parcial = _normalizar(novo_status) == _normalizar(settings.sheets_status_parcial)
    feito = _normalizar(novo_status) == _normalizar(settings.sheets_status_feito)
    if parcial and qtd > 0:
        if quantidade_total is not None and qtd >= int(quantidade_total):
            return ""
        return f"Recebemos apenas {qtd}"
    if feito:
        return ""
    return None


def _atualizar_status_item_planilha_uma_vez(
    ids_pedido: list[str],
    sku: str,
    seller: str,
    nome_produto: str,
    quantidade_conferida: int,
    novo_status: str,
    nomes_alternativos: list[str] | None = None,
    quantidade_total: int | None = None,
) -> dict:
    _ = sku, seller
    ABA_NAME = settings.sheet_aba_b2c
    COL_ITEM = 7
    COL_STATUS = settings.sheet_col_status
    COL_OBS_QTD = settings.sheet_col_obs_qtd
    COL_PEDIDO_I = 9
    COL_PEDIDO_P = 16

    try:
        worksheet, all_values = _obter_snapshot_aba(settings.sheet_id_b2c, ABA_NAME)

        if not all_values or len(all_values) < 2:
            return {"ok": False, "mensagem": "Aba vazia"}

        ids_validos = {_normalizar(v) for v in ids_pedido if _id_util(v)}
        if not ids_validos:
            return {"ok": False, "mensagem": "Nenhum identificador de pedido válido."}

        # Não incluir o SKU interno da Any (hash) nos candidatos de nome —
        # ele disparava falso positivo (ex.: letra "a" dentro do hash).
        candidatos = [nome_produto, *(nomes_alternativos or [])]
        candidatos = [c for c in candidatos if _normalizar(c)]
        part_candidato = _sku_final(nome_produto)
        for alt in nomes_alternativos or []:
            if not part_candidato:
                part_candidato = _sku_final(alt)

        matches: list[int] = []
        so_pedido: list[int] = []
        for offset, row in enumerate(all_values[1:]):
            num_linha = offset + 2
            valores = list(row) + [""] * max(0, COL_PEDIDO_P - len(row))
            id_i = _normalizar(valores[COL_PEDIDO_I - 1])
            id_p = _normalizar(valores[COL_PEDIDO_P - 1])
            item_g = valores[COL_ITEM - 1]
            item_norm = _normalizar(item_g)

            if id_i not in ids_validos and id_p not in ids_validos:
                continue

            so_pedido.append(num_linha)
            if candidatos:
                if any(_nome_bate(c, item_g) for c in candidatos):
                    matches.append(num_linha)
                    continue
                # Part number do título (" - 2056") vs texto da planilha.
                part_planilha = _sku_final(item_g)
                if (
                    part_candidato
                    and len(part_candidato) >= 4
                    and (
                        part_candidato == part_planilha
                        or item_norm.replace("-", "").replace(" ", "") == part_candidato
                    )
                ):
                    matches.append(num_linha)
                    continue
                if (
                    "h-7" in item_norm
                    and any("702358" in _normalizar(c) or "h7" in _normalizar(c) for c in candidatos)
                ):
                    matches.append(num_linha)
                    continue
                continue
            matches.append(num_linha)

        # Fallback só quando o pedido tem UMA linha na planilha.
        if not matches and len(so_pedido) == 1:
            matches = so_pedido

        if not matches:
            nome = str(nome_produto or "").strip() or "item"
            return {
                "ok": False,
                "mensagem": f"Item não encontrado na planilha: {nome}",
            }

        obs_qtd = _texto_obs_qtd_parcial(
            novo_status, quantidade_conferida, quantidade_total
        )
        updates: list[dict] = []
        patch_cols: dict[int, str] = {COL_STATUS: novo_status}
        for num_linha in matches:
            updates.append(
                {
                    "range": gspread.utils.rowcol_to_a1(num_linha, COL_STATUS),
                    "values": [[novo_status]],
                }
            )
            if obs_qtd is not None:
                updates.append(
                    {
                        "range": gspread.utils.rowcol_to_a1(num_linha, COL_OBS_QTD),
                        "values": [[obs_qtd]],
                    }
                )
                patch_cols[COL_OBS_QTD] = obs_qtd

        worksheet.batch_update(updates, value_input_option="USER_ENTERED")
        _patch_celulas_no_snapshot(
            settings.sheet_id_b2c, ABA_NAME, matches, patch_cols
        )
        detalhe_l = (
            f" · L='{obs_qtd}'" if obs_qtd is not None else ""
        )
        return {
            "ok": True,
            "atualizados": len(matches),
            "mensagem": (
                f"Coluna H atualizada para {novo_status}{detalhe_l} "
                f"em {len(matches)} linha(s): {matches}."
            ),
        }
    except Exception as e:
        _sheet_snapshot.pop((settings.sheet_id_b2c, ABA_NAME), None)
        return {
            "ok": False,
            "atualizados": 0,
            "mensagem": str(e),
            "erro_transitorio": True,
        }


def atualizar_status_item_planilha(
    ids_pedido: list[str],
    sku: str,
    seller: str,
    nome_produto: str,
    quantidade_conferida: int,
    novo_status: str,
    nomes_alternativos: list[str] | None = None,
    quantidade_total: int | None = None,
) -> dict:
    """Atualiza o Check B2C, repetindo apenas falhas técnicas do Google Sheets.

    Erros determinísticos (linha não encontrada, aba vazia ou IDs inválidos)
    retornam imediatamente; repetir essas condições não mudaria o resultado.
    """
    tentativas = 3
    resultado: dict = {}
    for tentativa in range(tentativas):
        resultado = _atualizar_status_item_planilha_uma_vez(
            ids_pedido=ids_pedido,
            sku=sku,
            seller=seller,
            nome_produto=nome_produto,
            quantidade_conferida=quantidade_conferida,
            novo_status=novo_status,
            nomes_alternativos=nomes_alternativos,
            quantidade_total=quantidade_total,
        )
        if resultado.get("ok") or not resultado.get("erro_transitorio"):
            return resultado
        if tentativa < tentativas - 1:
            time.sleep(0.6 * (2**tentativa))

    mensagem = resultado.get("mensagem", "Falha desconhecida no Google Sheets.")
    return {
        **resultado,
        "mensagem": f"{mensagem} (falhou após {tentativas} tentativas)",
    }
