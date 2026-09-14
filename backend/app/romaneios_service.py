"""Serviço de persistência e consulta dos Romaneios de Expedição."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .supabase_client import get_client, executar_com_retry, log_evento
from .config import DADOS_DIR

ARQUIVO_HISTORICO_LOCAL = Path(DADOS_DIR) / "romaneios_historico.json"
CACHE_ROMANEIOS: dict[str, Any] = {"dados": None, "carregado_em": 0.0}
CACHE_TTL_SEGUNDOS = 30.0


def gerar_codigo_romaneio(marketplace: str) -> str:
    """Gera código único e padronizado: ROM-YYYYMMDD-HHMMSS-MKP."""
    agora = datetime.now(timezone.utc)
    ts_str = agora.strftime("%Y%m%d-%H%M%S")
    mkp_tag = (marketplace or "GERAL").strip().upper()[:8]
    return f"ROM-{ts_str}-{mkp_tag}"


def _salvar_backup_local(romaneio: dict) -> None:
    """Salva cópia local em dados/romaneios_historico.json para redundância."""
    try:
        ARQUIVO_HISTORICO_LOCAL.parent.mkdir(parents=True, exist_ok=True)
        historico: list[dict] = []
        if ARQUIVO_HISTORICO_LOCAL.exists():
            try:
                with open(ARQUIVO_HISTORICO_LOCAL, "r", encoding="utf-8") as f:
                    historico = json.load(f)
            except Exception:
                historico = []

        # Upsert pelo codigo_romaneio
        cod = romaneio.get("codigo_romaneio")
        historico = [r for r in historico if r.get("codigo_romaneio") != cod]
        historico.insert(0, romaneio)
        # Mantém até 500 romaneios locais
        historico = historico[:500]

        with open(ARQUIVO_HISTORICO_LOCAL, "w", encoding="utf-8") as f:
            json.dump(historico, f, ensure_ascii=False, indent=2)
    except Exception as e:
        import logging

        logging.getLogger(__name__).warning("Falha ao salvar backup local de romaneio: %s", e)


def salvar_romaneio(
    codigo_romaneio: str,
    marketplace: str,
    transportadora: str,
    operador: str,
    pedidos: list[dict],
    confirmado_em: str | None = None,
) -> dict:
    """Registra o romaneio completo no Supabase (logs) e backup local."""
    agora_iso = confirmado_em or datetime.now(timezone.utc).isoformat()
    data_coleta = agora_iso[:10]

    payload = {
        "codigo_romaneio": codigo_romaneio,
        "data_coleta": data_coleta,
        "horario_coleta": agora_iso,
        "marketplace": marketplace,
        "transportadora": transportadora,
        "operador": operador,
        "total_pedidos": len(pedidos),
        "pedidos": pedidos,
        "criado_em": agora_iso,
    }

    detalhes_json = json.dumps(payload, ensure_ascii=False)
    log_evento(operador, "ROMANEIO_EXPEDIDO", detalhes_json, codigo_romaneio)
    _salvar_backup_local(payload)

    # Invalida cache em memória
    CACHE_ROMANEIOS["dados"] = None

    return payload


def listar_romaneios(
    dias: int = 30,
    marketplace: str | None = None,
    force_refresh: bool = False,
) -> list[dict]:
    """Retorna lista de romaneios dos últimos N dias."""
    import time

    agora = time.time()
    if (
        not force_refresh
        and CACHE_ROMANEIOS["dados"] is not None
        and (agora - CACHE_ROMANEIOS["carregado_em"]) < CACHE_TTL_SEGUNDOS
    ):
        itens = CACHE_ROMANEIOS["dados"]
    else:
        itens = _buscar_romaneios_supabase(dias=dias)
        CACHE_ROMANEIOS["dados"] = itens
        CACHE_ROMANEIOS["carregado_em"] = agora

    if marketplace:
        mkp_filtro = marketplace.strip().lower()
        itens = [r for r in itens if str(r.get("marketplace") or "").strip().lower() == mkp_filtro]

    return itens


def _buscar_romaneios_supabase(dias: int = 30) -> list[dict]:
    """Busca romaneios gravados na tabela logs do Supabase."""
    romaneios: list[dict] = []
    try:
        client = get_client()
        resp = executar_com_retry(
            lambda: client.table("logs")
            .select("id, usuario, tipo_acao, detalhes, pedido_id, created_at")
            .eq("tipo_acao", "ROMANEIO_EXPEDIDO")
            .order("id", desc=True)
            .limit(300)
            .execute()
        )
        for row in resp.data or []:
            detalhes_str = row.get("detalhes")
            if not detalhes_str:
                continue
            try:
                item = json.loads(detalhes_str)
                if isinstance(item, dict) and "codigo_romaneio" in item:
                    item["log_id"] = row.get("id")
                    if not item.get("horario_coleta"):
                        item["horario_coleta"] = row.get("created_at")
                    romaneios.append(item)
            except Exception:
                continue
    except Exception as e:
        import logging

        logging.getLogger(__name__).warning("Falha ao consultar romaneios do Supabase: %s", e)

    # Se falhou ou veio vazio, tenta ler o backup local
    if not romaneios and ARQUIVO_HISTORICO_LOCAL.exists():
        try:
            with open(ARQUIVO_HISTORICO_LOCAL, "r", encoding="utf-8") as f:
                romaneios = json.load(f)
        except Exception:
            pass

    return romaneios


def obter_romaneio(codigo_romaneio: str) -> dict | None:
    """Busca os dados completos de um romaneio específico."""
    cod = (codigo_romaneio or "").strip()
    if not cod:
        return None

    todos = listar_romaneios(dias=60)
    for r in todos:
        if r.get("codigo_romaneio") == cod:
            return r

    # Busca específica no Supabase por pedido_id
    try:
        client = get_client()
        resp = executar_com_retry(
            lambda: client.table("logs")
            .select("id, usuario, tipo_acao, detalhes, pedido_id, created_at")
            .eq("tipo_acao", "ROMANEIO_EXPEDIDO")
            .eq("pedido_id", cod)
            .limit(1)
            .execute()
        )
        if resp.data:
            detalhes = json.loads(resp.data[0]["detalhes"])
            detalhes["log_id"] = resp.data[0]["id"]
            return detalhes
    except Exception:
        pass

    return None
