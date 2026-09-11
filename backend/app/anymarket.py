
import base64
import json
import os
import random
import re
import socket
import string
import threading
import time
from urllib.parse import urlparse, parse_qs

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .config import settings, resolve_data_file
from .supabase_client import log_evento

TOKEN_FILE = "dados/token_any.json"

def _request_timeout() -> int:
    return settings.anymarket_timeout_seconds

_original_getaddrinfo = socket.getaddrinfo

def _getaddrinfo_ipv4_primeiro(*args, **kwargs):
    resultados = _original_getaddrinfo(*args, **kwargs)
    apenas_ipv4 = [r for r in resultados if r[0] == socket.AF_INET]
    return apenas_ipv4 or resultados

socket.getaddrinfo = _getaddrinfo_ipv4_primeiro

_retry_strategy = Retry(
    total=3,
    backoff_factor=0.3,
    status_forcelist=[429, 502, 503, 504],
    allowed_methods=frozenset(["GET", "HEAD"]),
)
_adapter = HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=_retry_strategy)
http_session = requests.Session()
http_session.mount("http://", _adapter)
http_session.mount("https://", _adapter)

_token_lock = threading.Lock()

_TOKEN_SKEW_SECONDS = 90

def _decode_jwt(token: str) -> dict:
    try:
        payload = token.split(".")[1] + "=" * (-len(token.split(".")[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {"error": "invalid JWT"}

def gerar_token_any(email: str, senha: str):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Connection": "keep-alive",
    }

    login_session = requests.Session()
    login_session.mount("https://", _adapter)
    try:
        state = "".join(random.choices(string.ascii_letters + string.digits, k=8))
        url_inicial = (
            "https://login.anytools.com.br/realms/anytools/protocol/openid-connect/auth"
            "?client_id=anytools-anymarket-sso-client&response_type=code"
            "&redirect_uri=https%3A%2F%2Fapp.anymarket.com.br%2Flogin.html"
            f"&response_mode=query&scope=openid%20email&state={state}"
        )
        resp1 = login_session.get(url_inicial, headers=headers, timeout=_request_timeout())
        if resp1.status_code != 200:
            raise RuntimeError("Falha ao acessar a página inicial do Anytools.")

        match = re.search(r'"loginAction":\s*"([^"]+)"', resp1.text)
        if not match:
            raise RuntimeError("URL 'loginAction' não encontrada. O layout de login pode ter mudado.")
        action_url = match.group(1).replace("\\/", "/")

        resp2 = login_session.post(
            action_url,
            data={"username": email, "password": senha, "credentialId": ""},
            headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
            allow_redirects=True,
            timeout=_request_timeout(),
        )

        query_params = parse_qs(urlparse(resp2.url).query)
        auth_code_list = query_params.get("code")

        if not auth_code_list:
            motivo = "Desconhecido"
            corpo = resp2.text.lower()
            if "invalid username or password" in corpo or "inválido" in corpo or "incorret" in corpo:
                motivo = "E-mail ou senha incorretos."
            elif "captcha" in corpo:
                motivo = "O servidor está pedindo um Captcha de segurança."
            elif any(p in corpo for p in ("bloquead", "disabled", "desabilitad", "locked")):
                motivo = "Conta bloqueada/desabilitada (possivelmente por excesso de tentativas)."
            elif any(p in corpo for p in ("update password", "atualizar sua senha", "atualize sua senha", "termos de uso", "verify email", "verifique seu e-mail")):
                motivo = "A conta está pedindo uma ação extra no Keycloak (trocar senha, aceitar termos, verificar e-mail etc.) antes de liberar o login normal."

            print(f"[anymarket] login action_url={action_url}")
            print(f"[anymarket] resp2 final_url={resp2.url} status={resp2.status_code}")
            trecho = re.sub(r"\s+", " ", resp2.text).strip()[:800]
            print(f"[anymarket] resp2 body (trecho): {trecho}")

            raise RuntimeError(
                f"Credenciais rejeitadas ou falha no redirecionamento (status {resp2.status_code}). "
                f"Motivo provável: {motivo} | Trecho da resposta: {trecho[:300]}"
            )
        auth_code = auth_code_list[0]

        api_headers = {
            "Content-Type": "application/json",
            "Origin": "https://app.anymarket.com.br",
            "Referer": "https://app.anymarket.com.br/login",
        }
        resp3 = login_session.post(
            "https://app.anymarket.com.br/login/v1/token",
            json={"idpId": 23, "idpType": "ANYTOOLS", "authorizationCode": auth_code, "grantType": "AUTHORIZATION_CODE"},
            headers=api_headers,
            timeout=_request_timeout(),
        )
        if resp3.status_code != 200:
            raise RuntimeError(f"Falha ao gerar JWT (status {resp3.status_code}).")
        dados_intermediarios = resp3.json()
        jwt_token = dados_intermediarios.get("token") or dados_intermediarios.get("accessToken")
        login_email = dados_intermediarios.get("login") or email

        organization = settings.org_id
        jwt_payload = _decode_jwt(jwt_token)
        key_str = jwt_payload.get("key", "") if isinstance(jwt_payload, dict) else ""
        org_match = re.search(r"O(.*?)I", key_str)
        if org_match:
            organization = org_match.group(1)

        api_headers["Authorization"] = f"Bearer {jwt_token}"
        resp4 = login_session.post(
            "https://app.anymarket.com.br/login/v1/token",
            json={
                "idpId": 23, "idpType": "ANYTOOLS", "login": login_email,
                "organization": organization, "grantType": "ACCESS_TOKEN",
            },
            headers=api_headers,
            timeout=_request_timeout(),
        )
        if resp4.status_code != 200:
            raise RuntimeError(f"Falha ao gerar Gumga Token (status {resp4.status_code}).")
        gumga_token = resp4.json().get("gumga-token") or resp4.json().get("gumgaToken")

        if not gumga_token:
            raise RuntimeError("Gumga Token vazio na resposta.")
        return {"gumga_token": gumga_token, "bearer_token": jwt_token}

    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Erro de conexão ao gerar token AnyMarket: {e}")
    except Exception as e:
        raise RuntimeError(f"Erro ao gerar novo token AnyMarket: {e}")
    finally:
        login_session.close()

def _carregar_token():
    path = resolve_data_file(TOKEN_FILE)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def _validar_token(token_data) -> bool:
    if not token_data or "decoded_jwt" not in token_data:
        return False
    exp = token_data["decoded_jwt"].get("exp")
    if not exp:
        return False
    return int(time.time()) < (int(exp) - _TOKEN_SKEW_SECONDS)

def _gerar_novo_token():
    token_data = gerar_token_any(settings.anymarket_email, settings.anymarket_senha)
    token_data["decoded_jwt"] = _decode_jwt(token_data["bearer_token"])
    path = resolve_data_file(TOKEN_FILE)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(token_data, f, indent=4, ensure_ascii=False)
    return token_data

def get_valid_token():
    token_data = _carregar_token()
    if _validar_token(token_data):
        return token_data
    with _token_lock:

        token_data = _carregar_token()
        if _validar_token(token_data):
            return token_data
        return _gerar_novo_token()

def request_wrapper(method: str, url: str, **kwargs):
    token_data = get_valid_token()
    if not token_data or "gumga_token" not in token_data:
        raise RuntimeError("Falha de autenticação no SSO da AnyMarket.")

    headers = {
        "gumgaToken": token_data["gumga_token"],
        "x-anymarket-token": token_data["bearer_token"],
        "Accept-Language": "pt-BR",
    }
    if "headers" in kwargs:
        headers.update(kwargs.pop("headers"))
    kwargs.setdefault("timeout", _request_timeout())

    response = http_session.request(method, url, headers=headers, **kwargs)

    if response.status_code == 401:
        with _token_lock:

            token_data = _carregar_token()
            if not _validar_token(token_data):
                token_data = _gerar_novo_token()
        headers.update(
            {
                "gumgaToken": token_data["gumga_token"],
                "x-anymarket-token": token_data["bearer_token"],
            }
        )
        response = http_session.request(method, url, headers=headers, **kwargs)

    return response

def get_link_etiqueta(order_id) -> str:
    return f"https://modules.anymarket.com.br/pickingandpacking/api/pickingandpacking/orders/{order_id}/shipping-label/generate/PDF"

def get_link_danfe(order_id) -> str:
    return f"https://modules.anymarket.com.br/pickingandpacking/api/pickingandpacking/orders/{order_id}/legal-invoices?legalInvoiceType=SIMPLIFIED"

def enviar_para_conferencia(order_id, usuario="sistema"):
    url = f"https://modules.anymarket.com.br/pickingandpacking/api/pickingandpacking/orders/{order_id}/send-to-conference"
    response = request_wrapper("PUT", url)
    if response.status_code in (200, 202):
        log_evento(usuario, "CONFERENCIA_ENVIADA", f"Pedido {order_id} enviado para conferência.", order_id)
        return True, f"Pedido {order_id} enviado para conferência com sucesso."
    if response.status_code == 500 and "could not initialize proxy" in response.text:
        log_evento(usuario, "CONFERENCIA_JA_FEITA", f"Pedido {order_id} já havia sido conferido anteriormente.", order_id)
        return False, f"Pedido {order_id} já foi conferido anteriormente."
    log_evento(usuario, "ERROR", f"Erro ao enviar pedido {order_id} para conferência: {response.status_code}", order_id)
    return False, f"Erro ao enviar pedido {order_id} para conferência: {response.status_code}"

def desmarcar_conferencia(order_id, usuario="sistema"):

    url = (
        "https://modules.anymarket.com.br/pickingandpacking/api/pickingandpacking/"
        f"orders/{order_id}/items/uncheck"
    )
    response = request_wrapper("PUT", url)

    if response.status_code == 500:
        time.sleep(0.6)
        response = request_wrapper("PUT", url)

    if response.status_code in (200, 202):
        return True, f"Conferência do pedido {order_id} desmarcada na AnyMarket."

    corpo = (response.text or "").strip().replace("\n", " ")[:180]
    if response.status_code in (400, 404, 500):
        detalhe = f" HTTP {response.status_code}" + (f" ({corpo})" if corpo else "")
        log_evento(
            usuario,
            "CONFERENCIA_DESMARCADA",
            f"Uncheck AM pedido {order_id} retornou{detalhe}; seguindo reset local.",
            order_id,
        )
        return True, (
            f"AnyMarket não confirmou o uncheck ({response.status_code}); "
            "saldo local será zerado mesmo assim."
        )

    log_evento(
        usuario,
        "ERROR",
        f"Erro ao desmarcar conferência do pedido {order_id}: {response.status_code}",
        order_id,
    )
    return False, f"Erro ao desmarcar conferência: HTTP {response.status_code}"

def get_order_items(order_id):
    url = f"https://modules.anymarket.com.br/pickingandpacking/api/pickingandpacking/orders/{order_id}/items"
    ultimo_status = None
    ultimo_erro = None
    for tentativa in range(3):
        try:
            response = request_wrapper("GET", url)
            ultimo_status = response.status_code
            if response.status_code == 200:
                data = response.json()
                return data if isinstance(data, list) else []
            # Rate limit / instabilidade: espera e tenta de novo.
            if response.status_code in (429, 500, 502, 503, 504) and tentativa < 2:
                time.sleep(0.7 * (tentativa + 1))
                continue
            break
        except requests.exceptions.RequestException as e:
            ultimo_erro = e
            if tentativa < 2:
                time.sleep(0.7 * (tentativa + 1))
                continue
            raise RuntimeError(
                f"AnyMarket falhou ao buscar itens do pedido {order_id}: {e}"
            ) from e

    if ultimo_erro is not None:
        raise RuntimeError(
            f"AnyMarket falhou ao buscar itens do pedido {order_id}: {ultimo_erro}"
        ) from ultimo_erro
    raise RuntimeError(
        f"AnyMarket não retornou itens do pedido {order_id} (HTTP {ultimo_status})."
    )

def conferir_produtos(order_id, usuario="sistema", itens=None):

    if itens is None:
        url_itens = f"https://modules.anymarket.com.br/pickingandpacking/api/pickingandpacking/orders/{order_id}/items"
        response = request_wrapper("GET", url_itens)
        if response.status_code != 200:
            return False, f"Erro ao buscar itens do pedido {order_id}: {response.status_code}"
        itens = response.json()

    payload = []
    for item in itens:
        entry = {"orderItemId": item["orderItemId"], "checked": True}
        if item.get("kitItems"):
            entry["kitChecks"] = [{"orderKitItemId": kit["orderKitItemId"], "checked": True} for kit in item["kitItems"]]
        payload.append(entry)

    url_check = f"https://modules.anymarket.com.br/pickingandpacking/api/pickingandpacking/orders/{order_id}/items/check"
    response = request_wrapper("PUT", url_check, headers={"Content-Type": "application/json"}, json=payload)

    if response.status_code == 500:
        if "could not initialize proxy" in response.text:
            log_evento(usuario, "CONFERENCIA_JA_FEITA", f"Pedido {order_id} já havia sido conferido.", order_id)
            return False, f"Erro 500: Pedido {order_id} já foi conferido."
        log_evento(usuario, "ERROR", f"Erro 500 inesperado ao conferir pedido {order_id}: {response.status_code}", order_id)
        return False, f"Erro 500 inesperado no servidor: {response.status_code}"
    if response.status_code in (200, 202):
        log_evento(usuario, "CONFERENCIA_ITENS", f"Itens do pedido {order_id} conferidos com sucesso.", order_id)
        return True, f"Pedido {order_id} conferido com sucesso."
    log_evento(usuario, "ERROR", f"Erro ao conferir itens do pedido {order_id}: {response.status_code}", order_id)
    return False, f"Erro ao conferir pedido {order_id}: {response.status_code}"

def baixar_documento(url: str, file_path: str):
    try:
        response = request_wrapper("GET", url, headers={"Accept": "application/pdf"})
    except requests.exceptions.RequestException as e:
        return False, f"Erro de conexão ao baixar: {e}"

    if response.status_code == 200:
        try:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(file_path, "wb") as f:
                f.write(response.content)
            return True, "Arquivo baixado com sucesso."
        except Exception as e:
            return False, f"Erro ao salvar arquivo: {e}"
    return False, f"Erro ao baixar: {response.status_code}"


def _mkp_do_pedido(order_id: str) -> str:
    """Lê Mkp do DF em memória (lazy p/ evitar import circular)."""
    try:
        from .pedidos_service import get_pedidos_df

        df = get_pedidos_df()
        if df is None or getattr(df, "empty", True):
            return ""
        if "id_any" not in df.columns or "Mkp" not in df.columns:
            return ""
        oid = str(order_id).strip()
        if not oid:
            return ""
        mask = df["id_any"].astype(str).str.strip() == oid
        if not mask.any():
            return ""
        return str(df.loc[mask, "Mkp"].iloc[0] or "").strip()
    except Exception:
        return ""


def baixar_etiqueta(order_id: str, file_path: str, mkp: str | None = None):
    """
    Baixa a shipping-label. Na Magalu a API manda etiqueta+NF (2 págs);
    gravamos só a 1ª página para não desperdiçar bobina.
    """
    ok, msg = baixar_documento(get_link_etiqueta(order_id), file_path)
    if not ok:
        return ok, msg
    mkp_efetivo = (mkp if mkp is not None else _mkp_do_pedido(order_id)) or ""
    try:
        from .pdf_util import reduzir_etiqueta_se_magalu

        corte_ok, corte_msg = reduzir_etiqueta_se_magalu(file_path, mkp_efetivo)
        if not corte_ok:
            # Download ok; corte falhou — mantém PDF completo e avisa.
            return True, f"{msg} (aviso Magalu: {corte_msg})"
        if corte_msg not in {"não-magalu", "já tinha 1 página"}:
            return True, f"{msg} ({corte_msg})"
    except Exception as e:
        return True, f"{msg} (aviso Magalu: {e})"
    return True, msg


def garantir_etiqueta_magalu_1_pagina(order_id: str, file_path: str, mkp: str | None = None):
    """Aplica o corte em PDF já em cache (ex.: baixado antes desta correção)."""
    if not os.path.isfile(file_path):
        return True, "sem arquivo"
    mkp_efetivo = (mkp if mkp is not None else _mkp_do_pedido(order_id)) or ""
    try:
        from .pdf_util import reduzir_etiqueta_se_magalu

        return reduzir_etiqueta_se_magalu(file_path, mkp_efetivo)
    except Exception as e:
        return False, str(e)
