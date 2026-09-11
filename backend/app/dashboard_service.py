from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any

from .historico_service import _carregar_recebimentos_periodo, _texto
from .supabase_client import executar_com_retry, get_client
from .timeutil import bounds_periodo_br, hoje_br

TIPOS_FINALIZACAO_OK = frozenset(
    {
        "FINALIZACAO_OK",
        "FINALIZACAO_AGENDADO",
        "FINALIZACAO_CORRIGIDA",
    }
)
TIPOS_IMPRESSAO = frozenset({"IMPRESSAO"})


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


def _paginar_logs(
    data_ini: date,
    data_fim: date,
    usuario: str | None = None,
    page_size: int = 1000,
) -> list[dict]:
    client = get_client()
    ini, fim = bounds_periodo_br(data_ini, data_fim)
    usuario_termo = (usuario or "").strip()
    linhas: list[dict] = []
    inicio = 0
    while True:
        def _lote(inicio=inicio):
            q = (
                client.table("logs")
                .select("usuario,tipo_acao,pedido_id,created_at")
                .gte("created_at", ini)
                .lte("created_at", fim)
                .order("created_at", desc=False)
                .range(inicio, inicio + page_size - 1)
            )
            if usuario_termo:
                q = q.ilike("usuario", f"%{usuario_termo}%")
            return q.execute()

        resp = executar_com_retry(_lote, tentativas=3, espera_base=0.4)
        lote = resp.data or []
        linhas.extend(lote)
        if len(lote) < page_size:
            break
        inicio += page_size
        if inicio >= 20000:
            break
    return linhas


def _bucket() -> dict[str, Any]:
    return {
        "operador": "",
        "pecas": 0,
        "pedidos_tocados": 0,
        "finalizacoes": 0,
        "impressoes": 0,
        "erros": 0,
        "_pedidos": set(),
    }


def _ts_no_periodo(valor, data_ini: date, data_fim: date) -> bool:
    if not valor:
        # Sem data: se ainda está na fila aberta, conta no período atual.
        return True
    ts = _parse_ts(valor)
    # Compara em data local aproximada (UTC date do timestamp).
    dia = ts.astimezone(timezone.utc).date()
    return data_ini <= dia <= data_fim


def _contar_erros_abertos_filas(
    *,
    data_ini: date,
    data_fim: date,
    usuario: str | None,
) -> dict[str, int]:
    """Usa as filas reais (Sheets + finalização): só o que ainda está aberto."""
    from . import finalizacao_erros_service, sheets_erros_service

    termo = (usuario or "").strip().casefold()
    por_op: dict[str, int] = defaultdict(int)

    try:
        sheets = sheets_erros_service.listar_erros_sheets_pendentes(limite=200)
    except Exception:
        sheets = {"items": []}
    for item in sheets.get("items") or []:
        if not _ts_no_periodo(item.get("data_conferencia"), data_ini, data_fim):
            continue
        op = _texto(item.get("conferido_por")) or "—"
        if termo and termo not in op.casefold():
            continue
        por_op[op] += 1

    # Janela da fila ≥ período pedido (máx. 90 dias para não explodir).
    dias = max(1, (data_fim - data_ini).days + 1)
    dias = min(max(dias, 14), 90)
    try:
        fin = finalizacao_erros_service.listar_erros_finalizacao_pendentes(
            limite=200, dias=dias
        )
    except Exception:
        fin = {"items": []}
    for item in fin.get("items") or []:
        if not _ts_no_periodo(item.get("created_at"), data_ini, data_fim):
            continue
        op = _texto(item.get("usuario")) or "—"
        if termo and termo not in op.casefold():
            continue
        por_op[op] += 1

    return dict(por_op)


def _linha_operador(operador: str) -> dict[str, Any]:
    return {
        "operador": operador,
        "pecas": 0,
        "pedidos_tocados": 0,
        "finalizacoes": 0,
        "impressoes": 0,
        "erros": 0,
    }


def _agregar_no_postgres(
    data_ini: date,
    data_fim: date,
    usuario_termo: str | None,
) -> tuple[list[dict], int] | None:
    """Agregação feita pelo RPC dashboard_agregado (egress ~1 KB).

    Devolve None se o RPC ainda não existe no projeto — aí o chamador cai no
    modo antigo, que baixa as linhas e soma aqui.
    """
    ini, fim = bounds_periodo_br(data_ini, data_fim)
    try:
        resp = executar_com_retry(
            lambda: get_client()
            .rpc(
                "dashboard_agregado",
                {"p_ini": ini, "p_fim": fim, "p_usuario": usuario_termo},
            )
            .execute(),
            tentativas=2,
            espera_base=0.4,
        )
    except Exception as e:
        print(
            "[dashboard] RPC dashboard_agregado indisponível, usando o modo "
            f"antigo (mais egress): {e}. Rode backend/sql/dashboard_agregado.sql "
            "no SQL Editor do Supabase."
        )
        return None

    dados = resp.data
    if isinstance(dados, list):
        dados = dados[0] if dados else None
    if not isinstance(dados, dict):
        return None

    pessoas: list[dict] = []
    for item in dados.get("por_operador") or []:
        linha = _linha_operador(_texto(item.get("operador")) or "—")
        linha["pecas"] = int(item.get("pecas") or 0)
        linha["pedidos_tocados"] = int(item.get("pedidos_tocados") or 0)
        linha["finalizacoes"] = int(item.get("finalizacoes") or 0)
        linha["impressoes"] = int(item.get("impressoes") or 0)
        pessoas.append(linha)
    return pessoas, int(dados.get("pedidos_distintos") or 0)


def _agregar_no_cliente(
    data_ini: date,
    data_fim: date,
    usuario_termo: str | None,
) -> tuple[list[dict], int]:
    """Fallback: baixa as linhas e soma em Python (caro em egress)."""
    recebimentos = _carregar_recebimentos_periodo(data_ini, data_fim, usuario_termo)
    logs = _paginar_logs(data_ini, data_fim, usuario_termo)

    por_pessoa: dict[str, dict[str, Any]] = defaultdict(_bucket)

    for ev in recebimentos:
        op = _texto(ev.get("operador")) or "—"
        b = por_pessoa[op]
        b["operador"] = op
        b["pecas"] += int(ev.get("quantidade") or 0)
        oid = _texto(ev.get("order_id"))
        if oid:
            b["_pedidos"].add(oid)

    for log in logs:
        op = _texto(log.get("usuario")) or "—"
        tipo = _texto(log.get("tipo_acao"))
        b = por_pessoa[op]
        b["operador"] = op
        if tipo in TIPOS_FINALIZACAO_OK:
            b["finalizacoes"] += 1
        elif tipo in TIPOS_IMPRESSAO:
            b["impressoes"] += 1

    pessoas: list[dict] = []
    for b in por_pessoa.values():
        linha = _linha_operador(b["operador"])
        linha["pecas"] = b["pecas"]
        linha["pedidos_tocados"] = len(b["_pedidos"])
        linha["finalizacoes"] = b["finalizacoes"]
        linha["impressoes"] = b["impressoes"]
        pessoas.append(linha)

    pedidos_distintos = len(
        {_texto(e.get("order_id")) for e in recebimentos if _texto(e.get("order_id"))}
    )
    return pessoas, pedidos_distintos


def obter_dashboard(
    data_ini: date | None = None,
    data_fim: date | None = None,
    usuario: str | None = None,
) -> dict:
    if data_ini is None:
        data_ini = hoje_br()
    if data_fim is None:
        data_fim = hoje_br()
    if data_fim < data_ini:
        data_ini, data_fim = data_fim, data_ini

    usuario_termo = (usuario or "").strip() or None

    agregado = _agregar_no_postgres(data_ini, data_fim, usuario_termo)
    if agregado is None:
        agregado = _agregar_no_cliente(data_ini, data_fim, usuario_termo)
    pessoas, pedidos_distintos = agregado

    # Erros vêm das filas (Sheets + finalização), não do Postgres.
    indice = {p["operador"]: p for p in pessoas}
    for op, n in _contar_erros_abertos_filas(
        data_ini=data_ini, data_fim=data_fim, usuario=usuario_termo
    ).items():
        linha = indice.get(op)
        if linha is None:
            linha = _linha_operador(op)
            indice[op] = linha
            pessoas.append(linha)
        linha["erros"] = n

    pessoas.sort(key=lambda p: (-p["pecas"], -p["finalizacoes"], p["operador"].casefold()))

    kpis = {
        "pecas": sum(p["pecas"] for p in pessoas),
        "pedidos": pedidos_distintos,
        "finalizacoes": sum(p["finalizacoes"] for p in pessoas),
        "impressoes": sum(p["impressoes"] for p in pessoas),
        "erros": sum(p["erros"] for p in pessoas),
        "operadores": len(pessoas),
    }

    return {
        "periodo": {"data_ini": data_ini.isoformat(), "data_fim": data_fim.isoformat()},
        "kpis": kpis,
        "por_operador": pessoas,
    }


def obter_resumo_dia_usuario(usuario: str) -> dict[str, Any]:
    from zoneinfo import ZoneInfo

    op = _texto(usuario)
    hoje = datetime.now(ZoneInfo("America/Sao_Paulo")).date()
    dash = obter_dashboard(data_ini=hoje, data_fim=hoje, usuario=op)
    pessoa = next(
        (
            p
            for p in dash["por_operador"]
            if _texto(p.get("operador")).casefold() == op.casefold()
        ),
        None,
    )
    pecas = int((pessoa or {}).get("pecas") or 0)
    finalizacoes = int((pessoa or {}).get("finalizacoes") or 0)
    pedidos = int((pessoa or {}).get("pedidos_tocados") or 0)

    media_ms: float | None = None
    amostras = 0
    try:
        resp = executar_com_retry(
            lambda: get_client()
            .rpc(
                "listar_conferencia_performance",
                {
                    "p_data_ini": hoje.isoformat(),
                    "p_data_fim": hoje.isoformat(),
                    "p_order_id": None,
                    "p_usuario": op,
                    "p_limit": 200,
                },
            )
            .execute(),
            tentativas=3,
            espera_base=0.4,
        )
        items = list(resp.data or [])
        totais = [
            float(i.get("total_ms") or 0)
            for i in items
            if i.get("total_ms") is not None
        ]
        amostras = len(totais)
        if totais:
            media_ms = round(sum(totais) / len(totais), 1)
    except Exception:
        pass

    return {
        "data": hoje.isoformat(),
        "usuario": op,
        "pecas": pecas,
        "pedidos": pedidos,
        "finalizacoes": finalizacoes,
        "media_ms": media_ms,
        "amostras_tempo": amostras,
    }
