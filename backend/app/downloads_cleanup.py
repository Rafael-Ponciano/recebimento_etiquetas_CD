from __future__ import annotations

import re
import threading
import time
from pathlib import Path

from .config import get_external_path, settings

_PADROES = ("etiqueta_*.pdf", "danfe_*.pdf")
_RE_OID = re.compile(r"^(?:etiqueta|danfe)_(.+)\.pdf$", re.IGNORECASE)
# Ainda na fila de conferência → guarda mais tempo.
_STATUS_MANTER = frozenset({"em separação", "a conferir"})
_DIAS_FORA_FILA = 1
_ciclo_ok = False


def _norm_oid(order_id: str) -> str:
    oid = str(order_id or "").strip()
    if oid.endswith(".0") and oid[:-2].lstrip("-").isdigit():
        return oid[:-2]
    return oid


def _pasta() -> Path:
    return Path(get_external_path("downloads"))


def _mapa_status_atual() -> dict[str, str]:
    """id_any → Status Any (casefold). Só lê o cache em memória — nunca dispara BQ."""
    try:
        from . import pedidos_service

        cache = getattr(pedidos_service, "_cache", None) or {}
        df = cache.get("df")
        if df is None or getattr(df, "empty", True):
            return {}
        out: dict[str, str] = {}
        for _, row in df.iterrows():
            oid = _norm_oid(row.get("id_any"))
            if not oid:
                continue
            out[oid] = str(row.get("Status Any") or "").strip().casefold()
        return out
    except Exception:
        return {}


def apagar_pdfs_pedido(order_id: str) -> dict:
    oid = _norm_oid(order_id)
    if not oid:
        return {"apagados": 0, "order_id": oid}

    apagados = 0
    pasta = _pasta()
    for nome in (f"etiqueta_{oid}.pdf", f"danfe_{oid}.pdf"):
        path = pasta / nome
        try:
            if path.is_file():
                path.unlink(missing_ok=True)
                apagados += 1
        except Exception:
            continue

    try:
        from . import etiqueta_prefetch

        etiqueta_prefetch.remover_da_fila(oid)
    except Exception:
        pass

    return {"apagados": apagados, "order_id": oid}


def limpar_downloads_antigos(*, dias: int | None = None) -> dict:
    """
    Em separação / A conferir → só apaga após 7 dias.
    Qualquer outro status (Conferido, Feito, Enviado…) → apaga após 1 dia.
    Pedido sumiu da lista → trata como fora da fila (1 dia).
    """
    retencao_fila = max(1, int(dias if dias is not None else settings.downloads_retencao_dias))
    pasta = _pasta()
    if not pasta.is_dir():
        return {
            "apagados": 0,
            "dias_fora_fila": _DIAS_FORA_FILA,
            "dias_em_fila": retencao_fila,
            "pasta": str(pasta),
        }

    agora = time.time()
    limite_fora = agora - _DIAS_FORA_FILA * 86400
    limite_fila = agora - retencao_fila * 86400
    status_por_oid = _mapa_status_atual()
    # Sem mapa de status (cache vazio / falha): só aplica a regra de 7 dias.
    mapa_ok = bool(status_por_oid)
    apagados = 0

    for padrao in _PADROES:
        for arq in pasta.glob(padrao):
            try:
                if not arq.is_file():
                    continue
                m = _RE_OID.match(arq.name)
                oid = m.group(1) if m else ""
                if not mapa_ok:
                    ainda_em_fila = True
                else:
                    status = status_por_oid.get(oid, "")
                    # Em separação / A conferir → guarda; qualquer outro (ou sumiu) → 1 dia.
                    ainda_em_fila = status in _STATUS_MANTER
                limite = limite_fila if ainda_em_fila else limite_fora
                if arq.stat().st_mtime >= limite:
                    continue
                arq.unlink(missing_ok=True)
                apagados += 1
            except Exception:
                continue

    # Limpa marcadores antigos de versões anteriores.
    for marker in pasta.glob(".conferido_*"):
        try:
            if marker.is_file():
                marker.unlink(missing_ok=True)
        except Exception:
            continue

    return {
        "apagados": apagados,
        "dias_fora_fila": _DIAS_FORA_FILA,
        "dias_em_fila": retencao_fila,
        "pasta": str(pasta),
    }


def iniciar_limpeza_periodica() -> None:
    global _ciclo_ok
    if _ciclo_ok:
        return
    _ciclo_ok = True

    def _loop() -> None:
        while True:
            time.sleep(3600)
            try:
                limpar_downloads_antigos()
            except Exception as e:
                print(f"[downloads] Limpeza periódica ignorada: {e}")

    threading.Thread(target=_loop, daemon=True, name="downloads-limpeza").start()
