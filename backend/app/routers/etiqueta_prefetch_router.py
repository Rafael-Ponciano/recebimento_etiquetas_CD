from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import AuthUser, get_current_user
from .. import etiqueta_prefetch
from .. import usuarios_service

router = APIRouter(prefix="/api/etiquetas-prefetch", tags=["etiquetas-prefetch"])


class ConfigBody(BaseModel):
    usuarios: list[str] = Field(default_factory=list)


def _exige_admin_config(user: AuthUser) -> None:
    if not etiqueta_prefetch.eh_admin_config(user.usuario):
        raise HTTPException(status_code=403, detail="Só rafael.silva pode alterar isso.")


@router.get("/status")
def obter_status(user: AuthUser = Depends(get_current_user)):
    return etiqueta_prefetch.status(user.usuario)


@router.get("/config")
def obter_config(user: AuthUser = Depends(get_current_user)):
    _exige_admin_config(user)
    habilitados = etiqueta_prefetch.carregar_usuarios_habilitados()
    try:
        todos = [user.usuario] + [u["usuario"] for u in usuarios_service.listar_usuarios(user.usuario)]
        todos.extend(habilitados)
    except Exception:
        todos = [user.usuario, *habilitados]
    vistos: set[str] = set()
    opcoes: list[str] = []
    for nome in todos:
        chave = str(nome or "").strip().casefold()
        if not chave or chave in vistos:
            continue
        vistos.add(chave)
        opcoes.append(str(nome).strip())
    opcoes.sort(key=str.casefold)
    return {"usuarios": habilitados, "opcoes": opcoes}


@router.put("/config")
def salvar_config(body: ConfigBody, user: AuthUser = Depends(get_current_user)):
    _exige_admin_config(user)
    salvos = etiqueta_prefetch.salvar_usuarios_habilitados(body.usuarios)
    return {"ok": True, "usuarios": salvos}
