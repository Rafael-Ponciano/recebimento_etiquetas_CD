from __future__ import annotations

import os
import shutil
import sys
import threading
import time
import webbrowser
from collections.abc import Callable
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent
BG_COLOR = "#0a0d11"
TITLE = "Conferência CD"
WIDTH = 1440
HEIGHT = 900
MIN_SIZE = (1100, 720)

APP_USER_MODEL_ID = "PecaAi.ConferenciaCD.App"
UI_CACHE_MARKER = "_webview_data/_ui_cache_version.txt"
WEBVIEW_DATA_DIR = "_webview_data"


class DesktopApi:
    """API JS → Python (pywebview). Usada p.ex. para Salvar como… nativo."""

    def __init__(self) -> None:
        self._window = None

    def bind_window(self, window) -> None:
        self._window = window

    def salvar_arquivo(self, nome_arquivo: str, conteudo_b64: str) -> dict:
        import base64

        try:
            import webview
        except Exception as e:
            return {"ok": False, "cancelado": False, "erro": f"pywebview indisponível: {e}"}

        window = self._window
        if window is None:
            return {"ok": False, "cancelado": False, "erro": "Janela indisponível."}

        nome = str(nome_arquivo or "pedidos.xlsx").strip() or "pedidos.xlsx"
        if not nome.lower().endswith(".xlsx"):
            nome = f"{nome}.xlsx"

        try:
            resultado = window.create_file_dialog(
                webview.SAVE_DIALOG,
                directory="",
                save_filename=nome,
                file_types=("Planilha Excel (*.xlsx)", "Todos os arquivos (*.*)"),
            )
        except Exception as e:
            return {"ok": False, "cancelado": False, "erro": f"Falha no diálogo: {e}"}

        if not resultado:
            return {"ok": False, "cancelado": True}

        caminho = resultado[0] if isinstance(resultado, (list, tuple)) else str(resultado)
        if not str(caminho).lower().endswith(".xlsx"):
            caminho = f"{caminho}.xlsx"

        try:
            Path(caminho).write_bytes(base64.b64decode(conteudo_b64))
        except Exception as e:
            return {"ok": False, "cancelado": False, "erro": f"Falha ao gravar: {e}"}

        return {"ok": True, "caminho": str(caminho)}


# HTML leve (sem rede) — aparece antes do FastAPI/uvicorn ficarem prontos.
SPLASH_HTML = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Conferência CD</title>
<style>
  :root {
    --void: #0a0d11;
    --panel: #12171e;
    --text: #e8eef6;
    --muted: #8b98a8;
    --green: #3ecf8e;
    --red: #ef5a5a;
    --border: rgba(255,255,255,.08);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    background: var(--void);
    color: var(--text);
    font-family: "Segoe UI", Tahoma, sans-serif;
  }
  body {
    display: grid;
    place-items: center;
    background:
      radial-gradient(900px 480px at 50% -10%, rgba(62,207,142,.14), transparent 55%),
      radial-gradient(700px 400px at 80% 110%, rgba(80,140,255,.08), transparent 50%),
      var(--void);
  }
  .card {
    width: min(420px, 92vw);
    padding: 36px 32px 28px;
    border-radius: 18px;
    border: 1px solid var(--border);
    background: linear-gradient(180deg, rgba(18,23,30,.96), rgba(10,13,17,.92));
    text-align: center;
    box-shadow: 0 24px 60px rgba(0,0,0,.45);
  }
  .mark {
    width: 52px; height: 52px; margin: 0 auto 18px;
    border-radius: 14px;
    background: linear-gradient(145deg, #1a2430, #0f141a);
    border: 1px solid var(--border);
    display: grid; place-items: center;
    position: relative;
  }
  .mark::before {
    content: "";
    width: 22px; height: 16px;
    border: 2.5px solid var(--green);
    border-radius: 3px 3px 5px 5px;
    box-shadow: 0 -5px 0 -2.5px var(--green);
  }
  .brand {
    font-size: 13px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 8px;
  }
  h1 { font-size: 22px; font-weight: 700; letter-spacing: -.02em; }
  #msg {
    margin-top: 10px; font-size: 14px; color: var(--muted); min-height: 1.3em;
  }
  #msg.erro { color: var(--red); }
  .spin {
    width: 28px; height: 28px; margin: 22px auto 0;
    border: 2.5px solid rgba(62,207,142,.22);
    border-top-color: var(--green);
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  .spin.hide { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ver { margin-top: 18px; font-size: 11px; color: rgba(139,152,168,.7); }
</style>
</head>
<body>
  <div class="card">
    <div class="mark" aria-hidden="true"></div>
    <div class="brand">Recebimento</div>
    <h1>Conferência CD</h1>
    <p id="msg">Iniciando…</p>
    <div class="spin" id="spin"></div>
    <div class="ver" id="ver"></div>
  </div>
  <script>
    window.__splashSet = function(texto, erro) {
      var m = document.getElementById('msg');
      var s = document.getElementById('spin');
      if (!m) return;
      m.textContent = texto || '';
      m.className = erro ? 'erro' : '';
      if (s) s.className = erro ? 'spin hide' : 'spin';
    };
  </script>
</body>
</html>
"""


def _exe_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return ROOT


def _ler_versao() -> str:
    for path in (
        _exe_dir() / "VERSION",
        ROOT / "VERSION",
        Path(getattr(sys, "_MEIPASS", "")) / "VERSION",
    ):
        try:
            if path.is_file():
                texto = path.read_text(encoding="utf-8").strip().splitlines()[0].strip()
                if texto:
                    return texto
        except Exception:
            continue
    return os.environ.get("APP_VERSION", "dev").strip() or "dev"


def _pastas_cache_webview() -> list[Path]:
    """Locais onde o Edge/WebView2 guarda cache do pywebview."""
    pastas: list[Path] = []
    exe = _exe_dir()
    pastas.append(exe / WEBVIEW_DATA_DIR)

    appdata = os.environ.get("APPDATA") or ""
    local = os.environ.get("LOCALAPPDATA") or ""
    if appdata:
        pastas.append(Path(appdata) / "pywebview")
    if local:
        pastas.append(Path(local) / "pywebview")
        pastas.append(Path(local) / "ConferenciaPedidos")

    # Subpastas de cache HTTP (mais agressivo se a pasta raiz não puder ser apagada)
    extras: list[Path] = []
    for base in list(pastas):
        for nome in ("EBWebView", "Default"):
            extras.append(base / nome)
        extras.append(base / "EBWebView" / "Default" / "Cache")
        extras.append(base / "EBWebView" / "Default" / "Code Cache")
        extras.append(base / "EBWebView" / "Default" / "GPUCache")
        extras.append(base / "EBWebView" / "Default" / "Service Worker")
    return pastas + extras


def _rmtree_silencioso(pasta: Path) -> None:
    if not pasta.exists():
        return
    try:
        shutil.rmtree(pasta, ignore_errors=True)
    except Exception:
        pass
    # Fallback arquivo a arquivo
    if pasta.exists():
        try:
            for item in pasta.rglob("*"):
                try:
                    if item.is_file() or item.is_symlink():
                        item.unlink(missing_ok=True)
                except Exception:
                    pass
            shutil.rmtree(pasta, ignore_errors=True)
        except Exception:
            pass


def limpar_cache_webview(*, forcar: bool = False) -> bool:
    """
    Limpa só caches leves do WebView2 quando a versão muda.
    Não apaga a pasta inteira (demora e trava o boot).
    """
    versao = _ler_versao()
    marker = _exe_dir() / UI_CACHE_MARKER
    legado = _exe_dir() / "_ui_cache_version.txt"
    anterior = ""
    try:
        if marker.is_file():
            anterior = marker.read_text(encoding="utf-8").strip()
        elif legado.is_file():
            anterior = legado.read_text(encoding="utf-8").strip()
    except Exception:
        anterior = ""

    if not forcar and anterior == versao:
        return False

    # Marcador primeiro: se a limpeza for interrompida, não repete no próximo boot.
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(versao + "\n", encoding="utf-8")
        if legado.is_file():
            legado.unlink(missing_ok=True)
    except Exception:
        pass

    nomes_cache = (
        "Cache",
        "Code Cache",
        "GPUCache",
        "Service Worker",
        "GrShaderCache",
        "ShaderCache",
    )
    prazo = time.time() + 2.0
    for base in _pastas_cache_webview():
        if time.time() > prazo:
            break
        try:
            if not base.exists():
                continue
            # Caminhos típicos: …/EBWebView/Default/<cache>
            for pasta in base.rglob("*"):
                if time.time() > prazo:
                    break
                try:
                    if pasta.is_dir() and pasta.name in nomes_cache:
                        _rmtree_silencioso(pasta)
                except Exception:
                    pass
        except Exception:
            pass
    return True


def _url_com_versao(url: str, versao: str) -> str:
    """Força o WebView a tratar cada versão como documento novo."""
    partes = urlsplit(url)
    query = dict(parse_qsl(partes.query, keep_blank_values=True))
    query["v"] = versao
    return urlunsplit(
        (partes.scheme, partes.netloc, partes.path or "/", urlencode(query), partes.fragment)
    )


def _icone() -> str | None:
    candidatos = [
        ROOT / "frontend" / "public" / "delivery.ico",
        ROOT / "static" / "delivery.ico",
        ROOT / "delivery.ico",
        ROOT / "frontend" / "public" / "logo.ico",
    ]
    try:
        if getattr(sys, "frozen", False):
            exe_dir = Path(sys.executable).resolve().parent
            candidatos = [
                exe_dir / "static" / "delivery.ico",
                exe_dir / "delivery.ico",
                exe_dir / "logo.ico",
                *candidatos,
            ]
    except Exception:
        pass

    for candidato in candidatos:
        if candidato.is_file():
            return str(candidato.resolve())
    return None


def _definir_app_id_windows() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except Exception:
        pass


def _aplicar_icone_hwnd(titulo: str, caminho_ico: str) -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        user32 = ctypes.windll.user32
        WM_SETICON = 0x0080
        IMAGE_ICON = 1
        LR_LOADFROMFILE = 0x0010
        LR_DEFAULTSIZE = 0x0040

        hwnd = user32.FindWindowW(None, titulo)
        if not hwnd:
            return

        hicon = user32.LoadImageW(
            0,
            str(caminho_ico),
            IMAGE_ICON,
            0,
            0,
            LR_LOADFROMFILE | LR_DEFAULTSIZE,
        )
        if not hicon:
            return
        user32.SendMessageW(hwnd, WM_SETICON, 1, hicon)
        user32.SendMessageW(hwnd, WM_SETICON, 0, hicon)
    except Exception:
        pass


def _bundle_dirs() -> list[Path]:
    dirs: list[Path] = []
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            dirs.append(Path(meipass))
        dirs.append(Path(sys.executable).resolve().parent)
    dirs.append(ROOT)
    vistos: set[str] = set()
    unicos: list[Path] = []
    for d in dirs:
        key = str(d.resolve()) if d.exists() else str(d)
        if key not in vistos:
            vistos.add(key)
            unicos.append(d)
    return unicos


def _desbloquear_arquivo(caminho: Path) -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        zone = str(caminho) + ":Zone.Identifier"
        ctypes.windll.kernel32.DeleteFileW(zone)
    except Exception:
        pass


def _preparar_pythonnet() -> None:
    if sys.platform != "win32":
        return

    for base in _bundle_dirs():
        candidatos = [
            base / "pythonnet",
            base / "_internal" / "pythonnet",
        ]
        for pasta in candidatos:
            if not pasta.is_dir():
                continue
            for dll in pasta.rglob("*.dll"):
                _desbloquear_arquivo(dll)


def _abrir_navegador(url: str) -> None:
    webbrowser.open(url)


# Splash Win32 leve (aparece antes do Edge/WebView2 carregar).
_splash_nativo_hwnd = 0
_splash_nativo_thread: threading.Thread | None = None
_splash_nativo_stop = threading.Event()


def splash_nativo_mostrar(*, titulo: str | None = None) -> None:
    """Janela nativa imediata — sem pywebview/Edge. Fechar com splash_nativo_fechar()."""
    global _splash_nativo_hwnd, _splash_nativo_thread
    if sys.platform != "win32":
        return
    if _splash_nativo_thread and _splash_nativo_thread.is_alive():
        return

    _splash_nativo_stop.clear()
    titulo_txt = titulo or TITLE

    def _run() -> None:
        global _splash_nativo_hwnd
        try:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.windll.user32
            gdi32 = ctypes.windll.gdi32
            kernel32 = ctypes.windll.kernel32

            WNDPROC = ctypes.WINFUNCTYPE(
                ctypes.c_ssize_t,
                wintypes.HWND,
                wintypes.UINT,
                wintypes.WPARAM,
                wintypes.LPARAM,
            )

            class WNDCLASS(ctypes.Structure):
                _fields_ = [
                    ("style", wintypes.UINT),
                    ("lpfnWndProc", WNDPROC),
                    ("cbClsExtra", ctypes.c_int),
                    ("cbWndExtra", ctypes.c_int),
                    ("hInstance", wintypes.HINSTANCE),
                    ("hIcon", wintypes.HICON),
                    ("hCursor", wintypes.HANDLE),
                    ("hbrBackground", wintypes.HBRUSH),
                    ("lpszMenuName", wintypes.LPCWSTR),
                    ("lpszClassName", wintypes.LPCWSTR),
                ]

            class PAINTSTRUCT(ctypes.Structure):
                _fields_ = [
                    ("hdc", wintypes.HDC),
                    ("fErase", wintypes.BOOL),
                    ("rcPaint", wintypes.RECT),
                    ("fRestore", wintypes.BOOL),
                    ("fIncUpdate", wintypes.BOOL),
                    ("rgbReserved", ctypes.c_byte * 32),
                ]

            class MSG(ctypes.Structure):
                _fields_ = [
                    ("hwnd", wintypes.HWND),
                    ("message", wintypes.UINT),
                    ("wParam", wintypes.WPARAM),
                    ("lParam", wintypes.LPARAM),
                    ("time", wintypes.DWORD),
                    ("pt", wintypes.POINT),
                ]

            WM_DESTROY = 0x0002
            WM_PAINT = 0x000F
            WM_CLOSE = 0x0010
            WM_ERASEBKGND = 0x0014
            WS_POPUP = 0x80000000
            WS_VISIBLE = 0x10000000
            WS_BORDER = 0x00800000
            SW_SHOW = 5
            DT_CENTER = 0x0001
            DT_VCENTER = 0x0004
            DT_SINGLELINE = 0x0020
            TRANSPARENT = 1
            FW_BOLD = 700
            DEFAULT_CHARSET = 1
            OUT_DEFAULT_PRECIS = 0
            CLIP_DEFAULT_PRECIS = 0
            CLEARTYPE_QUALITY = 5
            DEFAULT_PITCH = 0

            def rgb(r: int, g: int, b: int) -> int:
                return r | (g << 8) | (b << 16)

            hbrush = gdi32.CreateSolidBrush(rgb(10, 13, 17))

            def wnd_proc(hwnd, msg, wparam, lparam):
                if msg == WM_PAINT:
                    ps = PAINTSTRUCT()
                    hdc = user32.BeginPaint(hwnd, ctypes.byref(ps))
                    try:
                        rect = wintypes.RECT()
                        user32.GetClientRect(hwnd, ctypes.byref(rect))
                        gdi32.SetBkMode(hdc, TRANSPARENT)
                        gdi32.SetTextColor(hdc, rgb(232, 238, 246))
                        font_title = gdi32.CreateFontW(
                            -28,
                            0,
                            0,
                            0,
                            FW_BOLD,
                            0,
                            0,
                            0,
                            DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS,
                            CLEARTYPE_QUALITY,
                            DEFAULT_PITCH,
                            "Segoe UI",
                        )
                        old = gdi32.SelectObject(hdc, font_title)
                        r1 = wintypes.RECT(rect.left, rect.top + 70, rect.right, rect.top + 120)
                        user32.DrawTextW(
                            hdc,
                            titulo_txt,
                            -1,
                            ctypes.byref(r1),
                            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                        )
                        gdi32.SelectObject(hdc, old)
                        gdi32.DeleteObject(font_title)

                        font_sub = gdi32.CreateFontW(
                            -16,
                            0,
                            0,
                            0,
                            400,
                            0,
                            0,
                            0,
                            DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS,
                            CLEARTYPE_QUALITY,
                            DEFAULT_PITCH,
                            "Segoe UI",
                        )
                        old = gdi32.SelectObject(hdc, font_sub)
                        gdi32.SetTextColor(hdc, rgb(139, 152, 168))
                        r2 = wintypes.RECT(rect.left, rect.top + 125, rect.right, rect.top + 160)
                        user32.DrawTextW(
                            hdc,
                            "Iniciando…",
                            -1,
                            ctypes.byref(r2),
                            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                        )
                        gdi32.SelectObject(hdc, old)
                        gdi32.DeleteObject(font_sub)
                    finally:
                        user32.EndPaint(hwnd, ctypes.byref(ps))
                    return 0
                if msg == WM_ERASEBKGND:
                    return 1
                if msg in (WM_CLOSE, WM_DESTROY):
                    user32.PostQuitMessage(0)
                    return 0
                return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

            proc = WNDPROC(wnd_proc)
            # Manter referência viva enquanto a janela existir
            wnd_proc._keep = proc  # type: ignore[attr-defined]

            hinst = kernel32.GetModuleHandleW(None)
            cls_name = "ConferenciaCDSplash"
            wc = WNDCLASS()
            wc.style = 0
            wc.lpfnWndProc = proc
            wc.cbClsExtra = 0
            wc.cbWndExtra = 0
            wc.hInstance = hinst
            wc.hIcon = 0
            wc.hCursor = user32.LoadCursorW(0, 32512)
            wc.hbrBackground = hbrush
            wc.lpszMenuName = None
            wc.lpszClassName = cls_name
            user32.RegisterClassW(ctypes.byref(wc))

            sw = user32.GetSystemMetrics(0)
            sh = user32.GetSystemMetrics(1)
            ww, wh = 420, 240
            x = max(0, (sw - ww) // 2)
            y = max(0, (sh - wh) // 2)

            hwnd = user32.CreateWindowExW(
                0,
                cls_name,
                titulo_txt,
                WS_POPUP | WS_VISIBLE | WS_BORDER,
                x,
                y,
                ww,
                wh,
                0,
                0,
                hinst,
                None,
            )
            _splash_nativo_hwnd = int(hwnd or 0)
            if not hwnd:
                return
            user32.ShowWindow(hwnd, SW_SHOW)
            user32.UpdateWindow(hwnd)

            msg = MSG()
            while not _splash_nativo_stop.is_set():
                while user32.PeekMessageW(ctypes.byref(msg), 0, 0, 0, 1):
                    if msg.message == 0x0012:  # WM_QUIT
                        return
                    user32.TranslateMessage(ctypes.byref(msg))
                    user32.DispatchMessageW(ctypes.byref(msg))
                time.sleep(0.02)

            if hwnd:
                user32.DestroyWindow(hwnd)
        except Exception:
            pass
        finally:
            _splash_nativo_hwnd = 0

    _splash_nativo_thread = threading.Thread(
        target=_run, daemon=True, name="splash-nativo"
    )
    _splash_nativo_thread.start()
    time.sleep(0.05)


def splash_nativo_fechar() -> None:
    global _splash_nativo_hwnd, _splash_nativo_thread
    if sys.platform != "win32":
        return
    _splash_nativo_stop.set()
    hwnd = _splash_nativo_hwnd
    if hwnd:
        try:
            import ctypes

            ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
        except Exception:
            pass
    t = _splash_nativo_thread
    if t and t.is_alive():
        t.join(timeout=1.0)
    _splash_nativo_hwnd = 0
    _splash_nativo_thread = None


def _splash_js_set(window, texto: str, *, erro: bool = False) -> None:
    try:
        t = (texto or "").replace("\\", "\\\\").replace("'", "\\'")
        window.evaluate_js(f"window.__splashSet && window.__splashSet('{t}', {str(bool(erro)).lower()})")
    except Exception:
        pass


def abrir_janela(
    url: str,
    *,
    titulo: str | None = None,
    maximizada: bool = True,
    aguardar_pronto: Callable[[], bool] | None = None,
    on_falha: Callable[[], None] | None = None,
) -> None:
    """
    Abre a janela do app.

    Se `aguardar_pronto` for passado, mostra splash HTML imediatamente e só
    navega para `url` quando o callback retornar True (ex.: health do servidor).
    """
    _definir_app_id_windows()
    _preparar_pythonnet()

    # Definitivo: a cada troca de VERSION limpa o cache do WebView2.
    limpar_cache_webview(forcar=False)

    versao = _ler_versao()
    url_final = _url_com_versao(url, versao)
    titulo_janela = titulo or TITLE
    icone = _icone()
    storage = _exe_dir() / WEBVIEW_DATA_DIR
    try:
        storage.mkdir(parents=True, exist_ok=True)
    except Exception:
        storage = _exe_dir()

    try:
        import webview
    except Exception:
        splash_nativo_fechar()
        if aguardar_pronto and not aguardar_pronto():
            if on_falha:
                on_falha()
            return
        _abrir_navegador(url_final)
        threading.Event().wait()
        return

    usar_splash = aguardar_pronto is not None
    api = DesktopApi()
    if usar_splash:
        splash = SPLASH_HTML.replace(
            '<div class="ver" id="ver"></div>',
            f'<div class="ver" id="ver">v{versao}</div>',
        )
        window = webview.create_window(
            titulo_janela,
            html=splash,
            width=WIDTH,
            height=HEIGHT,
            min_size=MIN_SIZE,
            background_color=BG_COLOR,
            text_select=True,
            maximized=maximizada,
            shadow=True,
            confirm_close=False,
            js_api=api,
        )
    else:
        window = webview.create_window(
            titulo_janela,
            url_final,
            width=WIDTH,
            height=HEIGHT,
            min_size=MIN_SIZE,
            background_color=BG_COLOR,
            text_select=True,
            maximized=maximizada,
            shadow=True,
            confirm_close=False,
            js_api=api,
        )
    api.bind_window(window)

    boot_ok = {"done": False}

    def _on_shown() -> None:
        splash_nativo_fechar()
        if icone:

            def _apply_icon() -> None:
                time.sleep(0.35)
                _aplicar_icone_hwnd(titulo_janela, icone)

            threading.Thread(target=_apply_icon, daemon=True).start()

        if not usar_splash or boot_ok["done"]:
            return
        boot_ok["done"] = True

        def _boot() -> None:
            time.sleep(0.05)
            _splash_js_set(window, "Carregando serviços…")
            ok = True
            started = time.time()
            last_tick = {"s": -1}

            def _tick(segundos: int) -> None:
                if segundos == last_tick["s"]:
                    return
                last_tick["s"] = segundos
                if segundos <= 0:
                    return
                _splash_js_set(window, f"Carregando serviços… ({segundos}s)")

            try:
                if aguardar_pronto:
                    # Preferência: callback que aceita on_tick (run_app).
                    try:
                        ok = bool(aguardar_pronto(on_tick=_tick))  # type: ignore[call-arg]
                    except TypeError:
                        ok = bool(aguardar_pronto())
                else:
                    ok = True
            except Exception:
                ok = False
            if ok:
                _splash_js_set(window, "Abrindo…")
                # Pequena folga p/ o WebView estabilizar após o health.
                time.sleep(0.05)
                try:
                    window.load_url(url_final)
                except Exception:
                    try:
                        window.evaluate_js(f"location.replace({url_final!r})")
                    except Exception:
                        ok = False
            if not ok:
                decorrido = int(time.time() - started)
                _splash_js_set(
                    window,
                    f"Servidor não respondeu em {max(decorrido, 10)}s.",
                    erro=True,
                )
                if on_falha:
                    try:
                        on_falha()
                    except Exception:
                        pass
                time.sleep(0.4)
                try:
                    window.destroy()
                except Exception:
                    pass

        threading.Thread(target=_boot, daemon=True, name="app-boot").start()

    window.events.shown += _on_shown

    kwargs: dict = {
        "private_mode": False,
        "storage_path": str(storage),
    }
    if icone:
        kwargs["icon"] = icone

    try:
        webview.start(gui="edgechromium", **kwargs)
        return
    except Exception:
        pass

    try:
        webview.start(**kwargs)
        return
    except Exception:
        splash_nativo_fechar()
        if aguardar_pronto and not aguardar_pronto():
            if on_falha:
                on_falha()
            return
        _abrir_navegador(url_final)
        threading.Event().wait()
