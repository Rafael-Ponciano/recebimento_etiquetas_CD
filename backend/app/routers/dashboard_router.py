from datetime import date

from fastapi import APIRouter, Depends, Query

from ..auth import AuthUser
from ..acesso_telas import require_tela
from .. import dashboard_service

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("")
def obter_dashboard(
    data_ini: date | None = Query(None),
    data_fim: date | None = Query(None),
    usuario: str | None = Query(None),
    _user: AuthUser = Depends(require_tela("dashboard")),
):
    return dashboard_service.obter_dashboard(
        data_ini=data_ini,
        data_fim=data_fim,
        usuario=usuario,
    )
