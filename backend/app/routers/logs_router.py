from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..auth import require_role, AuthUser
from ..acesso_telas import require_tela
from ..supabase_client import get_client, log_evento
from .. import pedidos_service
from ..timeutil import bounds_periodo_br, hoje_br

router = APIRouter(prefix="/api/logs", tags=["logs"])


def _mapa_pedido_exibicao() -> dict[str, str]:
    """id_any / Pedido Any → PM (Pedido) se existir; senão o próprio Any."""
    try:
        df = pedidos_service.get_pedidos_df()
    except Exception:
        return {}
    if df is None or getattr(df, "empty", True):
        return {}
    mapa: dict[str, str] = {}
    for rec in df.to_dict(orient="records"):
        oid = str(rec.get("id_any") or "").strip()
        pm = str(rec.get("Pedido") or "").strip()
        any_ref = str(rec.get("Pedido Any") or "").strip()
        rotulo = pm or any_ref or oid
        if not rotulo:
            continue
        if oid:
            mapa[oid] = rotulo
        if any_ref:
            mapa[any_ref] = rotulo
        if pm:
            mapa[pm] = rotulo
    return mapa


@router.get("")
def listar_logs(
    data_ini: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    tipo_acao: Optional[str] = Query(None, description="Filtro 'contém' no tipo de ação"),
    usuario: Optional[str] = Query(None),
    pedido_id: Optional[str] = Query(None),
    _user=Depends(require_tela("logs")),
):
    if data_ini is None:
        data_ini = hoje_br()
    if data_fim is None:
        data_fim = hoje_br()

    ini, fim = bounds_periodo_br(data_ini, data_fim)
    client = get_client()
    q = client.table("logs").select("*")
    q = q.gte("created_at", ini)
    q = q.lte("created_at", fim)
    if tipo_acao:
        q = q.ilike("tipo_acao", f"%{tipo_acao}%")
    if usuario:
        q = q.ilike("usuario", f"%{usuario}%")
    if pedido_id:
        q = q.ilike("pedido_id", f"%{pedido_id}%")
    q = q.order("created_at", desc=True).limit(2000)

    resp = q.execute()
    items = list(resp.data or [])
    mapa = _mapa_pedido_exibicao()
    for item in items:
        pid = str(item.get("pedido_id") or "").strip()
        item["pedido_exibicao"] = mapa.get(pid) or pid or None
    return {"total": len(items), "items": items}

class LimpezaRetencaoRequest(BaseModel):
    dias_logs: int = Field(30, ge=7, le=365, description="Apaga logs mais antigos que N dias")
    dias_recebimentos: int = Field(
        120,
        ge=30,
        le=730,
        description="Apaga cargas de recebimento (timeline) mais antigas que N dias",
    )

@router.post("/limpar-retencao")
def limpar_retencao(
    body: LimpezaRetencaoRequest = LimpezaRetencaoRequest(),
    user: AuthUser = Depends(require_role("admin")),
):

    client = get_client()
    try:
        resp = client.rpc(
            "limpar_retencao",
            {
                "p_dias_logs": body.dias_logs,
                "p_dias_recebimentos": body.dias_recebimentos,
            },
        ).execute()
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Falha na limpeza: {e}. "
                "Rode backend/sql/retencao_limpeza.sql no SQL Editor do Supabase."
            ),
        ) from e

    dados = resp.data
    if isinstance(dados, list):
        dados = dados[0] if dados else {}
    log_evento(
        user.usuario,
        "LIMPEZA_RETENCAO",
        f"logs={body.dias_logs}d recebimentos={body.dias_recebimentos}d → {dados}",
    )
    return {"ok": True, "resultado": dados or {}}
