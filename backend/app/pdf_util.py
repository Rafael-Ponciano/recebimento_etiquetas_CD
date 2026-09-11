"""Utilitários de PDF (ex.: etiqueta Magalu com NF na 2ª página)."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path


def eh_magalu(mkp: str | None) -> bool:
    chave = str(mkp or "").strip().casefold()
    if not chave:
        return False
    return "magalu" in chave or "magazine" in chave


def manter_apenas_primeira_pagina(pdf_path: str | Path) -> tuple[bool, str]:
    """
    Regrava o PDF mantendo só a página 1.
    No-op se já tiver 1 página (ou 0).
    """
    path = Path(pdf_path)
    if not path.is_file():
        return False, f"PDF não encontrado: {path}"

    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        return False, "Biblioteca pypdf ausente — não foi possível cortar a 2ª página."

    try:
        reader = PdfReader(str(path))
        n = len(reader.pages)
        if n <= 1:
            return True, "já tinha 1 página"

        writer = PdfWriter()
        writer.add_page(reader.pages[0])

        fd, tmp_name = tempfile.mkstemp(suffix=".pdf", prefix="eti_1p_")
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            with tmp.open("wb") as f:
                writer.write(f)
            shutil.move(str(tmp), str(path))
        finally:
            if tmp.exists():
                try:
                    tmp.unlink(missing_ok=True)
                except Exception:
                    pass
        return True, f"reduzido de {n} para 1 página"
    except Exception as e:
        return False, f"Falha ao cortar PDF: {e}"


def reduzir_etiqueta_se_magalu(pdf_path: str | Path, mkp: str | None) -> tuple[bool, str]:
    """Se marketplace for Magalu, remove páginas extras (NF junto da etiqueta)."""
    if not eh_magalu(mkp):
        return True, "não-magalu"
    return manter_apenas_primeira_pagina(pdf_path)
