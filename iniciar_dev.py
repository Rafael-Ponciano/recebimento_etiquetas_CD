
from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
HOST = "127.0.0.1"
API_PORT = 8080
UI_PORT = 5173
UI_URL = f"http://{HOST}:{UI_PORT}"

def _python_ok(py: Path) -> bool:
    """Confere se o interpretador realmente inicia (venv copiado de outro PC costuma quebrar)."""
    try:
        r = subprocess.run(
            [str(py), "-c", "import sys; raise SystemExit(0)"],
            capture_output=True,
            timeout=15,
            text=True,
        )
        return r.returncode == 0
    except Exception:
        return False


def _python_backend() -> Path:
    if sys.platform == "win32":
        candidato = BACKEND / ".venv" / "Scripts" / "python.exe"
    else:
        candidato = BACKEND / ".venv" / "bin" / "python"

    if candidato.is_file() and _python_ok(candidato):
        return candidato

    if candidato.is_file():
        print(
            "[dev] AVISO: backend\\.venv está quebrado "
            "(aponta para um Python que não existe neste PC)."
        )
        print(f"[dev] Usando temporariamente: {sys.executable}")
        print(
            "[dev] Recrie o venv:\n"
            "      cd backend\n"
            "      rmdir /s /q .venv\n"
            f"      \"{sys.executable}\" -m venv .venv\n"
            "      .venv\\Scripts\\python.exe -m pip install -r requirements.txt"
        )
    return Path(sys.executable)

def _porta_livre(porta: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((HOST, porta)) != 0

def _aguardar_porta(porta: int, timeout: float = 60.0) -> bool:
    inicio = time.time()
    while time.time() - inicio < timeout:
        if not _porta_livre(porta):
            return True
        time.sleep(0.4)
    return False

def _reload_habilitado() -> bool:
    return os.environ.get("DEV_RELOAD", "").strip().lower() in {"1", "true", "yes", "on"}

def _popen_kwargs() -> dict:

    if sys.platform != "win32":
        return {}
    return {
        "creationflags": subprocess.CREATE_NEW_PROCESS_GROUP,
    }

def _iniciar_processos() -> list[subprocess.Popen]:
    processos: list[subprocess.Popen] = []
    py = str(_python_backend())
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"

    env["PYTHONUNBUFFERED"] = "1"

    if _porta_livre(API_PORT):
        reload_on = _reload_habilitado()
        cmd = [
            py,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            HOST,
            "--port",
            str(API_PORT),
        ]
        if reload_on:
            cmd.append("--reload")
            print(f"[dev] Backend → {HOST}:{API_PORT} (reload ON)")
        else:
            print(f"[dev] Backend → {HOST}:{API_PORT} (reload OFF — set DEV_RELOAD=1 para ligar)")
        back = subprocess.Popen(cmd, cwd=str(BACKEND), env=env, **_popen_kwargs())
        processos.append(back)
        # Falha rápida se o Python/uvicorn morrer na largada (venv quebrado, lib faltando).
        time.sleep(1.2)
        if back.poll() is not None:
            print(
                f"[dev] ERRO: backend encerrou na hora (código {back.returncode}).\n"
                "      Confira se o venv está ok e se as deps estão instaladas:\n"
                f"      \"{py}\" -m pip install -r requirements.txt"
            )
    else:
        print(f"[dev] Backend já rodando em {API_PORT}")

    if _porta_livre(UI_PORT):
        print(f"[dev] Frontend → {UI_URL}")
        npm = "npm.cmd" if sys.platform == "win32" else "npm"
        front = subprocess.Popen(
            [npm, "run", "dev", "--", "--host", HOST, "--port", str(UI_PORT)],
            cwd=str(FRONTEND),
            env=env,
            shell=False,
            **_popen_kwargs(),
        )
        processos.append(front)
    else:
        print(f"[dev] Frontend já rodando em {UI_PORT}")

    return processos

def _matar_arvore(pid: int) -> None:
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            check=False,
        )
        return
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass

def _encerrar(processos: list[subprocess.Popen]) -> None:
    for proc in processos:
        if proc.poll() is not None:
            continue
        try:
            _matar_arvore(proc.pid)
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

def main() -> int:
    if not BACKEND.is_dir() or not FRONTEND.is_dir():
        print("Estrutura inválida: esperado backend/ e frontend/ na raiz.")
        return 1

    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
                "PecaAi.ConferenciaCD.App"
            )
        except Exception:
            pass

    processos = _iniciar_processos()
    print("[dev] Aguardando Vite...")
    if not _aguardar_porta(UI_PORT, timeout=90):
        print(f"[dev] Timeout: {UI_URL} não respondeu.")
        _encerrar(processos)
        return 1

    if _porta_livre(API_PORT):
        print("[dev] Aguardando API...")
        if not _aguardar_porta(API_PORT, timeout=30):
            print(f"[dev] Aviso: API em {API_PORT} ainda não respondeu.")

    try:
        import webview
    except ImportError:
        print("[dev] pywebview não encontrado. Abrindo no navegador...")
        import webbrowser

        webbrowser.open(UI_URL)
        print("[dev] Ctrl+C para encerrar backend/frontend.")
        try:
            while True:
                time.sleep(1)
                if any(p.poll() is not None for p in processos):
                    break
        except KeyboardInterrupt:
            pass
        _encerrar(processos)
        return 0

    print(f"[dev] Abrindo app → {UI_URL}")
    sys.path.insert(0, str(ROOT))
    from desktop_window import abrir_janela

    try:
        abrir_janela(UI_URL, titulo="Conferência CD")
    finally:
        print("[dev] Encerrando processos...")
        _encerrar(processos)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
