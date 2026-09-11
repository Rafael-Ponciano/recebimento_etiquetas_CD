from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, Query

from ..auth import AuthUser
from ..acesso_telas import require_tela
from .. import baixa_manual_service

router = APIRouter(prefix="/api/baixa-manual", tags=["baixa-manual"])

class BaixaManualRequest(BaseModel):
    order_id: str = Field(min_length=1)
    novo_status: str = Field(min_length=1)
    observacao: str = ""

@router.get("/status")
def listar_status(_user: AuthUser = Depends(require_tela("baixa-manual"))):
    return {"items": baixa_manual_service.listar_status_permitidos()}

@router.get("/buscar")
def buscar(
    q: str = Query(..., min_length=2),
    _user: AuthUser = Depends(require_tela("baixa-manual")),
):
    return {"items": baixa_manual_service.buscar_pedidos(q)}

@router.post("/aplicar")
def aplicar(body: BaixaManualRequest, user: AuthUser = Depends(require_tela("baixa-manual"))):
    return baixa_manual_service.aplicar_baixa_manual(
        order_id=body.order_id.strip(),
        novo_status=body.novo_status.strip(),
        usuario=user.usuario,
        observacao=body.observacao or "",
    )
