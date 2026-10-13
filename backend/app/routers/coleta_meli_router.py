from fastapi import APIRouter, Depends, HTTPException

from ..auth import AuthUser
from ..acesso_telas import require_tela
from .. import anymarket

router = APIRouter(prefix="/api/expedicao/coleta-meli", tags=["expedicao"])


@router.get("")
def obter_horarios_coleta_meli(
    _user: AuthUser = Depends(require_tela("coleta-meli")),
):
    """Consulta a grade semanal de despacho e capacidade do Mercado Livre via AnyMarket."""
    try:
        return anymarket.consultar_horarios_coleta_meli()
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Falha ao consultar grade do Mercado Livre na AnyMarket: {e}",
        )
