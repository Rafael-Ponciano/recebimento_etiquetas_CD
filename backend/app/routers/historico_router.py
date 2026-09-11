from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query

from ..auth import AuthUser, get_current_user
from .. import historico_service

router = APIRouter(prefix="/api/historico", tags=["historico"])

@router.get("")
def listar_historico(
    data_ini: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    usuario: Optional[str] = Query(None),
    pedido: Optional[str] = Query(None),
    limit: int = Query(100, ge=0, le=10_000, description="0 = todos (exportação)"),
    offset: int = Query(0, ge=0),
    _user: AuthUser = Depends(get_current_user),
):
    return historico_service.listar_historico(
        data_ini=data_ini,
        data_fim=data_fim,
        usuario=usuario,
        pedido=pedido,
        limit=limit,
        offset=offset,
    )

@router.get("/{order_id}")
def detalhe_historico(order_id: str, _user: AuthUser = Depends(get_current_user)):
    return historico_service.obter_timeline(order_id)
