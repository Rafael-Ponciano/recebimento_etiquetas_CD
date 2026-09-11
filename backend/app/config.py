from __future__ import annotations

import configparser
import os
import secrets
import shutil
import sys
from functools import lru_cache
from pathlib import Path


_DEFAULT_SUPABASE_URL = "https://dknadsjgtlvtlekbrjah.supabase.co"

JWT_ALGORITHM = "HS256"

CONFIG_DIR = "config"
DADOS_DIR = "dados"
TOOLS_DIR = "tools"
LOGS_DIR = "logs"

# Arquivos de dados que migram da raiz → dados/
_DADOS_LEGADO = (
    "recebimento-sa-key.json",
    "credenciais.json",
    "token_any.json",
    "anymarket_token.json",
)


def app_base_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def get_external_path(filename: str) -> str:
    return os.path.join(app_base_dir(), filename)


def config_ini_path() -> str:
    """Path canônico do config.ini (config/ primeiro; raiz legado)."""
    novo = get_external_path(os.path.join(CONFIG_DIR, "config.ini"))
    if os.path.isfile(novo):
        return novo
    legado = get_external_path("config.ini")
    if os.path.isfile(legado):
        return legado
    return novo


def config_example_path() -> str:
    novo = get_external_path(os.path.join(CONFIG_DIR, "config.example.ini"))
    if os.path.isfile(novo):
        return novo
    legado = get_external_path("config.example.ini")
    if os.path.isfile(legado):
        return legado
    return novo


def resolve_data_file(configured: str, *, prefer_dados: bool = True) -> str:
    """Resolve arquivo de dados com fallback raiz ↔ dados/."""
    configured = (configured or "").strip().replace("\\", "/")
    if not configured:
        return get_external_path(DADOS_DIR)
    base_name = os.path.basename(configured)
    candidatos: list[str] = [get_external_path(configured)]
    if base_name != configured:
        candidatos.append(get_external_path(base_name))
    candidatos.append(get_external_path(os.path.join(DADOS_DIR, base_name)))
    for c in candidatos:
        if os.path.isfile(c):
            return c
    if prefer_dados and "/" not in configured and "\\" not in configured:
        return get_external_path(os.path.join(DADOS_DIR, base_name))
    return get_external_path(configured)


def _relocar_ou_limpar_raiz(src: Path, dest: Path, movidos: list[str], destino_label: str) -> None:
    """Move da raiz para pasta canônica; se já existir no destino, apaga o da raiz."""
    if not src.is_file():
        return
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.is_file():
            try:
                shutil.move(str(src), str(dest))
                movidos.append(f"{src.name} -> {destino_label}/")
                return
            except Exception:
                shutil.copy2(src, dest)
                movidos.append(f"{src.name} -> {destino_label}/ (copia)")
        if src.is_file() and dest.is_file():
            try:
                src.unlink(missing_ok=True)
                movidos.append(f"{src.name} removido da raiz (duplicata)")
            except Exception:
                pass
    except Exception:
        pass


def migrar_layout_legado(base: Path | str | None = None) -> list[str]:
    """Move arquivos da raiz para pastas canônicas e remove duplicatas. Idempotente.

    `base` = pasta do app (ao lado do .exe). Em modo atualizador, passar
    explicitamente — o processo roda a partir do staging.
    """
    root = Path(base) if base is not None else Path(app_base_dir())
    movidos: list[str] = []

    for nome in ("config.ini", "config.example.ini"):
        _relocar_ou_limpar_raiz(root / nome, root / CONFIG_DIR / nome, movidos, CONFIG_DIR)

    for nome in _DADOS_LEGADO:
        _relocar_ou_limpar_raiz(root / nome, root / DADOS_DIR / nome, movidos, DADOS_DIR)

    extras = (
        ("atualizador.ps1", TOOLS_DIR, "atualizador.ps1"),
        ("delivery.ico", "static", "delivery.ico"),
        ("conferencia_erro.log", LOGS_DIR, "conferencia_erro.log"),
        ("_ui_cache_version.txt", "_webview_data", "_ui_cache_version.txt"),
    )
    for nome_src, pasta, nome_dest in extras:
        _relocar_ou_limpar_raiz(root / nome_src, root / pasta / nome_dest, movidos, pasta)

    return movidos


def _read_ini() -> configparser.ConfigParser:
    config = configparser.ConfigParser()
    path = config_ini_path()
    if os.path.exists(path):
        config.read(path, encoding="utf-8")
    if "DEFAULT" not in config:
        config["DEFAULT"] = {}
    return config


@lru_cache
def _load_ini():
    return _read_ini()["DEFAULT"]


def _ini(chave: str, default: str = "") -> str:
    return (_load_ini().get(chave) or default).strip()


def _ini_int(chave: str, default: int) -> int:
    raw = _ini(chave, "")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _ini_float(chave: str, default: float) -> float:
    raw = _ini(chave, "")
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _ini_bool(chave: str, default: bool = False) -> bool:
    raw = _ini(chave, "").casefold()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "sim", "on"}:
        return True
    if raw in {"0", "false", "no", "nao", "não", "off"}:
        return False
    return default


_jwt_secret_em_memoria: str | None = None


def _gerar_e_persistir_jwt_secret() -> str:

    global _jwt_secret_em_memoria
    nova_chave = secrets.token_hex(32)
    try:
        config = _read_ini()
        config["DEFAULT"]["JWT_SECRET"] = nova_chave
        path = config_ini_path()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            config.write(f)
        _load_ini.cache_clear()
    except Exception as e:
        print(f"[config] Aviso: não foi possível persistir o JWT_SECRET gerado: {e}")
    _jwt_secret_em_memoria = nova_chave
    return nova_chave


class Settings:

    @property
    def supabase_url(self) -> str:
        return os.environ.get("SUPABASE_URL") or _ini("SUPABASE_URL") or _DEFAULT_SUPABASE_URL

    @property
    def supabase_key(self) -> str:
        valor = (os.environ.get("SUPABASE_KEY") or _ini("SUPABASE_KEY") or "").strip()
        if not valor:
            raise RuntimeError(
                "SUPABASE_KEY não configurada. Use a chave service_role no config.ini "
                "(Supabase Dashboard → Settings → API → service_role)."
            )
        if valor.startswith("sb_publishable_"):
            print(
                "[config] Aviso: SUPABASE_KEY parece publishable. "
                "Use a service_role antes de rodar backend/sql/securizar_tabelas_app.sql."
            )
        return valor

    @property
    def supabase_tabela_pedidos(self) -> str:
        """Legado — lista de pedidos veio do BigQuery; status vai em pedidos_status_manual."""
        return _ini("SUPABASE_TABELA_PEDIDOS", "pedidos_recebimento")

    @property
    def bq_project(self) -> str:
        return _ini("BQ_PROJECT", "recebimento-503922") or "recebimento-503922"

    @property
    def bq_tabela_pedidos(self) -> str:
        return (
            _ini("BQ_TABELA_PEDIDOS", "recebimento-503922.b2c.pedidos_recebimento")
            or "recebimento-503922.b2c.pedidos_recebimento"
        )

    @property
    def bq_credentials_file(self) -> str:
        return (
            _ini("BQ_CREDENTIALS_FILE", f"{DADOS_DIR}/recebimento-sa-key.json")
            or f"{DADOS_DIR}/recebimento-sa-key.json"
        )

    @property
    def jwt_secret(self) -> str:
        global _jwt_secret_em_memoria
        if _jwt_secret_em_memoria:
            return _jwt_secret_em_memoria
        valor = os.environ.get("JWT_SECRET") or _ini("JWT_SECRET")
        if valor:
            _jwt_secret_em_memoria = valor
            return valor
        return _gerar_e_persistir_jwt_secret()

    @property
    def jwt_expire_hours(self) -> int:
        return max(1, _ini_int("JWT_EXPIRE_HOURS", 12))

    @property
    def app_host(self) -> str:
        return _ini("APP_HOST", "127.0.0.1") or "127.0.0.1"

    @property
    def app_port(self) -> int:
        return _ini_int("APP_PORT", 8080)

    @property
    def printer_name(self) -> str:
        return _ini("PRINTER_NAME")

    @property
    def ghostscript_path(self) -> str:
        return _ini("GHOSTSCRIPT_PATH")

    @property
    def print_timeout_seconds(self) -> int:
        return max(5, _ini_int("PRINT_TIMEOUT_SECONDS", 20))

    @property
    def org_id(self) -> str:
        return _ini("ORG_ID", "259061876.")

    @property
    def anymarket_email(self) -> str:
        return os.environ.get("ANYMARKET_EMAIL") or _ini("ANYMARKET_EMAIL")

    @property
    def anymarket_senha(self) -> str:
        return os.environ.get("ANYMARKET_SENHA") or _ini("ANYMARKET_SENHA")

    @property
    def anymarket_timeout_seconds(self) -> int:
        return max(5, _ini_int("ANYMARKET_TIMEOUT_SECONDS", 15))

    @property
    def google_credentials_file(self) -> str:
        return (
            _ini("GOOGLE_CREDENTIALS_FILE", f"{DADOS_DIR}/credenciais.json")
            or f"{DADOS_DIR}/credenciais.json"
        )

    @property
    def sheet_id_b2c(self) -> str:
        return _ini("SHEET_ID_B2C", "10r7ihk4lhUR_8YsS5nkv3kdNLpJ6AfdV7-gD9BU5l7g")

    @property
    def sheet_aba_b2c(self) -> str:
        return _ini("SHEET_ABA_B2C", "Check B2C") or "Check B2C"

    @property
    def sheet_col_status(self) -> int:

        return max(1, _ini_int("SHEET_COL_STATUS", 8))

    @property
    def sheet_col_obs_qtd(self) -> int:
        """Coluna L: observação de quantidade parcial ('Recebemos apenas N')."""
        return max(1, _ini_int("SHEET_COL_OBS_QTD", 12))

    @property
    def sheets_cache_ttl_seconds(self) -> float:
        return max(5.0, _ini_float("SHEETS_CACHE_TTL_SECONDS", 45.0))

    @property
    def cache_pedidos_ttl_seconds(self) -> int:
        """TTL do overlay (status manual + status CD). Barato: só Supabase."""
        return max(30, _ini_int("CACHE_PEDIDOS_TTL_SECONDS", 60))

    @property
    def cache_pedidos_bq_ttl_seconds(self) -> int:
        """TTL da base crua do BigQuery. Alinhe com o intervalo do ETL.

        Cada leitura é um SELECT sem WHERE na tabela de pedidos e o BigQuery
        cobra por bytes escaneados — reler antes de o ETL rodar não traz dado
        novo, só custo.
        """
        return max(60, _ini_int("CACHE_PEDIDOS_BQ_TTL_SECONDS", 900))

    @property
    def cache_itens_ttl_seconds(self) -> int:
        return max(30, _ini_int("CACHE_ITENS_TTL_SECONDS", 300))

    @property
    def downloads_retencao_dias(self) -> int:
        return max(1, _ini_int("DOWNLOADS_RETENCAO_DIAS", 7))

    @property
    def lock_finalizacao_ttl_seconds(self) -> int:
        """Só após esse tempo um lock é tratado como órfão e pode ser liberado."""
        return max(60, _ini_int("LOCK_FINALIZACAO_TTL_SECONDS", 240))

    @property
    def status_coleta_hoje(self) -> str:

        return _ini("STATUS_COLETA_HOJE", "Conferido") or "Conferido"

    @property
    def status_agendado(self) -> str:

        return _ini("STATUS_AGENDADO", "Recebido") or "Recebido"

    @property
    def status_parcial(self) -> str:

        return _ini("STATUS_PARCIAL", "Recebido Parcial") or "Recebido Parcial"

    @property
    def status_recebido_pendente(self) -> str:
        """Itens 100% recebidos, mas finalização (AnyMarket/etiqueta) falhou.

        Distinto de status_parcial: aqui não falta receber nada fisicamente,
        só falta resolver o erro e retomar a finalização (ver AGENTS.md §4.6).
        """
        return (
            _ini("STATUS_RECEBIDO_PENDENTE", "Recebido - Pendência Any")
            or "Recebido - Pendência Any"
        )

    @property
    def sheets_status_feito(self) -> str:

        return _ini("SHEETS_STATUS_FEITO", "FEITO") or "FEITO"

    @property
    def sheets_status_parcial(self) -> str:

        return _ini("SHEETS_STATUS_PARCIAL", "FALTANDO ITEM") or "FALTANDO ITEM"

    @property
    def imprimir_em_parcial(self) -> bool:

        return _ini_bool("IMPRIMIR_EM_PARCIAL", False)

    @property
    def offset_horas_teste(self) -> int:
        """Soma horas ao 'hoje' operacional (Status CD / agendado). 0 = normal. Ex.: 3 às 21h → dia seguinte."""
        return _ini_int("OFFSET_HORAS_TESTE", 0)

    @property
    def smtp_host(self) -> str:
        return _ini("SMTP_HOST", "smtp.gmail.com") or "smtp.gmail.com"

    @property
    def smtp_port(self) -> int:
        return _ini_int("SMTP_PORT", 587)

    @property
    def smtp_user(self) -> str:
        return os.environ.get("SMTP_USER") or _ini("SMTP_USER")

    @property
    def smtp_password(self) -> str:
        return os.environ.get("SMTP_PASSWORD") or _ini("SMTP_PASSWORD")

    @property
    def smtp_from(self) -> str:
        return _ini("SMTP_FROM") or self.smtp_user

    @property
    def smtp_use_tls(self) -> bool:
        return _ini_bool("SMTP_USE_TLS", True)

    @property
    def smtp_configurado(self) -> bool:
        return bool(self.smtp_host and self.smtp_user and self.smtp_password)

    @property
    def update_enabled(self) -> bool:
        return _ini_bool("UPDATE_ENABLED", True)

    @property
    def update_bucket(self) -> str:
        return _ini("UPDATE_BUCKET", "app-releases") or "app-releases"

    @property
    def update_latest_path(self) -> str:
        return _ini("UPDATE_LATEST_PATH", "latest.json") or "latest.json"

    @property
    def update_latest_url(self) -> str:
        """URL absoluta opcional do latest.json (sobrescreve bucket/path)."""
        return _ini("UPDATE_LATEST_URL")

    @property
    def update_check_ttl_seconds(self) -> int:
        return max(30, _ini_int("UPDATE_CHECK_TTL_SECONDS", 300))

    def regras_negocio(self) -> dict:

        return {
            "status_coleta_hoje": self.status_coleta_hoje,
            "status_agendado": self.status_agendado,
            "status_parcial": self.status_parcial,
            "status_recebido_pendente": self.status_recebido_pendente,
            "sheets_status_feito": self.sheets_status_feito,
            "sheets_status_parcial": self.sheets_status_parcial,
            "imprimir_em_parcial": self.imprimir_em_parcial,
            "offset_horas_teste": self.offset_horas_teste,
        }


settings = Settings()
