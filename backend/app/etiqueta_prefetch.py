"""
Pré-baixa etiqueta + DANFE em background.

Só NF + Em separação/A conferir + não cancelado.
Ordem: Data Coleta antiga → nova.
Falha = ignora. Conferência tem prioridade (pausa a fila).
"""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import pandas as pd

from . import anymarket
from .config import get_external_path
from .supabase_client import get_client

ADMIN_PREFETCH = "rafael.silva"
TELA_CONFIG = "etiqueta-prefetch"
_MIN_BYTES = 500
STATUS_OK = frozenset({"em separação", "a conferir"})
NF_VAZIA = frozenset({"", "nan", "none", "null", "-", "0", "0.0"})

_lock = threading.Lock()
_pause = threading.Event()
_worker_ok = False
_fila: list[str] = []
_na_fila: set[str] = set()
_atual: str | None = None
_concluidos = 0
_total = 0
_erros = 0


@dataclass(order=True)
class _Item:
    coleta_key: str
    order_id: str = field(compare=False)


def _pdf_ok(path: str) -> bool:
    try:
        return os.path.isfile(path) and os.path.getsize(path) >= _MIN_BYTES
    except OSError:
        return False


def _paths(oid: str) -> tuple[str, str]:
    return (
        get_external_path(f"downloads/etiqueta_{oid}.pdf"),
        get_external_path(f"downloads/danfe_{oid}.pdf"),
    )


def _nf_ok(valor) -> bool:
    if valor is None or (isinstance(valor, float) and pd.isna(valor)):
        return False
    texto = str(valor).strip()
    return bool(texto) and texto.casefold() not in NF_VAZIA


def _cancelado(status_any) -> bool:
    return "cancel" in str(status_any or "").casefold()


def _coleta_key(valor) -> str:
    if valor is None or (isinstance(valor, float) and pd.isna(valor)):
        return "9999-12-31"
    if isinstance(valor, datetime):
        return valor.strftime("%Y-%m-%d")
    texto = str(valor).strip()
    return texto[:10] if texto else "9999-12-31"


def carregar_usuarios_habilitados() -> list[str]:
    try:
        resp = (
            get_client()
            .table("preferencias_usuario")
            .select("preferencias")
            .eq("usuario", ADMIN_PREFETCH)
            .eq("tela", TELA_CONFIG)
            .limit(1)
            .execute()
        )
        if not resp.data:
            return []
        raw = (resp.data[0].get("preferencias") or {}).get("usuarios") or []
        if not isinstance(raw, list):
            return []
        out: list[str] = []
        visto: set[str] = set()
        for u in raw:
            nome = str(u or "").strip()
            chave = nome.casefold()
            if not nome or chave in visto:
                continue
            visto.add(chave)
            out.append(nome)
        return out
    except Exception:
        return []


def salvar_usuarios_habilitados(usuarios: list[str]) -> list[str]:
    limpos: list[str] = []
    visto: set[str] = set()
    for u in usuarios:
        nome = str(u or "").strip()
        chave = nome.casefold()
        if not nome or chave in visto:
            continue
        visto.add(chave)
        limpos.append(nome)
    get_client().table("preferencias_usuario").upsert(
        {
            "usuario": ADMIN_PREFETCH,
            "tela": TELA_CONFIG,
            "preferencias": {"usuarios": limpos},
            "atualizado_em": datetime.utcnow().isoformat() + "Z",
        },
        on_conflict="usuario,tela",
    ).execute()
    return limpos


def usuario_habilitado(usuario: str) -> bool:
    alvo = (usuario or "").strip().casefold()
    if not alvo:
        return False
    return any(u.casefold() == alvo for u in carregar_usuarios_habilitados())


def eh_admin_config(usuario: str) -> bool:
    return (usuario or "").strip().casefold() == ADMIN_PREFETCH.casefold()


def pausar_por_conferencia() -> None:
    _pause.set()


def retomar_apos_conferencia() -> None:
    _pause.clear()


def remover_da_fila(order_id: str) -> None:
    oid = str(order_id or "").strip()
    if not oid:
        return
    with _lock:
        if oid in _na_fila:
            _na_fila.discard(oid)
            _fila[:] = [x for x in _fila if x != oid]


def status(usuario: str | None = None) -> dict[str, Any]:
    with _lock:
        faltando = len(_fila) + (1 if _atual else 0)
        total = max(_total, _concluidos + faltando)
        pct = int(round(100 * _concluidos / total)) if total else 0
        return {
            "habilitado": usuario_habilitado(usuario) if usuario else False,
            "baixando": bool(_atual) and not _pause.is_set(),
            "pausado": _pause.is_set(),
            "pedido_atual": _atual,
            "concluidos": _concluidos,
            "faltando": faltando,
            "total": total,
            "pct": min(100, pct),
            "erros": _erros,
        }


def _baixar(oid: str) -> bool:
    eti, danfe = _paths(oid)
    try:
        falta_eti = not _pdf_ok(eti)
        falta_danfe = not _pdf_ok(danfe)
        if not falta_eti and not falta_danfe:
            return True

        with ThreadPoolExecutor(max_workers=2) as executor:
            f_eti = (
                executor.submit(
                    anymarket.baixar_etiqueta,
                    oid,
                    eti,
                )
                if falta_eti
                else None
            )
            f_danfe = (
                executor.submit(
                    anymarket.baixar_documento,
                    anymarket.get_link_danfe(oid),
                    danfe,
                )
                if falta_danfe
                else None
            )
            if f_eti is not None:
                ok, _ = f_eti.result()
                if not ok or not _pdf_ok(eti):
                    return False
            else:
                anymarket.garantir_etiqueta_magalu_1_pagina(oid, eti)
            if f_danfe is not None:
                ok, _ = f_danfe.result()
                if not ok or not _pdf_ok(danfe):
                    return False
        return True
    except Exception:
        return False


def _loop() -> None:
    global _atual, _concluidos, _erros
    while True:
        if _pause.is_set():
            time.sleep(0.35)
            continue
        with _lock:
            oid = _fila.pop(0) if _fila else None
            if oid:
                _na_fila.discard(oid)
                _atual = oid
        if not oid:
            time.sleep(1.5)
            continue
        while _pause.is_set():
            time.sleep(0.25)
        ok = _baixar(oid)
        with _lock:
            _atual = None
            if ok:
                _concluidos += 1
            else:
                _erros += 1
        time.sleep(0.3)


def _garantir_worker() -> None:
    global _worker_ok
    with _lock:
        if _worker_ok:
            return
        _worker_ok = True
        threading.Thread(target=_loop, daemon=True, name="etiqueta-prefetch").start()


def enfileirar_de_df(df: pd.DataFrame, usuario: str) -> None:
    global _total
    try:
        if not usuario_habilitado(usuario):
            return
        if df is None or getattr(df, "empty", True):
            return
        _garantir_worker()

        itens: list[_Item] = []
        for _, row in df.iterrows():
            status = str(row.get("Status Any") or "").strip().casefold()
            if status not in STATUS_OK or _cancelado(status):
                continue
            if not _nf_ok(row.get("NF Venda")):
                continue
            oid = str(row.get("id_any") or "").strip()
            if not oid:
                continue
            eti, danfe = _paths(oid)
            if _pdf_ok(eti) and _pdf_ok(danfe):
                continue
            itens.append(_Item(_coleta_key(row.get("Data Coleta")), oid))

        itens.sort()
        with _lock:
            for item in itens:
                if item.order_id in _na_fila or item.order_id == _atual:
                    continue
                eti, danfe = _paths(item.order_id)
                if _pdf_ok(eti) and _pdf_ok(danfe):
                    continue
                _na_fila.add(item.order_id)
                _fila.append(item.order_id)
            _total = max(_total, _concluidos + len(_fila) + (1 if _atual else 0))
    except Exception:
        pass
