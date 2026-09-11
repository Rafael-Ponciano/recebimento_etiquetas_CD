from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..auth import AuthUser, get_current_user
from ..supabase_client import get_client

router = APIRouter(prefix="/api/preferencias", tags=["preferencias"])

class PreferenciasPayload(BaseModel):
    preferencias: dict[str, Any] = Field(default_factory=dict)

@router.get("/{tela}")
def obter_preferencias(tela: str, user: AuthUser = Depends(get_current_user)):
    resposta = (
        get_client()
        .table("preferencias_usuario")
        .select("preferencias")
        .eq("usuario", user.usuario)
        .eq("tela", tela)
        .limit(1)
        .execute()
    )
    preferencias = resposta.data[0]["preferencias"] if resposta.data else {}
    return {"preferencias": preferencias or {}}

@router.put("/{tela}")
def salvar_preferencias(
    tela: str,
    body: PreferenciasPayload,
    user: AuthUser = Depends(get_current_user),
):
    get_client().table("preferencias_usuario").upsert(
        {
            "usuario": user.usuario,
            "tela": tela,
            "preferencias": body.preferencias,
            "atualizado_em": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="usuario,tela",
    ).execute()
    return {"ok": True}
