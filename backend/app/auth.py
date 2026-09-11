
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from .config import settings, JWT_ALGORITHM
from .supabase_client import get_client, log_evento

security = HTTPBearer()

class AuthUser(BaseModel):
    usuario: str
    nome: str
    role: str
    email: str | None = None
    imagem: str | None = None
    telas: list[str] = []

def gerar_hash(senha_texto: str) -> str:
    return bcrypt.hashpw(senha_texto.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verificar_senha(senha_texto: str, senha_hash: str) -> bool:
    try:
        return bcrypt.checkpw(senha_texto.encode("utf-8"), senha_hash.encode("utf-8"))
    except Exception:
        return False

def _criar_token(user_row: dict) -> str:
    payload = {
        "usuario": user_row["usuario"],
        "nome": user_row.get("nome") or user_row["usuario"],
        "role": user_row["role"],
        "email": user_row.get("email"),
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.jwt_expire_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=JWT_ALGORITHM)

def autenticar(usuario: str, senha: str) -> str:

    client = get_client()
    resp = (
        client.table("usuarios")
        .select("*")
        .eq("usuario", usuario)
        .eq("ativo", True)
        .limit(1)
        .execute()
    )
    if not resp.data:
        log_evento(usuario, "LOGIN_FAILED", f"Tentativa de login falhou para usuário '{usuario}'")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuário ou senha inválidos.")

    user_row = resp.data[0]
    if not verificar_senha(senha, user_row["senha_hash"]):
        log_evento(usuario, "LOGIN_FAILED", f"Tentativa de login falhou para usuário '{usuario}'")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuário ou senha inválidos.")

    log_evento(usuario, "LOGIN_SUCCESS", f"Login realizado por {usuario}")
    return _criar_token(user_row)

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)) -> AuthUser:
    try:
        payload = jwt.decode(creds.credentials, settings.jwt_secret, algorithms=[JWT_ALGORITHM])
        return AuthUser(
            usuario=payload["usuario"],
            nome=payload["nome"],
            role=payload["role"],
            email=payload.get("email"),
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Sessão expirada. Faça login novamente.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token inválido.")

def require_role(*roles: str):

    def _checker(user: AuthUser = Depends(get_current_user)) -> AuthUser:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="Você não tem permissão para acessar este recurso.")
        return user
    return _checker
