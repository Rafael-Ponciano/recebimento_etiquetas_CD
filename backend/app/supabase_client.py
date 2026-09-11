from functools import lru_cache
import time
from collections.abc import Callable
from typing import TypeVar

from supabase import create_client, Client
from .config import settings

LOGS_NAO_PERSISTIR = frozenset({
    "CONFERENCIA_TIMING",
    "CONFERENCIA_ENVIADA",
    "CONFERENCIA_ITENS",
    "CONFERENCIA_JA_FEITA",
})

T = TypeVar("T")

_ERROS_TRANSITORIOS = (
    "timeout",
    "timed out",
    "connection",
    "temporarily",
    "unavailable",
    "reset by peer",
    "server disconnected",
    "remoteprotocolerror",
    "connecterror",
    "cloudflare",
    " 429",
    "429 ",
    " 502",
    "502 ",
    " 503",
    "503 ",
    " 504",
    "504 ",
    # Windows: socket non-blocking (WSAEWOULDBLOCK) — comum com httpx/Supabase.
    "winerror 10035",
    "10035",
    "não pôde ser concluída imediatamente",
    "nao pode ser concluida imediatamente",
    "would block",
    "wsaewouldblock",
    "connectionterminated",
)

def _eh_erro_transitorio(exc: BaseException) -> bool:
    partes: list[str] = []
    atual: BaseException | None = exc
    vistos: set[int] = set()
    while atual is not None and id(atual) not in vistos:
        vistos.add(id(atual))
        partes.append(str(atual))
        partes.append(type(atual).__name__)
        atual = atual.__cause__ or atual.__context__
    msg = " ".join(partes).casefold()
    return any(m in msg for m in _ERROS_TRANSITORIOS)

def executar_com_retry(
    fn: Callable[[], T],
    *,
    tentativas: int = 3,
    espera_base: float = 0.35,
) -> T:
    ultimo: BaseException | None = None
    for i in range(max(1, tentativas)):
        try:
            return fn()
        except Exception as e:
            ultimo = e
            if i >= tentativas - 1 or not _eh_erro_transitorio(e):
                raise
            time.sleep(espera_base * (2**i))
    assert ultimo is not None
    raise ultimo

@lru_cache
def get_client() -> Client:
    return create_client(settings.supabase_url, settings.supabase_key)

def log_evento(usuario: str, tipo_acao: str, detalhes: str = "", pedido_id: str | None = None):

    if tipo_acao in LOGS_NAO_PERSISTIR:
        print(f"[log:{tipo_acao}] {usuario} pedido={pedido_id} {detalhes}")
        return
    try:
        client = get_client()
        executar_com_retry(
            lambda: client.table("logs")
            .insert(
                {
                    "usuario": usuario,
                    "tipo_acao": tipo_acao,
                    "detalhes": detalhes,
                    "pedido_id": str(pedido_id) if pedido_id else None,
                }
            )
            .execute()
        )
    except Exception as e:
        print(f"[log_evento] Falha ao gravar log no Supabase: {e}")
