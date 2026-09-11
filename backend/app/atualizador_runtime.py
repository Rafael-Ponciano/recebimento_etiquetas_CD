from __future__ import annotations

"""
Atualizador embutido no ConferenciaPedidos.exe.

Uso:
  ConferenciaPedidos.exe --atualizar --app-dir DIR --staging DIR --exe-name NOME --pid PID
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
from collections.abc import Callable
from pathlib import Path

PRESERVE_NAMES = frozenset(
    {
        "config.ini",
        "credenciais.json",
        "anymarket_token.json",
        "token_any.json",
        "conferencia_erro.log",
        # recebimento-sa-key / delivery.ico / atualizador.ps1 NÃO ficam na raiz —
        # migração remove duplicatas após o update.
    }
)
PRESERVE_DIRS = frozenset({"downloads", "_update", "logs", "tools"})
CONFIG_NEVER_OVERWRITE = frozenset({"config.ini"})

# Paleta (alinha com o app / UpdateDialog)
BG = "#05070a"
SURFACE = "#12161d"
ELEVATED = "#1a2029"
BORDER = "#262e3a"
BORDER_SOFT = "#1e2530"
TEXT = "#eef2f7"
MUTED = "#9aa6b5"
FAINT = "#6b7585"
GREEN = "#3ecf8e"
GREEN_SOFT = "#7ee7b5"
GREEN_DIM = "#163528"
AMBER = "#f2a63c"
RED = "#ef5a5a"
VOID = "#0a0d11"


def _log(app_dir: Path, msg: str) -> None:
    linha = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"
    try:
        log = app_dir / "_update" / "atualizador.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as f:
            f.write(linha)
    except Exception:
        pass
    try:
        (app_dir / "_update" / "STATUS.txt").write_text(msg, encoding="utf-8")
    except Exception:
        pass


def _msgbox(titulo: str, texto: str, erro: bool = False) -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, texto, titulo, 0x10 if erro else 0x40)
    except Exception:
        pass


def _unblock_tree(pasta: Path) -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        delete_file = ctypes.windll.kernel32.DeleteFileW
        for arquivo in pasta.rglob("*"):
            if not arquivo.is_file():
                continue
            try:
                delete_file(str(arquivo.resolve()) + ":Zone.Identifier")
            except Exception:
                pass
    except Exception:
        pass


def _pid_existe(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        if sys.platform == "win32":
            import ctypes

            handle = ctypes.windll.kernel32.OpenProcess(0x00100000, False, pid)
            if not handle:
                return False
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _aguardar_pid(pid: int, timeout_s: float = 90.0) -> None:
    if pid <= 0:
        return
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if not _pid_existe(pid):
            return
        time.sleep(0.35)


def _encerrar_pid(pid: int) -> None:
    """Encerra só o PID do app antigo — nunca o próprio atualizador."""
    if pid <= 0 or pid == os.getpid():
        return
    if not _pid_existe(pid):
        return
    if sys.platform != "win32":
        return
    try:
        subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            check=False,
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
        )
    except Exception:
        pass


def _encerrar_irmaos(app_dir: Path, exe_name: str, pid_principal: int) -> None:
    """Mata instâncias do exe na pasta do app, sem tocar no atualizador (staging)."""
    if sys.platform != "win32":
        return
    base = exe_name.lower().removesuffix(".exe")
    app_resolved = str(app_dir.resolve()).rstrip("\\/").lower()
    update_dir = str((app_dir / "_update").resolve()).rstrip("\\/").lower()
    meu = os.getpid()
    try:
        # Path do app: ...\ConferenciaPedidos.exe
        # Atualizador: ...\_update\staging\...\ConferenciaPedidos.exe  → ignorar
        ps = (
            f"$app='{app_resolved.replace(chr(39), chr(39)+chr(39))}';"
            f"$upd='{update_dir.replace(chr(39), chr(39)+chr(39))}';"
            f"Get-Process -Name '{base}' -ErrorAction SilentlyContinue |"
            f" Where-Object {{"
            f"  $_.Id -ne {meu} -and $_.Id -ne {int(pid_principal)} -and $_.Path -and"
            f"  ($p=$_.Path.ToLower()) -and $p.StartsWith($app) -and -not $p.StartsWith($upd)"
            f"}} | ForEach-Object {{"
            f"  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue"
            f"}}"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            check=False,
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
        )
    except Exception:
        pass
    # Reforço no PID principal (já tratado, mas garante)
    _encerrar_pid(pid_principal)
def _is_acesso_negado(exc: BaseException) -> bool:
    if isinstance(exc, PermissionError):
        return True
    if isinstance(exc, OSError):
        return getattr(exc, "winerror", None) == 5 or getattr(exc, "errno", None) in (
            13,
            11,
        )
    return False


def _remover_com_retry(path: Path, tentativas: int = 15) -> None:
    """Remove arquivo/pasta com retry — comum com .pyd ainda mapeado no Windows."""
    if not path.exists():
        return
    ultimo: BaseException | None = None
    for i in range(tentativas):
        try:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
            return
        except Exception as e:
            ultimo = e
            if not path.exists():
                return
            if not _is_acesso_negado(e) and i > 2:
                break
            time.sleep(0.35 + i * 0.15)
    if path.exists() and ultimo:
        raise ultimo


def _mover_de_lado(path: Path) -> Path | None:
    """Renomeia destino travado (Windows permite rename de DLL em uso)."""
    if not path.exists():
        return None
    for i in range(8):
        aside = path.with_name(f"{path.name}.__old_{os.getpid()}_{int(time.time())}_{i}")
        try:
            path.rename(aside)
            return aside
        except Exception:
            time.sleep(0.25 + i * 0.1)
    return None


def _limpar_restos_old(app_dir: Path) -> None:
    for item in list(app_dir.iterdir()):
        nome = item.name
        if not (
            nome.startswith("_old_")
            or ".__old_" in nome
            or nome.endswith(".old")
            or ".old_" in nome
        ):
            continue
        try:
            _remover_com_retry(item, tentativas=3)
        except Exception:
            pass


def _substituir_item(src: Path, dest: Path) -> None:
    """Troca destino: rename-aside (DLL lock) → delete com retry → copia."""
    if dest.exists():
        aside = _mover_de_lado(dest)
        if aside is not None:
            try:
                _remover_com_retry(aside)
            except Exception:
                # Deixa .__old_* para limpeza na próxima execução.
                pass
        else:
            _remover_com_retry(dest)
    if src.is_dir():
        shutil.copytree(src, dest)
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)


def _mesclar_pasta_config(src: Path, dest: Path) -> None:
    """Atualiza config.example.ini; nunca sobrescreve config.ini do usuário."""
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        alvo = dest / item.name
        if item.is_dir():
            _mesclar_pasta_config(item, alvo)
            continue
        if item.name in CONFIG_NEVER_OVERWRITE and alvo.is_file():
            continue
        if alvo.exists():
            if alvo.is_dir():
                shutil.rmtree(alvo, ignore_errors=True)
            else:
                try:
                    alvo.unlink()
                except Exception:
                    aside = _mover_de_lado(alvo)
                    if aside is not None:
                        try:
                            _remover_com_retry(aside)
                        except Exception:
                            pass
        if item.is_dir():
            shutil.copytree(item, alvo)
        else:
            shutil.copy2(item, alvo)


def _mesclar_pasta_dados(src: Path, dest: Path) -> None:
    """Copia arquivos novos em dados/; nunca sobrescreve existentes."""
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        alvo = dest / item.name
        if item.is_dir():
            _mesclar_pasta_dados(item, alvo)
            continue
        if alvo.exists():
            continue
        shutil.copy2(item, alvo)


def _copiar_payload(staging: Path, app_dir: Path, on_progress) -> None:
    itens = [p for p in staging.iterdir()]
    total = max(1, len(itens))
    for i, item in enumerate(itens, start=1):
        nome = item.name
        if nome in PRESERVE_DIRS or nome in PRESERVE_NAMES:
            continue
        on_progress(f"Copiando {nome}", 38 + int((i / total) * 48))
        if nome == "config" and item.is_dir():
            _mesclar_pasta_config(item, app_dir / "config")
            continue
        if nome == "dados" and item.is_dir():
            _mesclar_pasta_dados(item, app_dir / "dados")
            continue
        if nome == "tools" and item.is_dir():
            _mesclar_pasta_dados(item, app_dir / "tools")  # só adiciona, não sobrescreve
            continue
        _substituir_item(item, app_dir / nome)


def _limpar_cache_webview_pos_update(app_dir: Path) -> None:
    """Garante UI nova no próximo open — sem o operador apagar pasta manualmente."""
    alvos: list[Path] = [
        app_dir / "_webview_data",
        app_dir / "_ui_cache_version.txt",
        app_dir / "_webview_data" / "_ui_cache_version.txt",
    ]
    appdata = os.environ.get("APPDATA") or ""
    local = os.environ.get("LOCALAPPDATA") or ""
    if appdata:
        alvos.append(Path(appdata) / "pywebview")
    if local:
        alvos.append(Path(local) / "pywebview")
        alvos.append(Path(local) / "ConferenciaPedidos")

    for alvo in alvos:
        try:
            if alvo.is_file():
                alvo.unlink(missing_ok=True)
            elif alvo.is_dir():
                shutil.rmtree(alvo, ignore_errors=True)
        except Exception:
            pass


def _html_atualizador(from_v: str, to_v: str) -> str:
    from_js = json.dumps(from_v or "")
    to_js = json.dumps(to_v or "")
    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  :root {{
    --bg: #05070a;
    --surface: #12161d;
    --elevated: #1a2029;
    --border: #262e3a;
    --border-soft: #1e2530;
    --text: #eef2f7;
    --muted: #9aa6b5;
    --faint: #6b7585;
    --green: #3ecf8e;
    --green-soft: #7ee7b5;
    --green-dim: rgba(62,207,142,.12);
    --amber: #f2a63c;
    --red: #ef5a5a;
    --void: #0a0d11;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  html, body {{
    width: 100%; height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: "Segoe UI", system-ui, sans-serif;
    overflow: hidden;
    user-select: none;
  }}
  body {{
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(ellipse 80% 50% at 50% -10%, rgba(62,207,142,.14) 0%, transparent 55%),
      radial-gradient(ellipse 60% 40% at 95% 110%, rgba(242,166,60,.10) 0%, transparent 50%),
      var(--bg);
  }}
  .shell {{
    width: min(420px, 94vw);
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: 0 24px 80px rgba(0,0,0,.65);
    overflow: hidden;
  }}
  .hazard {{
    height: 6px;
    background: repeating-linear-gradient(
      -45deg, var(--amber), var(--amber) 8px, var(--void) 8px, var(--void) 16px
    );
  }}
  .drag {{
    padding: 18px 20px 8px;
    cursor: default;
  }}
  .head {{ display: flex; gap: 12px; align-items: flex-start; }}
  .logo {{
    width: 44px; height: 44px; border-radius: 12px;
    border: 1px solid var(--border); background: var(--elevated);
    position: relative; flex-shrink: 0;
  }}
  .logo .box {{
    position: absolute; inset: 8px 8px 8px 8px;
    border-radius: 6px; background: var(--amber);
  }}
  .logo .lid {{
    position: absolute; left: 50%; top: 6px; transform: translateX(-50%);
    width: 16px; height: 8px; border-radius: 3px; background: var(--green);
  }}
  .brand {{
    font-family: Consolas, "IBM Plex Mono", monospace;
    font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
    color: var(--faint);
  }}
  h1 {{
    margin-top: 4px;
    font-size: 17px; font-weight: 600; letter-spacing: -.02em;
  }}
  .versions {{
    display: flex; align-items: center; gap: 8px;
    margin: 12px 20px 0;
  }}
  .chip {{
    font-family: Consolas, monospace;
    font-size: 12px;
    border-radius: 8px;
    border: 1px solid var(--border-soft);
    background: var(--elevated);
    color: var(--muted);
    padding: 5px 10px;
  }}
  .chip.to {{
    border-color: rgba(62,207,142,.35);
    background: var(--green-dim);
    color: var(--green);
    box-shadow: 0 0 12px rgba(62,207,142,.18);
  }}
  .arrow {{ color: var(--faint); font-size: 13px; }}
  .body {{ padding: 16px 20px 8px; }}
  .prog-top {{
    display: flex; justify-content: space-between; gap: 12px; align-items: flex-end;
  }}
  .msg {{ font-size: 13px; line-height: 1.35; color: var(--text); }}
  .sub {{ margin-top: 3px; font-size: 11px; color: var(--faint); }}
  .pct {{
    font-family: Consolas, monospace;
    font-size: 22px; font-weight: 600;
    color: var(--green); tabular-nums;
  }}
  .pct.err {{ color: var(--red); }}
  .track {{
    margin-top: 10px;
    height: 12px; border-radius: 999px;
    background: var(--elevated);
    border: 1px solid var(--border-soft);
    overflow: hidden;
  }}
  .fill {{
    height: 100%; width: 0%;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(62,207,142,.85), var(--green), var(--green-soft));
    box-shadow: 0 0 16px rgba(62,207,142,.45);
    transition: width .25s ease;
  }}
  .fill.err {{
    background: var(--red);
    box-shadow: none;
  }}
  .steps {{ list-style: none; margin: 14px 0 4px; display: grid; gap: 6px; }}
  .step {{
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border-radius: 10px;
  }}
  .step.active {{ background: var(--green-dim); }}
  .step.error {{ background: rgba(239,90,90,.12); }}
  .badge {{
    width: 22px; height: 22px; border-radius: 999px;
    display: grid; place-items: center;
    font-size: 10px; font-weight: 700;
    border: 1.5px solid var(--border);
    color: var(--faint);
    flex-shrink: 0;
  }}
  .step.done .badge {{
    background: var(--green); border-color: var(--green); color: var(--void);
  }}
  .step.active .badge {{
    border-color: var(--green); color: var(--green); background: transparent;
  }}
  .step.error .badge {{
    background: var(--red); border-color: var(--red); color: #fff;
  }}
  .step-label {{ font-size: 12px; font-weight: 600; color: var(--faint); }}
  .step.done .step-label, .step.active .step-label {{ color: var(--text); }}
  .step.error .step-label {{ color: var(--red); }}
  .step-hint {{ font-size: 11px; color: var(--faint); margin-top: 1px; }}
  .spin {{
    margin-left: auto; width: 14px; height: 14px;
    border: 2px solid rgba(62,207,142,.25);
    border-top-color: var(--green);
    border-radius: 50%;
    animation: spin .7s linear infinite;
    opacity: 0;
  }}
  .step.active .spin {{ opacity: 1; }}
  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
  .foot {{
    margin-top: 12px;
    border-top: 1px solid var(--border-soft);
    background: rgba(10,13,17,.45);
    padding: 12px 20px;
    font-size: 11px; color: var(--faint);
  }}
</style>
</head>
<body>
  <div class="shell">
    <div class="hazard pywebview-drag-region"></div>
    <div class="drag pywebview-drag-region">
      <div class="head">
        <div class="logo"><div class="box"></div><div class="lid"></div></div>
        <div>
          <div class="brand">Conferência CD · Recebimento</div>
          <h1 id="title">Instalando atualização</h1>
        </div>
      </div>
    </div>
    <div class="versions" id="versions" hidden>
      <span class="chip" id="fromChip"></span>
      <span class="arrow">→</span>
      <span class="chip to" id="toChip"></span>
    </div>
    <div class="body">
      <div class="prog-top">
        <div>
          <div class="msg" id="msg">Preparando instalação…</div>
          <div class="sub" id="sub">Não feche esta janela</div>
        </div>
        <div class="pct" id="pct">0%</div>
      </div>
      <div class="track"><div class="fill" id="fill"></div></div>
      <ol class="steps" id="steps">
        <li class="step" data-i="0">
          <div class="badge">1</div>
          <div><div class="step-label">Fechar app</div><div class="step-hint">Encerra a versão antiga</div></div>
          <div class="spin"></div>
        </li>
        <li class="step" data-i="1">
          <div class="badge">2</div>
          <div><div class="step-label">Backup</div><div class="step-hint">Guarda cópia de segurança</div></div>
          <div class="spin"></div>
        </li>
        <li class="step" data-i="2">
          <div class="badge">3</div>
          <div><div class="step-label">Instalar</div><div class="step-hint">Copia os arquivos novos</div></div>
          <div class="spin"></div>
        </li>
        <li class="step" data-i="3">
          <div class="badge">4</div>
          <div><div class="step-label">Abrir</div><div class="step-hint">Reinicia o Conferência CD</div></div>
          <div class="spin"></div>
        </li>
      </ol>
    </div>
    <div class="foot">Backup automático · config.ini e credenciais preservados</div>
  </div>
<script>
  const FROM = {from_js};
  const TO = {to_js};
  (function initVersions() {{
    if (FROM || TO) {{
      document.getElementById('versions').hidden = false;
      document.getElementById('fromChip').textContent = FROM ? ('v' + FROM) : '—';
      document.getElementById('toChip').textContent = TO ? ('v' + TO) : '—';
    }}
  }})();

  window.__update = function(state) {{
    const msg = state.msg || '';
    const pct = Math.max(0, Math.min(100, Number(state.pct) || 0));
    const step = Number(state.step) || 0;
    const erro = !!state.erro;
    const title = document.getElementById('title');
    const msgEl = document.getElementById('msg');
    const sub = document.getElementById('sub');
    const pctEl = document.getElementById('pct');
    const fill = document.getElementById('fill');
    msgEl.textContent = msg;
    pctEl.textContent = pct + '%';
    pctEl.classList.toggle('err', erro);
    fill.style.width = pct + '%';
    fill.classList.toggle('err', erro);
    if (erro) {{
      title.textContent = 'Falha na instalação';
      sub.textContent = 'Restaurando backup e reabrindo o app…';
    }} else if (pct >= 100) {{
      title.textContent = 'Quase pronto';
      sub.textContent = 'Pronto — reabrindo o Conferência CD';
    }} else if (pct >= 90) {{
      title.textContent = 'Instalando atualização';
      sub.textContent = 'Quase lá…';
    }} else {{
      title.textContent = 'Instalando atualização';
      sub.textContent = 'Não feche esta janela';
    }}
    document.querySelectorAll('.step').forEach((el) => {{
      const i = Number(el.dataset.i);
      el.classList.remove('done', 'active', 'error');
      const badge = el.querySelector('.badge');
      if (erro && i === step) {{
        el.classList.add('error');
        badge.textContent = '!';
      }} else if (!erro && i < step) {{
        el.classList.add('done');
        badge.textContent = '✓';
      }} else if (!erro && i === step) {{
        el.classList.add('active');
        badge.textContent = String(i + 1);
      }} else {{
        badge.textContent = String(i + 1);
      }}
    }});
  }};
  window.__update({{ msg: 'Preparando instalação…', pct: 0, step: 0, erro: false }});
</script>
</body>
</html>"""


class UpdaterUI:
    """Janela do instalador via pywebview (HTML) — mesmo visual do modal do app."""

    def __init__(self, *, from_version: str = "", to_version: str = "") -> None:
        self._from_v = (from_version or "").strip()
        self._to_v = (to_version or "").strip()
        self._window = None
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._closed = False
        self._last = {"msg": "Preparando instalação…", "pct": 0, "step": 0, "erro": False}

    def run(self, work: Callable[[], None]) -> None:
        """UI no thread principal (webview.start); instalação em thread de fundo."""

        def _boot() -> None:
            if not self._ready.wait(timeout=25):
                pass
            try:
                work()
            finally:
                self.close()

        if not self._prepare_window():
            # Sem pywebview: instala sem janela (continua via log/STATUS.txt).
            work()
            return

        worker = threading.Thread(target=_boot, daemon=True, name="updater-work")
        worker.start()
        self._run_webview_loop()
        worker.join(timeout=600)

    def _prepare_window(self) -> bool:
        try:
            import webview
        except Exception:
            return False

        html = _html_atualizador(self._from_v, self._to_v)
        try:
            self._window = webview.create_window(
                "Conferência CD · Instalando",
                html=html,
                width=460,
                height=560,
                resizable=False,
                background_color=BG,
                on_top=True,
                frameless=True,
                easy_drag=True,
                shadow=True,
                text_select=False,
            )
        except TypeError:
            # pywebview antigo sem frameless/shadow/etc.
            try:
                self._window = webview.create_window(
                    "Conferência CD · Instalando",
                    html=html,
                    width=460,
                    height=560,
                    resizable=False,
                    background_color=BG,
                    on_top=True,
                )
            except Exception:
                self._window = None
                return False

        def _on_loaded() -> None:
            self._ready.set()
            try:
                self.set(**self._last)
            except Exception:
                pass

        try:
            self._window.events.loaded += _on_loaded
        except Exception:
            threading.Timer(0.8, _on_loaded).start()
        return True

    def _run_webview_loop(self) -> None:
        import webview

        try:
            webview.start(gui="edgechromium")
            return
        except Exception:
            pass
        try:
            webview.start()
        except Exception:
            # Loop falhou depois de criar a janela — segue sem UI.
            self._ready.set()
            self._window = None

    def set(self, msg: str, pct: int, step: int = 0, *, erro: bool = False) -> None:
        pct = max(0, min(100, int(pct)))
        payload = {
            "msg": str(msg or ""),
            "pct": pct,
            "step": int(step),
            "erro": bool(erro),
        }
        with self._lock:
            self._last = payload
            window = self._window
        if window is None or self._closed:
            return
        try:
            js = "window.__update && window.__update(" + json.dumps(payload, ensure_ascii=False) + ")"
            window.evaluate_js(js)
        except Exception:
            pass

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            window = self._window
            self._window = None
        if window is None:
            return
        try:
            window.destroy()
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--atualizar", action="store_true")
    parser.add_argument("--app-dir", required=True)
    parser.add_argument("--staging", required=True)
    parser.add_argument("--exe-name", required=True)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--from-version", default="")
    parser.add_argument("--to-version", default="")
    args, _ = parser.parse_known_args(argv)

    app_dir = Path(args.app_dir).resolve()
    staging = Path(args.staging).resolve()
    exe_name = args.exe_name
    pid = int(args.pid)

    _log(app_dir, "Atualizador iniciado")
    ui = UpdaterUI(
        from_version=str(args.from_version or ""),
        to_version=str(args.to_version or ""),
    )
    exit_code = {"value": 1}

    def set_ui(msg: str, pct: int, step: int = 0, *, erro: bool = False) -> None:
        _log(app_dir, f"{pct}% {msg}")
        ui.set(msg, pct, step, erro=erro)

    def work() -> None:
        try:
            if not staging.is_dir():
                raise RuntimeError(f"Staging não encontrado: {staging}")

            set_ui("Aguardando o app fechar…", 8, 0)
            _aguardar_pid(pid)
            time.sleep(0.8)
            if _pid_existe(pid):
                set_ui("Encerrando o app antigo…", 14, 0)
                _encerrar_pid(pid)
                _aguardar_pid(pid, timeout_s=30.0)
            set_ui("Liberando arquivos em uso…", 18, 0)
            _encerrar_irmaos(app_dir, exe_name, pid)
            time.sleep(1.2)
            _limpar_restos_old(app_dir)

            backup = app_dir / "_update" / "backup_prev"
            if backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
            backup.mkdir(parents=True, exist_ok=True)
            set_ui("Criando backup de segurança…", 28, 1)
            for item in app_dir.iterdir():
                if item.name in PRESERVE_DIRS or item.name in PRESERVE_NAMES:
                    continue
                if item.name.startswith("_old_") or item.name.endswith(".old"):
                    continue
                try:
                    dest = backup / item.name
                    if item.is_dir():
                        shutil.copytree(item, dest, dirs_exist_ok=True)
                    else:
                        shutil.copy2(item, dest)
                except Exception:
                    pass

            set_ui("Instalando arquivos novos…", 40, 2)
            _copiar_payload(staging, app_dir, lambda m, p: set_ui(m, p, 2))

            set_ui("Atualizando config.ini…", 86, 2)
            try:
                from app.config import migrar_layout_legado
                from app.config_merge import garantir_arquivo_se_ausente, merge_config_ini

                for m in migrar_layout_legado(app_dir):
                    _log(app_dir, f"layout: {m}")

                user_ini = app_dir / "config" / "config.ini"
                if not user_ini.is_file():
                    user_ini = app_dir / "config.ini"
                exemplo = app_dir / "config" / "config.example.ini"
                if not exemplo.is_file():
                    for cand in (
                        app_dir / "config.example.ini",
                        staging / "config" / "config.example.ini",
                        staging / "config.example.ini",
                    ):
                        if cand.is_file():
                            exemplo = cand
                            break

                adicionadas = merge_config_ini(
                    user_ini,
                    exemplo if exemplo.is_file() else None,
                )
                if adicionadas:
                    _log(app_dir, "config.ini +chaves: " + ", ".join(adicionadas))

                dados_dir = app_dir / "dados"
                dados_dir.mkdir(parents=True, exist_ok=True)
                key_src = staging / "dados" / "recebimento-sa-key.json"
                if not key_src.is_file():
                    key_src = staging / "recebimento-sa-key.json"
                if garantir_arquivo_se_ausente(
                    dados_dir,
                    "recebimento-sa-key.json",
                    key_src,
                ):
                    _log(app_dir, "dados/recebimento-sa-key.json instalada")
                # Limpa duplicatas antigas na raiz (key, ico, example, etc.)
                for m in migrar_layout_legado(app_dir):
                    _log(app_dir, f"layout: {m}")
            except Exception as e:
                _log(app_dir, f"Aviso merge config: {e}")

            set_ui("Desbloqueando arquivos…", 90, 3)
            _unblock_tree(app_dir)

            exe_path = app_dir / exe_name
            if not exe_path.is_file():
                raise RuntimeError(f"Executável não encontrado: {exe_path}")

            set_ui("Limpando temporários…", 94, 3)
            for nome in ("staging", "package.zip"):
                alvo = app_dir / "_update" / nome
                try:
                    if alvo.is_dir():
                        shutil.rmtree(alvo, ignore_errors=True)
                    elif alvo.is_file():
                        alvo.unlink(missing_ok=True)
                except Exception:
                    pass

            set_ui("Atualizando interface (cache)…", 97, 3)
            _limpar_cache_webview_pos_update(app_dir)

            set_ui("Concluído! Abrindo o app…", 100, 3)
            time.sleep(0.55)
            flags = 0
            if sys.platform == "win32":
                flags = (
                    getattr(subprocess, "DETACHED_PROCESS", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                    | 0x01000000
                )
            subprocess.Popen(
                [str(exe_path)],
                cwd=str(app_dir),
                close_fds=True,
                creationflags=flags,
            )
            _log(app_dir, "OK — app reaberto")
            exit_code["value"] = 0
            time.sleep(0.35)
        except Exception as e:
            tb = traceback.format_exc()
            _log(app_dir, f"ERRO: {e}\n{tb}")
            try:
                set_ui(f"Erro: {e}", 100, 2, erro=True)
                time.sleep(1.2)
            except Exception:
                pass
            try:
                backup = app_dir / "_update" / "backup_prev"
                if backup.is_dir():
                    for item in backup.iterdir():
                        dest = app_dir / item.name
                        try:
                            if dest.exists():
                                if dest.is_dir():
                                    shutil.rmtree(dest, ignore_errors=True)
                                else:
                                    dest.unlink(missing_ok=True)
                            if item.is_dir():
                                shutil.copytree(item, dest)
                            else:
                                shutil.copy2(item, dest)
                        except Exception:
                            pass
            except Exception:
                pass
            _msgbox(
                "Conferência CD — Atualização",
                f"Falha ao atualizar.\n\n{e}\n\nLog:\n{app_dir / '_update' / 'atualizador.log'}",
                erro=True,
            )
            try:
                exe_path = app_dir / exe_name
                if exe_path.is_file():
                    subprocess.Popen([str(exe_path)], cwd=str(app_dir), close_fds=True)
            except Exception:
                pass
            exit_code["value"] = 1

    ui.run(work)
    return int(exit_code["value"])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
