from datetime import datetime, timedelta, timezone
import re
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import autenticar, gerar_hash, get_current_user, verificar_senha, AuthUser
from ..email_smtp import enviar_codigo_recuperacao
from ..supabase_client import get_client, log_evento

router = APIRouter(prefix="/api/auth", tags=["auth"])

_MSG_RECUPERAR = "Código enviado por e-mail."
_RESET_TTL_MIN = 15
_RESET_COOLDOWN_S = 60
_RESET_MAX_TENTATIVAS = 5
_RESET_BLOQUEIO_S = 15 * 60
_ultimos_pedidos_reset: dict[str, float] = {}
# chave -> (tentativas erradas, monotonic em que o bloqueio termina)
_tentativas_reset: dict[str, tuple[int, float]] = {}

class LoginRequest(BaseModel):
    usuario: str
    senha: str

class LoginResponse(BaseModel):
    token: str

class PerfilRequest(BaseModel):
    nome: str = Field(min_length=2, max_length=100)
    email: str | None = Field(default=None, max_length=254)
    imagem: str | None = Field(default=None, max_length=600_000)

class SenhaRequest(BaseModel):
    senha_atual: str
    nova_senha: str = Field(min_length=8, max_length=128)

class RecuperarSenhaRequest(BaseModel):
    identificador: str = Field(min_length=2, max_length=254)

class RedefinirSenhaRequest(BaseModel):
    identificador: str = Field(min_length=2, max_length=254)
    codigo: str = Field(min_length=4, max_length=12)
    nova_senha: str = Field(min_length=8, max_length=128)

def _rpc_data(resposta) -> dict | None:
    dados = resposta.data
    if isinstance(dados, list):
        dados = dados[0] if dados else None
    return dados if isinstance(dados, dict) else None

def _buscar_usuario(usuario: str) -> dict:
    client = get_client()
    try:
        via_rpc = _rpc_data(
            client.rpc("obter_perfil_usuario", {"p_usuario": usuario}).execute()
        )
        if via_rpc:
            return via_rpc
    except Exception:
        pass

    resposta = (
        client.table("usuarios")
        .select("*")
        .eq("usuario", usuario)
        .limit(1)
        .execute()
    )
    if not resposta.data:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
    return resposta.data[0]

def _auth_user(row: dict) -> AuthUser:
    from .. import acesso_telas

    usuario = row["usuario"]
    role = row["role"]
    return AuthUser(
        usuario=usuario,
        nome=row.get("nome") or usuario,
        role=role,
        email=row.get("email"),
        imagem=row.get("imagem"),
        telas=acesso_telas.telas_efetivas(usuario, role),
    )

def _atualizar_perfil(
    usuario: str,
    nome: str,
    email: str | None,
    imagem: str | None,
    atualizar_imagem: bool,
) -> dict:
    client = get_client()

    try:
        via_rpc = _rpc_data(
            client.rpc(
                "atualizar_perfil_usuario",
                {
                    "p_usuario": usuario,
                    "p_nome": nome,
                    "p_email": email,
                    "p_imagem": imagem,
                    "p_atualizar_imagem": atualizar_imagem,
                },
            ).execute()
        )
        if via_rpc:

            if atualizar_imagem and imagem and not via_rpc.get("imagem"):
                via_rpc = {**via_rpc, "imagem": imagem}
            return via_rpc
    except Exception as rpc_err:
        rpc_msg = str(rpc_err)
    else:
        rpc_msg = "RPC sem retorno"

    payload: dict = {
        "nome": nome,
        "email": email,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if atualizar_imagem:
        payload["imagem"] = imagem

    try:
        client.table("usuarios").update(payload).eq("usuario", usuario).execute()
    except Exception:
        payload.pop("updated_at", None)
        try:
            client.table("usuarios").update(payload).eq("usuario", usuario).execute()
        except Exception as table_err:
            raise RuntimeError(
                "Falha ao gravar perfil. Execute "
                "backend/migrations/004_atualizar_perfil_rpc.sql no Supabase. "
                f"RPC: {rpc_msg} | Tabela: {table_err}"
            ) from table_err

    row = _buscar_usuario(usuario)
    if atualizar_imagem and imagem and not row.get("imagem"):
        raise RuntimeError(
            "Nome pode ter sido salvo, mas usuarios.imagem não refletiu. "
            "A coluna existe no Postgres, porém a API precisa recarregar o schema. "
            "Execute no SQL Editor:\n"
            "  notify pgrst, 'reload schema';\n"
            "e também backend/migrations/004_atualizar_perfil_rpc.sql\n"
            f"RPC: {rpc_msg}"
        )
    return row

def _norm_ident(identificador: str) -> str:
    return identificador.strip()

def _buscar_usuario_por_identificador(identificador: str) -> dict | None:
    client = get_client()
    ident = _norm_ident(identificador)
    if not ident:
        return None

    cols = "usuario,nome,email,ativo,reset_codigo_hash,reset_expira_em,senha_hash"
    try:
        por_usuario = (
            client.table("usuarios")
            .select(cols)
            .eq("usuario", ident)
            .limit(1)
            .execute()
        )
    except Exception:
        # Colunas reset_* ainda não existem — fallback sem elas.
        cols = "usuario,nome,email,ativo,senha_hash"
        por_usuario = (
            client.table("usuarios")
            .select(cols)
            .eq("usuario", ident)
            .limit(1)
            .execute()
        )
    if por_usuario.data:
        return por_usuario.data[0]

    por_email = (
        client.table("usuarios")
        .select(cols)
        .ilike("email", ident)
        .limit(1)
        .execute()
    )
    if por_email.data:
        return por_email.data[0]
    return None

def _rate_limit_reset(chave: str) -> None:
    agora = time.monotonic()
    ultimo = _ultimos_pedidos_reset.get(chave)
    if ultimo is not None and (agora - ultimo) < _RESET_COOLDOWN_S:
        raise HTTPException(
            status_code=429,
            detail=f"Aguarde {_RESET_COOLDOWN_S} segundos antes de solicitar outro código.",
        )
    _ultimos_pedidos_reset[chave] = agora


def _garantir_reset_liberado(*chaves: str) -> None:
    """Bloqueia o brute-force do código de 6 dígitos."""
    for chave in chaves:
        if not chave:
            continue
        _, bloqueado_ate = _tentativas_reset.get(chave, (0, 0.0))
        if not bloqueado_ate:
            continue
        restante = bloqueado_ate - time.monotonic()
        if restante <= 0:
            _tentativas_reset.pop(chave, None)
            continue
        raise HTTPException(
            status_code=429,
            detail=(
                "Muitas tentativas com código inválido. "
                f"Tente de novo em {int(restante // 60) + 1} minuto(s) ou peça um novo código."
            ),
        )


def _registrar_tentativa_reset_invalida(*chaves: str) -> None:
    if len(_tentativas_reset) > 500:
        agora = time.monotonic()
        for k, (_, ate) in list(_tentativas_reset.items()):
            if ate and ate <= agora:
                _tentativas_reset.pop(k, None)

    for chave in chaves:
        if not chave:
            continue
        tentativas = _tentativas_reset.get(chave, (0, 0.0))[0] + 1
        bloqueio = (
            time.monotonic() + _RESET_BLOQUEIO_S
            if tentativas >= _RESET_MAX_TENTATIVAS
            else 0.0
        )
        _tentativas_reset[chave] = (tentativas, bloqueio)

def _parse_expira(raw) -> datetime | None:
    if not raw:
        return None
    if isinstance(raw, datetime):
        dt = raw
    else:
        texto = str(raw).replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(texto)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt

@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest):
    token = autenticar(body.usuario.strip(), body.senha)
    return LoginResponse(token=token)

@router.get("/me", response_model=AuthUser)
def me(user: AuthUser = Depends(get_current_user)):
    return _auth_user(_buscar_usuario(user.usuario))

@router.get("/resumo-dia")
def resumo_dia(user: AuthUser = Depends(get_current_user)):
    from .. import dashboard_service

    return dashboard_service.obter_resumo_dia_usuario(user.usuario)
@router.put("/perfil", response_model=AuthUser)
def atualizar_perfil(body: PerfilRequest, user: AuthUser = Depends(get_current_user)):
    nome = body.nome.strip()
    email = (body.email or "").strip().casefold() or None
    atualizar_imagem = "imagem" in body.model_fields_set
    imagem = body.imagem
    if isinstance(imagem, str):
        imagem = imagem.strip() or None

    if len(nome) < 2:
        raise HTTPException(status_code=422, detail="Informe um nome válido.")
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(status_code=422, detail="Informe um e-mail válido.")
    if imagem and not imagem.startswith(
        ("data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/png;base64,")
    ):
        raise HTTPException(status_code=422, detail="Formato de imagem inválido.")

    if email:
        existente = (
            get_client()
            .table("usuarios")
            .select("usuario")
            .ilike("email", email)
            .neq("usuario", user.usuario)
            .limit(1)
            .execute()
        )
        if existente.data:
            raise HTTPException(status_code=409, detail="Este e-mail já está sendo utilizado.")

    try:
        row = _atualizar_perfil(
            user.usuario, nome, email, imagem, atualizar_imagem
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    log_evento(user.usuario, "PERFIL_ATUALIZADO", "Nome, e-mail ou imagem atualizados.")
    return _auth_user(row)

@router.put("/senha")
def alterar_senha(body: SenhaRequest, user: AuthUser = Depends(get_current_user)):
    client = get_client()
    resposta = (
        client.table("usuarios")
        .select("usuario,senha_hash")
        .eq("usuario", user.usuario)
        .limit(1)
        .execute()
    )
    if not resposta.data:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
    row = resposta.data[0]
    senha_hash = row.get("senha_hash")
    if not senha_hash:
        raise HTTPException(
            status_code=500,
            detail="Usuário sem senha_hash cadastrado. Peça a um admin para redefinir.",
        )
    if not verificar_senha(body.senha_atual, senha_hash):
        raise HTTPException(status_code=400, detail="A senha atual está incorreta.")
    if body.senha_atual == body.nova_senha:
        raise HTTPException(status_code=400, detail="A nova senha deve ser diferente da atual.")

    novo_hash = gerar_hash(body.nova_senha)
    try:
        client.table("usuarios").update(
            {
                "senha_hash": novo_hash,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("usuario", user.usuario).execute()
    except Exception as e:
        try:
            client.table("usuarios").update(
                {"senha_hash": novo_hash}
            ).eq("usuario", user.usuario).execute()
        except Exception:
            raise HTTPException(
                status_code=500,
                detail=f"Não foi possível alterar a senha. Detalhe: {e}",
            ) from e

    log_evento(user.usuario, "SENHA_ALTERADA", "Senha alterada pelo próprio usuário.")
    return {"ok": True}

@router.post("/recuperar-senha")
def recuperar_senha(body: RecuperarSenhaRequest):
    from ..config import settings

    if not settings.smtp_configurado:
        raise HTTPException(
            status_code=503,
            detail="Recuperação por e-mail não configurada. Contate o administrador.",
        )

    ident = _norm_ident(body.identificador)
    chave = ident.casefold()
    _rate_limit_reset(chave)

    row = _buscar_usuario_por_identificador(ident)
    if not row:
        raise HTTPException(status_code=404, detail="Usuário ou e-mail não encontrado.")
    if not row.get("ativo"):
        raise HTTPException(status_code=400, detail="Esta conta está desativada.")
    email = (row.get("email") or "").strip()
    if not email:
        raise HTTPException(
            status_code=400,
            detail="Esta conta não tem e-mail cadastrado. Contate o administrador.",
        )

    codigo = f"{secrets.randbelow(1_000_000):06d}"
    expira = datetime.now(timezone.utc) + timedelta(minutes=_RESET_TTL_MIN)
    try:
        get_client().table("usuarios").update(
            {
                "reset_codigo_hash": gerar_hash(codigo),
                "reset_expira_em": expira.isoformat(),
            }
        ).eq("usuario", row["usuario"]).execute()
        enviar_codigo_recuperacao(
            destinatario=email,
            nome=str(row.get("nome") or row["usuario"]),
            codigo=codigo,
        )
        log_evento(
            row["usuario"],
            "RECUPERAR_SENHA_ENVIADO",
            "Código de recuperação enviado por e-mail.",
        )
    except HTTPException:
        raise
    except Exception as e:
        detalhe = str(e)
        if "reset_codigo_hash" in detalhe or "PGRST204" in detalhe:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Falta configurar o banco: rode o SQL "
                    "backend/sql/005_recuperacao_senha.sql no Supabase "
                    "(SQL Editor → Run)."
                ),
            ) from e
        raise HTTPException(
            status_code=503,
            detail="Não foi possível enviar o e-mail. Tente novamente mais tarde.",
        ) from e

    return {"ok": True, "mensagem": _MSG_RECUPERAR}

@router.post("/redefinir-senha")
def redefinir_senha(body: RedefinirSenhaRequest):
    ident = _norm_ident(body.identificador)
    chave = ident.casefold()
    _garantir_reset_liberado(chave)

    codigo = body.codigo.strip().replace(" ", "")
    row = _buscar_usuario_por_identificador(ident)

    if not row or not row.get("ativo"):
        _registrar_tentativa_reset_invalida(chave)
        raise HTTPException(status_code=400, detail="Código inválido ou expirado.")

    # Usuário e e-mail apontam para a mesma conta: contam no mesmo bloqueio.
    chave_conta = str(row["usuario"]).casefold()
    _garantir_reset_liberado(chave_conta)

    hash_salvo = row.get("reset_codigo_hash")
    expira = _parse_expira(row.get("reset_expira_em"))
    agora = datetime.now(timezone.utc)

    if not hash_salvo or not expira or expira < agora:
        _registrar_tentativa_reset_invalida(chave, chave_conta)
        raise HTTPException(status_code=400, detail="Código inválido ou expirado.")
    if not verificar_senha(codigo, hash_salvo):
        _registrar_tentativa_reset_invalida(chave, chave_conta)
        log_evento(
            row["usuario"],
            "RESET_CODIGO_INVALIDO",
            "Tentativa de redefinição com código inválido.",
        )
        raise HTTPException(status_code=400, detail="Código inválido ou expirado.")

    _tentativas_reset.pop(chave, None)
    _tentativas_reset.pop(chave_conta, None)
    novo_hash = gerar_hash(body.nova_senha)
    try:
        get_client().table("usuarios").update(
            {
                "senha_hash": novo_hash,
                "reset_codigo_hash": None,
                "reset_expira_em": None,
                "updated_at": agora.isoformat(),
            }
        ).eq("usuario", row["usuario"]).execute()
    except Exception as e:
        try:
            get_client().table("usuarios").update(
                {
                    "senha_hash": novo_hash,
                    "reset_codigo_hash": None,
                    "reset_expira_em": None,
                }
            ).eq("usuario", row["usuario"]).execute()
        except Exception:
            raise HTTPException(
                status_code=500,
                detail=(
                    "Não foi possível redefinir a senha. "
                    "Confirme se rodou backend/sql/005_recuperacao_senha.sql no Supabase. "
                    f"Detalhe: {e}"
                ),
            ) from e

    log_evento(row["usuario"], "SENHA_REDEFINIDA", "Senha redefinida via código de e-mail.")
    return {"ok": True, "mensagem": "Senha redefinida. Faça login com a nova senha."}

@router.post("/logout")
def logout(user: AuthUser = Depends(get_current_user)):
    log_evento(user.usuario, "LOGOUT", f"Logout de {user.usuario}")
    return {"ok": True}
