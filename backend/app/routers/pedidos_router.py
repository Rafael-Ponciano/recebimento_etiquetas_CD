import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from .. import pedidos_service
from ..auth import get_current_user, require_role, AuthUser

router = APIRouter(prefix="/api/pedidos", tags=["pedidos"])

def _df_para_json(df: pd.DataFrame) -> list[dict]:
    out = df.copy()
    for col in ("Data", "Data Coleta"):
        out[col] = out[col].dt.strftime("%Y-%m-%dT%H:%M:%S").where(out[col].notna(), None)
    out = out.replace({np.nan: None})
    return out.to_dict(orient="records")

@router.get("")
def listar_pedidos(
    refresh: bool = Query(False, description="Ignora cache e lê de novo no Supabase"),
    _user: AuthUser = Depends(get_current_user),
):
    try:
        df = pedidos_service.get_pedidos_df(force_refresh=refresh)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha ao carregar pedidos: {e}")

    # Entregue fica fora da lista; Enviado aparece na tela de pedidos.
    if "Status Any" in df.columns:
        df = df[df["Status Any"].astype(str).str.strip() != "Entregue"]

    try:
        from .. import etiqueta_prefetch

        etiqueta_prefetch.enfileirar_de_df(df, _user.usuario)
    except Exception:
        pass

    return {"items": _df_para_json(df), "total": len(df)}


@router.get("/erros-sheets")
def listar_erros_sheets(_user: AuthUser = Depends(get_current_user)):
    from .. import sheets_erros_service

    try:
        return sheets_erros_service.listar_erros_sheets_pendentes()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha ao listar erros Sheets: {e}")


@router.get("/erros-sheets/count")
def contar_erros_sheets(_user: AuthUser = Depends(get_current_user)):
    from .. import sheets_erros_service

    try:
        return {"total": int(sheets_erros_service.contar_erros_sheets_pendentes())}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha ao contar erros Sheets: {e}")


class ResolverSheetsRequest(BaseModel):
    order_id: str = Field(min_length=1)
    line_key: str = Field(min_length=3)


@router.post("/erros-sheets/resolver")
def resolver_erro_sheets(
    body: ResolverSheetsRequest,
    user: AuthUser = Depends(get_current_user),
):
    from .. import sheets_erros_service

    try:
        return sheets_erros_service.resolver_erro_sheets(
            body.order_id, body.line_key, user.usuario
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha ao resolver erro Sheets: {e}")


@router.post("/erros-sheets/retry")
def retry_erro_sheets(
    body: ResolverSheetsRequest,
    user: AuthUser = Depends(get_current_user),
):
    try:
        resultado = pedidos_service.reatentar_sync_sheets_item(
            body.order_id, body.line_key, user.usuario
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha no retry Sheets: {e}") from e
    if not resultado.get("ok"):
        raise HTTPException(
            status_code=409,
            detail=resultado.get("mensagem") or "Não foi possível atualizar a planilha.",
        )
    return resultado


@router.get("/erros-finalizacao")
def listar_erros_finalizacao(_user: AuthUser = Depends(get_current_user)):
    from .. import finalizacao_erros_service

    try:
        return finalizacao_erros_service.listar_erros_finalizacao_pendentes()
    except Exception as e:
        raise HTTPException(
            status_code=502, detail=f"Falha ao listar erros de finalização: {e}"
        )


@router.get("/erros-finalizacao/count")
def contar_erros_finalizacao(_user: AuthUser = Depends(get_current_user)):
    from .. import finalizacao_erros_service

    try:
        return {
            "total": int(finalizacao_erros_service.contar_erros_finalizacao_pendentes())
        }
    except Exception as e:
        raise HTTPException(
            status_code=502, detail=f"Falha ao contar erros de finalização: {e}"
        )


class ResolverFinalizacaoRequest(BaseModel):
    order_id: str = Field(min_length=1)


@router.post("/erros-finalizacao/resolver")
def resolver_erro_finalizacao(
    body: ResolverFinalizacaoRequest,
    user: AuthUser = Depends(get_current_user),
):
    from .. import finalizacao_erros_service

    try:
        return finalizacao_erros_service.resolver_erro_finalizacao(
            body.order_id, user.usuario
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(
            status_code=502, detail=f"Falha ao resolver erro de finalização: {e}"
        )


@router.post("/erros-finalizacao/retry")
def retry_erro_finalizacao(
    body: ResolverFinalizacaoRequest,
    user: AuthUser = Depends(get_current_user),
):
    try:
        resultado = pedidos_service.reatentar_finalizacao_erro(
            body.order_id, user.usuario
        )
    except Exception as e:
        raise HTTPException(
            status_code=502, detail=f"Falha no retry de finalização: {e}"
        ) from e
    if not resultado.get("ok"):
        raise HTTPException(
            status_code=409,
            detail=resultado.get("mensagem") or "Não foi possível retomar a finalização.",
        )
    return resultado


class LoteRequest(BaseModel):
    order_ids: list[str]


class LotePassoRequest(BaseModel):
    order_id: str = Field(min_length=1)
    fase: str = Field(min_length=3, description="conferir | baixar | imprimir | planilha")
    forcar_conferencia: bool = False


@router.post("/lote/passo")
def lote_passo(body: LotePassoRequest, user: AuthUser = Depends(get_current_user)):
    """Uma fase de um pedido — o front controla o progresso do modal."""
    fase = (body.fase or "").strip().casefold()
    if fase not in {"conferir", "baixar", "imprimir", "planilha"}:
        raise HTTPException(
            status_code=400,
            detail="Fase inválida. Use: conferir, baixar, imprimir ou planilha.",
        )
    try:
        return pedidos_service.executar_lote_passo(
            body.order_id,
            fase,
            user.usuario,
            forcar_conferencia=bool(body.forcar_conferencia),
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Erro na fase '{fase}' do pedido {body.order_id}: {e}",
        )


@router.post("/lote/imprimir")
def imprimir_lote(body: LoteRequest, user: AuthUser = Depends(get_current_user)):
    if not body.order_ids:
        raise HTTPException(status_code=400, detail="Nenhum pedido selecionado.")
    return pedidos_service.reimprimir_lote(body.order_ids, user.usuario)

@router.get("/despachos/recentes")
def listar_despachos_recentes(
    limite: int = Query(500, ge=1, le=2000),
    _user: AuthUser = Depends(get_current_user),
):
    try:
        return {"items": pedidos_service.consultar_despachos_recentes(limite=limite)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha ao consultar despachos recentes: {e}")

@router.get("/{order_id}/itens")
def itens_do_pedido(order_id: str, _user: AuthUser = Depends(get_current_user)):
    try:
        itens = pedidos_service.obter_itens_pedido(order_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Não foi possível buscar os itens: {e}")
    if itens is None:
        raise HTTPException(status_code=502, detail="Não foi possível buscar os itens.")
    return {"items": itens}

@router.post("/{order_id}/presenca")
def heartbeat_presenca(order_id: str, user: AuthUser = Depends(get_current_user)):
    from .. import presenca_service

    return presenca_service.sincronizar_presenca(
        order_id, user.usuario, nome=user.nome
    )

@router.delete("/{order_id}/presenca")
def sair_presenca(order_id: str, user: AuthUser = Depends(get_current_user)):
    from .. import presenca_service

    presenca_service.sair_presenca(order_id, user.usuario)
    return {"ok": True}

class ConferenciaItemRequest(BaseModel):
    line_key: str = Field(min_length=3)
    quantidade: int = Field(gt=0)
    forcar_conferencia: bool = False

@router.post("/{order_id}/conferir-item")
def conferir_item(order_id: str, payload: ConferenciaItemRequest, user: AuthUser = Depends(get_current_user)):
    try:
        resultado = pedidos_service.conferir_item_parcial(
            order_id=order_id,
            line_key=payload.line_key,
            quantidade=payload.quantidade,
            usuario=user.usuario,
            forcar_conferencia=bool(payload.forcar_conferencia),
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Erro inesperado: {e}")

    if not resultado.get("ok") and not resultado.get("pedido_concluido"):
        raise HTTPException(status_code=400, detail=resultado.get("mensagem"))
    return resultado

@router.post("/{order_id}/desmarcar-conferencia")
def desmarcar_conferencia(order_id: str, user: AuthUser = Depends(require_role("admin"))):
    try:
        resultado = pedidos_service.desmarcar_conferencia_pedido(order_id, user.usuario)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Erro ao desmarcar conferência: {e}")
    if not resultado.get("ok"):
        raise HTTPException(status_code=400, detail=resultado.get("mensagem"))
    return resultado

class RetomarFinalizacaoRequest(BaseModel):
    forcar_conferencia: bool = False

@router.post("/{order_id}/retomar-finalizacao")
def retomar_finalizacao(
    order_id: str,
    body: RetomarFinalizacaoRequest = RetomarFinalizacaoRequest(),
    user: AuthUser = Depends(get_current_user),
):

    try:
        resultado = pedidos_service.retomar_finalizacao_pedido(
            order_id, user.usuario, forcar_conferencia=bool(body.forcar_conferencia)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Erro ao retomar finalização: {e}")
    if not resultado.get("ok") and not resultado.get("pedido_concluido"):
        raise HTTPException(status_code=400, detail=resultado.get("mensagem"))
    return resultado

class ImprimirRequest(BaseModel):
    status_any: str | None = None

    modo: str = "todos"
    docs: list[str] | None = None

@router.post("/{order_id}/imprimir")
def imprimir(
    order_id: str,
    body: ImprimirRequest = ImprimirRequest(),
    user: AuthUser = Depends(get_current_user),
):
    try:
        resultado = pedidos_service.reimprimir_pedido(
            order_id,
            user.usuario,
            status_hint=body.status_any,
            docs=body.docs,
            modo=body.modo,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Erro inesperado ao reimprimir: {e}")
    return resultado


class ConfirmarRomaneioRequest(BaseModel):
    order_ids: list[str] = Field(..., min_length=1, description="Lista de IDs dos pedidos a despachar")
    marketplace: str = Field(default="", description="Marketplace do romaneio")
    transportadora: str = Field(default="", description="Nome da transportadora")
    pedidos_detalhes: list[dict] = Field(default_factory=list, description="Detalhes de cada pedido no romaneio")


@router.post("/despachos/confirmar-romaneio")
def confirmar_despacho_romaneio(
    body: ConfirmarRomaneioRequest,
    user: AuthUser = Depends(get_current_user),
):
    try:
        res = pedidos_service.confirmar_despacho_romaneio(
            order_ids=body.order_ids,
            usuario=user.nome or user.usuario,
            marketplace=body.marketplace,
            transportadora=body.transportadora,
            pedidos_detalhes=body.pedidos_detalhes,
        )
        if not res.get("ok"):
            raise HTTPException(
                status_code=400,
                detail=res.get("mensagem", "Falha ao confirmar despacho do romaneio"),
            )
        return res
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Erro interno ao confirmar despacho do romaneio: {e}",
        )


@router.get("/despachos/romaneios")
def listar_romaneios(
    dias: int = Query(30, ge=1, le=180, description="Dias para trás a consultar"),
    marketplace: str | None = Query(None, description="Filtro opcional por marketplace"),
    refresh: bool = Query(False, description="Ignora cache em memória"),
    _user: AuthUser = Depends(get_current_user),
):
    """Lista romaneios expedidos salvos no sistema."""
    from .. import romaneios_service

    try:
        items = romaneios_service.listar_romaneios(
            dias=dias,
            marketplace=marketplace,
            force_refresh=refresh,
        )
        return {"items": items, "total": len(items)}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao listar romaneios expedidos: {e}",
        )


@router.get("/despachos/romaneios/{codigo}")
def obter_romaneio(
    codigo: str,
    _user: AuthUser = Depends(get_current_user),
):
    """Retorna dados completos de um romaneio expedido."""
    from .. import romaneios_service

    try:
        r = romaneios_service.obter_romaneio(codigo)
        if not r:
            raise HTTPException(status_code=404, detail=f"Romaneio '{codigo}' não encontrado.")
        return r
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao obter romaneio: {e}",
        )


class RegistrarDespachoRequest(BaseModel):
    marketplace: str = Field(default="", description="Marketplace / transportadora do despacho")
    chave_nfe: str = Field(default="", description="Chave da NF-e (44 dígitos)")
    nf_venda: str = Field(default="", description="Número da NF de venda")


class EstornarDespachoRequest(BaseModel):
    motivo: str = Field(default="", description="Motivo do estorno do despacho")


@router.post("/{order_id}/registrar-despacho")
def registrar_despacho(
    order_id: str,
    body: RegistrarDespachoRequest | None = None,
    user: AuthUser = Depends(get_current_user),
):
    try:
        mp = body.marketplace if body else ""
        chave = body.chave_nfe if body else ""
        nf = body.nf_venda if body else ""
        res = pedidos_service.registrar_despacho_pedido(
            order_id=order_id,
            usuario=user.nome or user.usuario,
            marketplace=mp,
            chave_nfe=chave,
            nf_venda=nf,
        )
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("mensagem", "Falha ao registrar despacho"))
        return res
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro interno ao registrar despacho: {e}")


@router.post("/{order_id}/estornar-despacho")
def estornar_despacho(
    order_id: str,
    body: EstornarDespachoRequest | None = None,
    user: AuthUser = Depends(get_current_user),
):
    try:
        motivo = body.motivo if body else ""
        res = pedidos_service.estornar_despacho_pedido(
            order_id=order_id,
            usuario=user.nome or user.usuario,
            motivo=motivo,
        )
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("mensagem", "Falha ao estornar despacho"))
        return res
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro interno ao estornar despacho: {e}")


@router.post("/{order_id}/marcar-enviado")
def marcar_enviado(
    order_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Marca o pedido como Enviado manualmente. Restrito ao usuário rafael.silva."""
    if user.usuario != "rafael.silva":
        raise HTTPException(status_code=403, detail="Ação restrita ao usuário rafael.silva.")
    try:
        from ..status_manual_service import salvar_status_manual
        from ..supabase_client import log_evento
        salvar_status_manual(
            order_id=order_id,
            status_any="Enviado",
            usuario=user.usuario,
            observacao="Marcado como Enviado manualmente via modal de conferência.",
        )
        log_evento(user.usuario, "ENVIADO_MANUAL", "Status alterado para Enviado manualmente.", order_id)
        return {"ok": True, "status_pedido": "Enviado"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro ao marcar como Enviado: {e}")

