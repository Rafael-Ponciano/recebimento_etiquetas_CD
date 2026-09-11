from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import acesso_telas, usuarios_service
from ..auth import AuthUser, get_current_user
from ..supabase_client import get_client, executar_com_retry

router = APIRouter(prefix="/api/acesso-telas", tags=["acesso-telas"])


class MapaBody(BaseModel):
    mapa: dict[str, list[str]] = Field(default_factory=dict)


def _exige_admin(user: AuthUser) -> None:
    if not acesso_telas.eh_admin_acesso(user.usuario):
        raise HTTPException(
            status_code=403,
            detail="Só rafael.silva pode alterar o acesso às telas.",
        )


def _listar_opcoes(eu: str) -> list[dict]:
    """Usuários ativos para o painel (inclui o próprio admin)."""
    items: list[dict] = []
    visto: set[str] = set()

    def _add(usuario: str, nome: str | None = None, role: str | None = None) -> None:
        login = (usuario or "").strip()
        if not login:
            return
        chave = login.casefold()
        if chave in visto:
            return
        visto.add(chave)
        items.append(
            {
                "usuario": login,
                "nome": (nome or login).strip() or login,
                "role": (role or "operador").strip() or "operador",
            }
        )

    _add(eu)
    try:
        for u in usuarios_service.listar_usuarios(eu):
            _add(u.get("usuario") or "", u.get("nome"), u.get("role"))
    except Exception:
        pass

    if len(items) <= 1:
        try:
            resp = executar_com_retry(
                lambda: (
                    get_client()
                    .table("usuarios")
                    .select("usuario,nome,role")
                    .eq("ativo", True)
                    .order("usuario")
                    .limit(200)
                    .execute()
                )
            )
            for row in resp.data or []:
                _add(row.get("usuario") or "", row.get("nome"), row.get("role"))
        except Exception:
            pass

    items.sort(key=lambda x: (x["nome"] or x["usuario"]).casefold())
    return items


@router.get("/config")
def obter_config(user: AuthUser = Depends(get_current_user)):
    _exige_admin(user)
    mapa = acesso_telas.carregar_mapa()
    opcoes = _listar_opcoes(user.usuario)
    efetivo: dict[str, list[str]] = {}
    for op in opcoes:
        efetivo[op["usuario"]] = acesso_telas.telas_efetivas(op["usuario"], op["role"])
    return {
        "mapa": mapa,
        "efetivo": efetivo,
        "opcoes": opcoes,
        "telas": acesso_telas.catalogo_telas(),
        "defaults": {
            "admin": list(acesso_telas.DEFAULTS_POR_ROLE["admin"]),
            "operador": list(acesso_telas.DEFAULTS_POR_ROLE["operador"]),
        },
    }


@router.put("/config")
def salvar_config(body: MapaBody, user: AuthUser = Depends(get_current_user)):
    _exige_admin(user)
    salvos = acesso_telas.salvar_mapa(body.mapa)
    return {"ok": True, "mapa": salvos}
