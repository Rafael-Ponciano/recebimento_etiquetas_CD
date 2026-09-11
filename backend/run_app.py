
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path


def _exe_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def _log_path() -> Path:
    logs = _exe_dir() / "logs"
    try:
        logs.mkdir(parents=True, exist_ok=True)
        return logs / "conferencia_erro.log"
    except Exception:
        return _exe_dir() / "conferencia_erro.log"


def _log(msg: str) -> None:
    linha = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"
    try:
        with open(_log_path(), "a", encoding="utf-8") as f:
            f.write(linha)
    except Exception:
        pass
    try:
        print(msg)
    except Exception:
        pass


def _mensagem_windows(titulo: str, texto: str) -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, texto, titulo, 0x10)
    except Exception:
        pass


def _flags_subprocess_oculto() -> dict:
    if sys.platform != "win32":
        return {}
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return {"creationflags": flags}


def _porta_aceita_conexao(host: str, port: int) -> bool:
    alvo = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    try:
        with socket.create_connection((alvo, port), timeout=0.35):
            return True
    except OSError:
        return False


def _pids_escutando_porta(port: int) -> list[int]:
    """PIDs em LISTENING na porta TCP (Windows)."""
    if sys.platform != "win32":
        return []
    try:
        out = subprocess.check_output(
            ["netstat", "-ano", "-p", "tcp"],
            text=True,
            stderr=subprocess.DEVNULL,
            **_flags_subprocess_oculto(),
        )
    except Exception:
        return []

    meu = os.getpid()
    pids: set[int] = set()
    sufixo = f":{port}"
    for linha in out.splitlines():
        partes = linha.split()
        if len(partes) < 5 or partes[0].upper() != "TCP":
            continue
        local = partes[1]
        estado = partes[3].upper()
        if not local.endswith(sufixo):
            continue
        # 0.0.0.0:8080 / 127.0.0.1:8080 / [::]:8080
        if estado != "LISTENING":
            continue
        try:
            pid = int(partes[-1])
        except ValueError:
            continue
        if pid > 0 and pid != meu:
            pids.add(pid)
    return sorted(pids)


def _encerrar_pid(pid: int) -> None:
    if sys.platform != "win32" or pid <= 0 or pid == os.getpid():
        return
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            **_flags_subprocess_oculto(),
        )
    except Exception:
        pass


def _liberar_porta(host: str, port: int, *, espera_s: float = 3.0) -> None:
    """
    Fecha instância anterior ainda escutando a porta (fecho rápido + reopen).
    Sem isso o splash fica em 'Carregando serviços…' até o timeout.
    """
    pids = _pids_escutando_porta(port)
    if pids:
        _log(f"Porta {port} ocupada pelos PIDs {pids}; encerrando…")
        for pid in pids:
            _encerrar_pid(pid)

    prazo = time.time() + max(0.5, espera_s)
    while time.time() < prazo:
        if not _porta_aceita_conexao(host, port) and not _pids_escutando_porta(port):
            return
        # Ainda LISTENING: tenta matar de novo
        for pid in _pids_escutando_porta(port):
            _encerrar_pid(pid)
        time.sleep(0.15)


def _aguardar_servidor(
    url: str,
    timeout_s: float = 10.0,
    on_tick=None,
) -> bool:
    deadline = time.time() + timeout_s
    started = time.time()
    health = url.rstrip("/") + "/api/health"
    while time.time() < deadline:
        if callable(on_tick):
            try:
                on_tick(int(time.time() - started))
            except Exception:
                pass
        try:
            with urllib.request.urlopen(health, timeout=0.5) as resp:
                if 200 <= getattr(resp, "status", 200) < 300:
                    return True
        except Exception:
            pass
        time.sleep(0.12)
    return False


def _run_server(host: str, port: int, erro_holder: list, app=None, server_holder: dict | None = None) -> None:
    try:
        # PyInstaller windowed (console=False): stdout/stderr são None e o uvicorn quebra no isatty().
        if sys.stdout is None:
            sys.stdout = open(os.devnull, "w", encoding="utf-8")
        if sys.stderr is None:
            sys.stderr = open(os.devnull, "w", encoding="utf-8")

        import uvicorn

        if app is None:
            from app.main import app as app

        config = uvicorn.Config(
            app,
            host=host,
            port=port,
            log_level="warning",
            access_log=False,
        )
        server = uvicorn.Server(config)
        if server_holder is not None:
            server_holder["server"] = server
        server.run()
    except Exception as e:
        erro_holder.append(e)
        _log("Falha no servidor:\n" + traceback.format_exc())


if getattr(sys, "frozen", False):
    _bundle = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    for p in (_bundle, Path(sys.executable).resolve().parent):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))
    # Evita AttributeError isatty() com console=False (uvicorn/logging).
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
else:
    ROOT = Path(__file__).resolve().parents[1]
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))

# Referência explícita para o PyInstaller incluir o atualizador no bundle.
try:
    import app.atualizador_runtime  # noqa: F401
except Exception:
    pass

if __name__ == "__main__":
    # Modo atualizador (processo separado). NÃO alterar sys.path aqui —
    # isso quebrava o import frozen (ModuleNotFoundError).
    if "--atualizar" in sys.argv:
        def _boot_atualizar() -> int:
            # Log imediato no app-dir (antes de qualquer import pesado).
            app_dir = None
            try:
                if "--app-dir" in sys.argv:
                    i = sys.argv.index("--app-dir")
                    app_dir = Path(sys.argv[i + 1])
                    (app_dir / "_update").mkdir(parents=True, exist_ok=True)
                    with (app_dir / "_update" / "atualizador.log").open(
                        "a", encoding="utf-8"
                    ) as f:
                        f.write(
                            f"{time.strftime('%Y-%m-%d %H:%M:%S')} boot --atualizar\n"
                        )
            except Exception:
                pass

            atualizar_main = None
            try:
                from app.atualizador_runtime import main as atualizar_main
            except Exception as e1:
                try:
                    import importlib.util

                    candidatos = []
                    meipass = getattr(sys, "_MEIPASS", None)
                    if meipass:
                        candidatos.append(Path(meipass) / "atualizador_runtime.py")
                        candidatos.append(
                            Path(meipass) / "app" / "atualizador_runtime.py"
                        )
                    aqui = Path(__file__).resolve().parent
                    candidatos.append(aqui / "app" / "atualizador_runtime.py")
                    candidatos.append(aqui / "atualizador_runtime.py")
                    for path in candidatos:
                        if path.is_file():
                            spec = importlib.util.spec_from_file_location(
                                "atualizador_runtime", path
                            )
                            if spec and spec.loader:
                                mod = importlib.util.module_from_spec(spec)
                                spec.loader.exec_module(mod)
                                atualizar_main = mod.main
                                break
                    if atualizar_main is None:
                        raise RuntimeError(
                            f"atualizador_runtime não encontrado. Import: {e1}"
                        )
                except Exception as e2:
                    msg = f"Falha ao carregar atualizador:\n{e1}\n{e2}"
                    try:
                        if app_dir:
                            with (app_dir / "_update" / "atualizador.log").open(
                                "a", encoding="utf-8"
                            ) as f:
                                f.write(msg + "\n" + traceback.format_exc() + "\n")
                    except Exception:
                        pass
                    _log(msg)
                    _mensagem_windows(
                        "Conferência CD — Atualização",
                        f"Falha no atualizador.\n\n{e2}\n\nLog em _update\\atualizador.log",
                    )
                    return 1

            return int(atualizar_main(sys.argv[1:]) or 0)

        raise SystemExit(_boot_atualizar())

    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
                "PecaAi.ConferenciaCD.App"
            )
        except Exception:
            pass

    # Feedback imediato ao clicar no .exe (antes do FastAPI/WebView).
    splash_nativo_fechar = None
    try:
        from desktop_window import splash_nativo_fechar as _fechar_splash
        from desktop_window import splash_nativo_mostrar

        splash_nativo_fechar = _fechar_splash
        splash_nativo_mostrar()
    except Exception:
        splash_nativo_fechar = None

    try:
        from app.config import (
            app_base_dir,
            config_example_path,
            config_ini_path,
            migrar_layout_legado,
        )

        movidos = migrar_layout_legado(app_base_dir())
        for m in movidos:
            _log(f"layout: {m}")

        cfg = Path(config_ini_path())
        if not cfg.is_file():
            try:
                if splash_nativo_fechar:
                    splash_nativo_fechar()
            except Exception:
                pass
            msg = (
                "Arquivo config.ini não encontrado.\n\n"
                f"Esperado em: {cfg}\n"
                f"Pasta do app: {_exe_dir()}\n\n"
                "Copie config\\config.example.ini → config\\config.ini e preencha "
                "SUPABASE_KEY (service_role), AnyMarket, impressora, etc."
            )
            _log(msg)
            _mensagem_windows("Conferência CD", msg)
            sys.exit(1)

        try:
            from app.config_merge import merge_config_ini

            exemplo = Path(config_example_path())
            adicionadas = merge_config_ini(cfg, exemplo if exemplo.is_file() else None)
            if adicionadas:
                _log("config.ini mesclado (+" + ", ".join(adicionadas) + ")")
        except Exception as e:
            _log(f"Aviso ao mesclar config.ini: {e}")

        from app.config import settings

        try:
            _ = settings.supabase_key
        except Exception as e:
            try:
                if splash_nativo_fechar:
                    splash_nativo_fechar()
            except Exception:
                pass
            msg = (
                f"Configuração inválida no config.ini:\n{e}\n\n"
                "Verifique SUPABASE_URL e SUPABASE_KEY (service_role)."
            )
            _log(msg)
            _mensagem_windows("Conferência CD", msg)
            sys.exit(1)

        host = settings.app_host or "127.0.0.1"
        port = int(settings.app_port or 8080)
        base_url = f"http://{host}:{port}"

        # Fecha app anterior que ainda segura a porta (reabrir rápido).
        _liberar_porta(host, port)

        # Import pesado AQUI (splash nativo ainda visível) — o health sobe em <1s depois.
        _log("Importando aplicação…")
        from app.main import app as fastapi_app

        erros: list = []
        server_holder: dict = {}
        server_thread = threading.Thread(
            target=_run_server,
            args=(host, port, erros, fastapi_app, server_holder),
            daemon=True,
        )
        server_thread.start()

        # Abre a janela na hora (splash). O FastAPI sobe em paralelo.
        from desktop_window import abrir_janela

        def _servidor_pronto(on_tick=None) -> bool:
            _log(f"Aguardando servidor em {base_url} ...")
            if _aguardar_servidor(base_url, timeout_s=6.0, on_tick=on_tick):
                return True
            # Porta ainda presa / bind falhou: mata listener e sobe de novo (orçamento ≤10s).
            _log(f"Health lento — liberando porta {port} e reiniciando servidor")
            antigo = server_holder.get("server")
            if antigo is not None:
                antigo.should_exit = True
            _liberar_porta(host, port, espera_s=1.5)
            erros.clear()
            server_holder.clear()
            threading.Thread(
                target=_run_server,
                args=(host, port, erros, fastapi_app, server_holder),
                daemon=True,
            ).start()
            return _aguardar_servidor(base_url, timeout_s=4.0, on_tick=on_tick)

        def _falha_servidor() -> None:
            detalhe = ""
            if erros:
                detalhe = f"\n\nErro: {erros[0]}"
            else:
                detalhe = (
                    "\n\nPossíveis causas:\n"
                    f"- Porta {port} já em uso (feche o app em desenvolvimento / outra instância)\n"
                    "- Firewall bloqueando localhost\n"
                    f"- Veja o arquivo: {_log_path()}"
                )
            msg = f"O servidor local não iniciou em {base_url}.{detalhe}"
            _log(msg)
            _mensagem_windows("Conferência CD", msg)

        try:
            abrir_janela(
                base_url,
                aguardar_pronto=_servidor_pronto,
                on_falha=_falha_servidor,
            )
        finally:
            srv = server_holder.get("server")
            if srv is not None:
                try:
                    srv.should_exit = True
                except Exception:
                    pass
            # Saída rápida para liberar a porta no fechar→abrir.
            time.sleep(0.1)
    except Exception:
        try:
            if splash_nativo_fechar:
                splash_nativo_fechar()
        except Exception:
            pass
        _log("Falha fatal:\n" + traceback.format_exc())
        _mensagem_windows(
            "Conferência CD",
            f"Falha ao iniciar o aplicativo.\n\nDetalhes em:\n{_log_path()}",
        )
        sys.exit(1)
