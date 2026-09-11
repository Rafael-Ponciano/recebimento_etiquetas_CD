import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .routers import (
    auth_router,
    logs_router,
    pedidos_router,
    preferencias_router,
    historico_router,
    performance_router,
    baixa_manual_router,
    dashboard_router,
    update_router,
    etiqueta_prefetch_router,
    acesso_telas_router,
)
from .config import get_external_path
from .version import get_app_version

app = FastAPI(title="Conferência de Pedidos API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _cache_headers_spa(request, call_next):
    """Evita WebView2 servir index.html/JS antigo após auto-update."""
    response = await call_next(request)
    path = request.url.path or "/"
    if path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    elif path.startswith("/assets/"):
        # assets com hash no nome podem cachear; se o index muda, o hash muda
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response

app.include_router(auth_router.router)
app.include_router(logs_router.router)
app.include_router(pedidos_router.router)
app.include_router(preferencias_router.router)
app.include_router(historico_router.router)
app.include_router(performance_router.router)
app.include_router(baixa_manual_router.router)
app.include_router(dashboard_router.router)
app.include_router(update_router.router)
app.include_router(etiqueta_prefetch_router.router)
app.include_router(acesso_telas_router.router)

@app.on_event("startup")
def _limpar_downloads_ao_iniciar():
    """Não bloqueia o boot: limpeza pode puxar BQ e atrasar /api/health."""
    import threading

    def _bg() -> None:
        try:
            from .downloads_cleanup import limpar_downloads_antigos, iniciar_limpeza_periodica

            resultado = limpar_downloads_antigos()
            if resultado.get("apagados"):
                print(
                    f"[downloads] Removidos {resultado['apagados']} PDF(s) "
                    f"(fora fila>{resultado.get('dias_fora_fila')}d / "
                    f"em separação|a conferir>{resultado.get('dias_em_fila')}d) "
                    f"em {resultado['pasta']}."
                )
            iniciar_limpeza_periodica()
        except Exception as e:
            print(f"[downloads] Limpeza ignorada: {e}")

    threading.Thread(target=_bg, daemon=True, name="downloads-startup").start()

@app.get("/api/health")
def health():
    from .config import settings

    return {
        "status": "ok",
        "version": get_app_version(),
        "regras": settings.regras_negocio(),
    }

_static_dir = get_external_path("static")
if os.path.isdir(_static_dir):
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
