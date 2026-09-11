import re
import subprocess
import sys
from pathlib import Path

from .config import settings
from .supabase_client import log_evento


def _extrair_pedido_do_nome(nome_arquivo: str):
    match = re.search(r"(?:etiqueta|danfe)_(.+)\.pdf", nome_arquivo, re.IGNORECASE)
    return match.group(1) if match else None


def _flags_sem_janela() -> dict:
    """Evita o flash da janela preta do gswin64c.exe no Windows."""
    if sys.platform != "win32":
        return {}
    # CREATE_NO_WINDOW = 0x08000000
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {"creationflags": flags, "startupinfo": startupinfo}


def print_pdf(pdf_path: str, usuario: str = "sistema"):
    pdf = Path(pdf_path)
    order_id = _extrair_pedido_do_nome(pdf.name)

    if not settings.ghostscript_path:

        return False, "Caminho do Ghostscript não configurado no config.ini."

    if not pdf.exists():
        return False, f"Arquivo não encontrado: {pdf}"

    try:
        args = [
            settings.ghostscript_path, "-dPrinted", "-dBATCH", "-dNOPAUSE", "-dNOSAFER",
            "-sDEVICE=mswinpr2", "-r203", "-dTextAlphaBits=1", "-dGraphicsAlphaBits=1",
            f"-sOutputFile=%printer%{settings.printer_name}", str(pdf),
        ]
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=settings.print_timeout_seconds,
            **_flags_sem_janela(),
        )

        if result.returncode == 0:
            log_evento(usuario, "IMPRESSAO", f"Impressão enviada: {pdf.name}", order_id)
            return True, f"Impressão enviada: {pdf.name}"
        elif result.returncode == 1:
            if "Processing pages" in result.stdout or "Page 1" in result.stdout:
                log_evento(usuario, "IMPRESSAO", f"Impressão enviada: {pdf.name}", order_id)
                return True, f"Impressão enviada: {pdf.name}"
            return False, f"Erro na impressão: {pdf.name}"

        return False, f"Erro código {result.returncode}"
    except Exception as e:
        return False, f"Erro: {e}"
