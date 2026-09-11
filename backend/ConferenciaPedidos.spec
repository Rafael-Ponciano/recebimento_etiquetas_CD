# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — Conferência CD (Windows, sem Python no PC destino)."""
from __future__ import annotations

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH).resolve().parent
BACKEND = Path(SPECPATH).resolve()
ICON = ROOT / "frontend" / "public" / "delivery.ico"

datas: list = []
binaries: list = []
hiddenimports: list = []

# Pacotes que o PyInstaller costuma “perder” no análise estática.
for pacote in (
    "uvicorn",
    "fastapi",
    "starlette",
    "anyio",
    "httpx",
    "httpcore",
    "h11",
    "sniffio",
    "supabase",
    "postgrest",
    "gotrue",
    "realtime",
    "storage3",
    "supafunc",
    "pydantic",
    "pydantic_core",
    "annotated_types",
    "jwt",
    "bcrypt",
    "gspread",
    "google",
    "google.oauth2",
    "google.auth",
    "google_auth_httplib2",
    "pandas",
    "numpy",
    "pypdf",
    "webview",
    "clr_loader",
    "pythonnet",
    "multipart",
    "dotenv",
    "certifi",
    "charset_normalizer",
    "idna",
    "urllib3",
    "requests",
    "yarl",
    "multidict",
    "aiosignal",
    "frozenlist",
    "websockets",
    "rich",
    "typer",
):
    try:
        d, b, h = collect_all(pacote)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

# Submódulos do app e do uvicorn.
hiddenimports += collect_submodules("app")
hiddenimports += collect_submodules("uvicorn")
hiddenimports += [
    "app.main",
    "app.config",
    "app.auth",
    "app.version",
    "app.pedidos_service",
    "app.historico_service",
    "app.performance_service",
    "app.anymarket",
    "app.google_sheets",
    "app.printing",
    "app.supabase_client",
    "app.supabase_pedidos",
    "app.routers",
    "app.routers.auth_router",
    "app.routers.pedidos_router",
    "app.routers.historico_router",
    "app.routers.logs_router",
    "app.routers.preferencias_router",
    "app.routers.performance_router",
    "app.routers.baixa_manual_router",
    "app.routers.dashboard_router",
    "app.routers.update_router",
    "app.dashboard_service",
    "app.presenca_service",
    "app.baixa_manual_service",
    "app.status_manual_service",
    "app.sheets_erros_service",
    "app.finalizacao_erros_service",
    "app.usuarios_service",
    "app.downloads_cleanup",
    "app.pdf_util",
    "app.update_service",
    "app.atualizador_runtime",
    "tkinter",
    "tkinter.ttk",
    "_tkinter",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "httptools",
    "watchfiles",
    "desktop_window",
]

# desktop_window.py fica na raiz do projeto.
datas += [(str(ROOT / "desktop_window.py"), ".")]
# Garante o atualizador como arquivo solto no bundle (fallback importlib).
datas += [(str(BACKEND / "app" / "atualizador_runtime.py"), ".")]
datas += [(str(BACKEND / "app" / "atualizador_runtime.py"), "app")]

# Força análise do módulo do atualizador.
try:
    import app.atualizador_runtime  # noqa: F401
except Exception:
    pass

try:
    d, b, h = collect_all("tkinter")
    datas += d
    binaries += b
    hiddenimports += h
except Exception:
    pass
hiddenimports += ["tkinter", "tkinter.ttk", "_tkinter", "app.atualizador_runtime"]

block_cipher = None

a = Analysis(
    [str(BACKEND / "run_app.py")],
    pathex=[str(BACKEND), str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# onedir = mais estável que onefile (menos erro de DLL/lib faltando).
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ConferenciaPedidos",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # sem janela preta de terminal
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ICON) if ICON.is_file() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ConferenciaPedidos",
)
