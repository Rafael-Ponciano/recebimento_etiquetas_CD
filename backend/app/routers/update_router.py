from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import update_service
from ..auth import AuthUser, get_current_user

router = APIRouter(prefix="/api/update", tags=["update"])


@router.get("/status")
def status_update(force: bool = False, _user: AuthUser = Depends(get_current_user)):
    try:
        st = update_service.verificar_atualizacao(force=force)
        return st.to_dict()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/progress")
def progress_update(_user: AuthUser = Depends(get_current_user)):
    return update_service.obter_progresso()


@router.post("/aplicar")
def aplicar_update(user: AuthUser = Depends(get_current_user)):
    try:
        return update_service.iniciar_atualizacao(solicitante=user.usuario)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha ao iniciar atualização: {e}") from e
