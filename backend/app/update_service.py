from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

from .config import get_external_path, settings
from .supabase_client import get_client, log_evento
from .version import get_app_version

ProgressCb = Callable[[int, int | None, str], None]

_lock = threading.Lock()
_cache: dict[str, Any] = {"ts": 0.0, "status": None}
_aplicar_em_andamento = False
_progress: dict[str, Any] = {
    "ativo": False,
    "fase": "idle",
    "percent": 0,
    "mensagem": "",
    "erro": None,
    "to_version": None,
    "from_version": None,
    "bytes_baixados": 0,
    "bytes_total": None,
}


@dataclass
class UpdateStatus:
    enabled: bool
    current_version: str
    latest_version: str | None = None
    update_available: bool = False
    mandatory: bool = False
    notes: str = ""
    released_at: str | None = None
    sha256: str | None = None
    size_bytes: int | None = None
    error: str | None = None
    writable: bool = True
    frozen: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _app_dir() -> Path:
    return Path(get_external_path(".")).resolve()


def _update_dir() -> Path:
    return _app_dir() / "_update"


def _set_progress(**kwargs: Any) -> None:
    with _lock:
        _progress.update(kwargs)


def obter_progresso() -> dict[str, Any]:
    with _lock:
        return dict(_progress)


def _parse_version(raw: str) -> tuple[int, ...]:
    texto = (raw or "").strip().lstrip("vV")
    partes = [int(p) for p in re.findall(r"\d+", texto)]
    return tuple(partes) if partes else (0,)


def _version_gt(a: str, b: str) -> bool:
    return _parse_version(a) > _parse_version(b)


def _version_lt(a: str, b: str) -> bool:
    return _parse_version(a) < _parse_version(b)


def _dir_gravavel(pasta: Path) -> bool:
    try:
        pasta.mkdir(parents=True, exist_ok=True)
        probe = pasta / f".write_probe_{os.getpid()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def _fetch_latest_manifest() -> dict[str, Any]:
    url_direta = (settings.update_latest_url or "").strip()
    if url_direta:
        req = urllib.request.Request(
            url_direta,
            headers={"User-Agent": "ConferenciaCD-Updater"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))

    client = get_client()
    data = client.storage.from_(settings.update_bucket).download(settings.update_latest_path)
    if isinstance(data, bytes):
        return json.loads(data.decode("utf-8"))
    return json.loads(bytes(data).decode("utf-8"))


def verificar_atualizacao(*, force: bool = False) -> UpdateStatus:
    atual = get_app_version()
    frozen = bool(getattr(sys, "frozen", False))
    writable = _dir_gravavel(_app_dir())

    base = UpdateStatus(
        enabled=settings.update_enabled,
        current_version=atual,
        writable=writable,
        frozen=frozen,
    )

    if not settings.update_enabled:
        return base

    agora = time.time()
    with _lock:
        if (
            not force
            and _cache["status"] is not None
            and (agora - float(_cache["ts"])) < settings.update_check_ttl_seconds
        ):
            return _cache["status"]

    try:
        manifest = _fetch_latest_manifest()
    except Exception as e:
        base.error = f"Não foi possível consultar a versão remota: {e}"
        with _lock:
            _cache["ts"] = agora
            _cache["status"] = base
        return base

    latest = str(manifest.get("version") or "").strip()
    if not latest:
        base.error = "latest.json sem campo version."
        with _lock:
            _cache["ts"] = agora
            _cache["status"] = base
        return base

    min_version = str(manifest.get("min_version") or "").strip()
    mandatory = bool(manifest.get("mandatory"))
    if min_version and _version_lt(atual, min_version):
        mandatory = True

    available = _version_gt(latest, atual)
    status = UpdateStatus(
        enabled=True,
        current_version=atual,
        latest_version=latest,
        update_available=available,
        mandatory=bool(mandatory and available),
        notes=str(manifest.get("notes") or "").strip(),
        released_at=str(manifest.get("released_at") or "").strip() or None,
        sha256=str(manifest.get("sha256") or "").strip().lower() or None,
        size_bytes=int(manifest["size_bytes"]) if manifest.get("size_bytes") else None,
        writable=writable,
        frozen=frozen,
        error=None,
    )

    with _lock:
        _cache["ts"] = agora
        _cache["status"] = status
        _cache["manifest"] = manifest

    return status


def _sha256_file(path: Path, on_progress: ProgressCb | None = None) -> str:
    total = path.stat().st_size if path.is_file() else 0
    h = hashlib.sha256()
    lidos = 0
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            lidos += len(chunk)
            if on_progress:
                on_progress(lidos, total or None, "verificando")
    return h.hexdigest()


def _google_drive_file_id(url: str) -> str | None:
    texto = (url or "").strip()
    if not texto:
        return None
    m = re.search(r"/file/d/([a-zA-Z0-9_-]+)", texto)
    if m:
        return m.group(1)
    m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", texto)
    if m:
        return m.group(1)
    return None


def _extrair_confirm_drive(html: str) -> str | None:
    m = re.search(r"confirm=([0-9A-Za-z_-]+)", html)
    if m:
        return m.group(1)
    m = re.search(r'"downloadUrl"[^"]*"([^"]+)"', html)
    if m:
        conf = re.search(r"confirm=([0-9A-Za-z_-]+)", m.group(1))
        if conf:
            return conf.group(1)
    return None


def _report_download(lidos: int, total: int | None, expected: int | None = None) -> None:
    base_total = total or expected
    percent = 5
    if base_total and base_total > 0:
        percent = max(5, min(70, int(5 + (lidos / base_total) * 65)))
    mb = lidos / (1024 * 1024)
    if base_total:
        msg = f"Baixando pacote… {mb:.1f} / {base_total / (1024 * 1024):.1f} MB"
    else:
        msg = f"Baixando pacote… {mb:.1f} MB"
    _set_progress(
        fase="baixando",
        percent=percent,
        mensagem=msg,
        bytes_baixados=lidos,
        bytes_total=base_total,
    )


def _baixar_http_para_arquivo(
    url: str,
    dest: Path,
    *,
    timeout: int = 600,
    expected_size: int | None = None,
) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()

    file_id = _google_drive_file_id(url)
    if file_id:
        _baixar_google_drive(file_id, dest, timeout=timeout, expected_size=expected_size)
        return

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 ConferenciaCD-Updater"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp, dest.open("wb") as out:
        total = None
        try:
            total = int(resp.headers.get("Content-Length") or 0) or None
        except Exception:
            total = None
        lidos = 0
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            lidos += len(chunk)
            _report_download(lidos, total, expected_size)

    if not dest.is_file() or dest.stat().st_size < 64:
        raise RuntimeError("Download vazio ou inválido.")


def _baixar_google_drive(
    file_id: str,
    dest: Path,
    *,
    timeout: int = 600,
    expected_size: int | None = None,
) -> None:
    try:
        import requests
    except ImportError as e:
        raise RuntimeError("Biblioteca requests necessária para download do Drive.") from e

    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 ConferenciaCD-Updater"})

    base = "https://drive.usercontent.google.com/download"
    params: dict[str, str] = {"id": file_id, "export": "download", "confirm": "t"}

    resp = session.get(base, params=params, stream=True, timeout=timeout)
    resp.raise_for_status()

    token = None
    for k, v in resp.cookies.items():
        if k.startswith("download_warning"):
            token = v
            break
    if token:
        params["confirm"] = token
        resp.close()
        resp = session.get(base, params=params, stream=True, timeout=timeout)
        resp.raise_for_status()

    ctype = (resp.headers.get("Content-Type") or "").lower()
    if "text/html" in ctype:
        html = resp.text
        resp.close()
        confirm = _extrair_confirm_drive(html) or "t"
        uuid_m = re.search(r'name="uuid"\s+value="([^"]+)"', html)
        params = {"id": file_id, "export": "download", "confirm": confirm}
        if uuid_m:
            params["uuid"] = uuid_m.group(1)
        resp = session.get(base, params=params, stream=True, timeout=timeout)
        resp.raise_for_status()
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if "text/html" in ctype:
            raise RuntimeError(
                "Google Drive bloqueou o download (HTML). "
                "Confirme o compartilhamento: Qualquer pessoa com o link → Leitor."
            )

    total = None
    try:
        total = int(resp.headers.get("Content-Length") or 0) or None
    except Exception:
        total = None

    lidos = 0
    with dest.open("wb") as out:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            if chunk:
                out.write(chunk)
                lidos += len(chunk)
                _report_download(lidos, total, expected_size)
    resp.close()

    if not dest.is_file() or dest.stat().st_size < 1024:
        raise RuntimeError(
            "Download do Drive inválido/muito pequeno. "
            "Verifique o compartilhamento do arquivo."
        )


def _download_pacote(manifest: dict[str, Any], dest: Path) -> None:
    expected = int(manifest["size_bytes"]) if manifest.get("size_bytes") else None
    url = str(manifest.get("url") or "").strip()
    if url:
        _baixar_http_para_arquivo(url, dest, expected_size=expected)
        return

    file_path = str(manifest.get("file") or "").strip()
    if not file_path:
        raise RuntimeError("latest.json sem 'url' nem 'file'.")

    _set_progress(fase="baixando", percent=10, mensagem="Baixando pacote do Storage…")
    client = get_client()
    data = client.storage.from_(settings.update_bucket).download(file_path)
    raw = data if isinstance(data, bytes) else bytes(data)
    dest.write_bytes(raw)
    _set_progress(
        fase="baixando",
        percent=70,
        mensagem=f"Download concluído ({len(raw) / (1024 * 1024):.1f} MB)",
        bytes_baixados=len(raw),
        bytes_total=len(raw),
    )


def _unblock_path(path: Path) -> None:
    """Remove Mark of the Web (Zone.Identifier) sem abrir janelas do PowerShell."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        delete_file = ctypes.windll.kernel32.DeleteFileW

        def _unblock_um(arquivo: Path) -> None:
            ads = str(arquivo.resolve()) + ":Zone.Identifier"
            delete_file(ctypes.c_wchar_p(ads))

        if path.is_file():
            _unblock_um(path)
            return
        if not path.is_dir():
            return
        for arquivo in path.rglob("*"):
            if arquivo.is_file():
                try:
                    _unblock_um(arquivo)
                except Exception:
                    pass
    except Exception:
        pass


def _iniciar_atualizador_externo(
    *,
    app_dir: Path,
    staging: Path,
    exe_name: str,
) -> None:
    """Dispara o .exe NOVO (staging) em modo --atualizar — não trava o exe da pasta do app."""
    upd = _update_dir()
    upd.mkdir(parents=True, exist_ok=True)
    try:
        with (upd / "atualizador.log").open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} Disparando atualizador embutido\n")
    except Exception:
        pass

    staged_exe = staging / exe_name
    if not staged_exe.is_file():
        raise RuntimeError(f"Executável de staging não encontrado: {staged_exe}")

    _unblock_path(staged_exe)

    args = [
        str(staged_exe),
        "--atualizar",
        "--app-dir",
        str(app_dir),
        "--staging",
        str(staging),
        "--exe-name",
        exe_name,
        "--pid",
        str(os.getpid()),
        "--from-version",
        str(get_app_version()),
    ]
    latest = str((obter_progresso().get("to_version") or "")).strip()
    if latest:
        args.extend(["--to-version", latest])

    creationflags = 0
    if sys.platform == "win32":
        # BREAKAWAY evita que o processo morra quando o app principal encerra (Job Object).
        creationflags = (
            getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
            | 0x01000000  # CREATE_BREAKAWAY_FROM_JOB
        )

    subprocess.Popen(
        args,
        cwd=str(staging),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
        close_fds=True,
    )


def _destino_seguro_no_zip(nome: str, raiz: Path) -> Path | None:
    """Resolve o caminho do membro dentro de `raiz`; None se tentar escapar (zip slip)."""
    normalizado = (nome or "").replace("\\", "/")
    if not normalizado or normalizado.startswith("/"):
        return None
    if re.match(r"^[A-Za-z]:", normalizado):
        return None

    partes = [p for p in normalizado.split("/") if p not in ("", ".")]
    if not partes or any(p == ".." for p in partes):
        return None

    destino = (raiz / Path(*partes)).resolve()
    if destino != raiz and raiz not in destino.parents:
        return None
    return destino


def _extrair_zip(zip_path: Path, dest: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    raiz = dest.resolve()

    with zipfile.ZipFile(zip_path, "r") as zf:
        membros = zf.infolist()
        total = max(1, len(membros))
        for i, info in enumerate(membros, start=1):
            destino = _destino_seguro_no_zip(info.filename, raiz)
            if destino is None:
                raise RuntimeError(
                    "Pacote de atualização recusado: o zip tenta gravar fora da pasta "
                    f"de instalação ({info.filename!r})."
                )
            if stat.S_ISLNK(info.external_attr >> 16):
                raise RuntimeError(
                    "Pacote de atualização recusado: link simbólico no zip "
                    f"({info.filename!r})."
                )

            if info.is_dir():
                destino.mkdir(parents=True, exist_ok=True)
            else:
                destino.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as origem, destino.open("wb") as saida:
                    shutil.copyfileobj(origem, saida)

            if i == 1 or i == total or i % 25 == 0:
                pct = 78 + int((i / total) * 10)
                _set_progress(
                    fase="extraindo",
                    percent=min(88, pct),
                    mensagem=f"Extraindo arquivos… {i}/{total}",
                )

    filhos = [p for p in dest.iterdir() if p.name not in {".", ".."}]
    if len(filhos) == 1 and filhos[0].is_dir():
        return filhos[0]
    return dest


def _agendar_encerramento(delay_s: float = 2.5) -> None:
    def _sair() -> None:
        time.sleep(delay_s)
        os._exit(0)

    threading.Thread(target=_sair, daemon=True).start()


def _rodar_atualizacao() -> None:
    global _aplicar_em_andamento
    try:
        if not settings.update_enabled:
            raise RuntimeError("Atualização automática desabilitada no config.ini.")

        if not getattr(sys, "frozen", False):
            raise RuntimeError(
                "Atualização automática só roda no executável instalado (não em modo dev)."
            )

        app_dir = _app_dir()
        if not _dir_gravavel(app_dir):
            raise RuntimeError(
                "Pasta do app sem permissão de escrita. Instale em uma pasta do usuário "
                "(ex.: Documentos\\ConferenciaCD), não em Program Files."
            )

        _set_progress(
            ativo=True,
            fase="preparando",
            percent=2,
            mensagem="Preparando atualização…",
            erro=None,
            from_version=get_app_version(),
        )

        with _lock:
            manifest = _cache.get("manifest")

        if not manifest:
            status = verificar_atualizacao(force=True)
            if status.error:
                raise RuntimeError(status.error)
            with _lock:
                manifest = _cache.get("manifest")
        if not manifest:
            raise RuntimeError("Manifesto de atualização indisponível.")

        latest = str(manifest.get("version") or "").strip()
        if not latest or not _version_gt(latest, get_app_version()):
            raise RuntimeError("Nenhuma versão mais nova disponível.")

        expected_sha = str(manifest.get("sha256") or "").strip().lower()
        if not expected_sha:
            raise RuntimeError("latest.json sem sha256 — update recusado por segurança.")

        _set_progress(to_version=latest, mensagem=f"Atualizando para {latest}…")

        upd = _update_dir()
        upd.mkdir(parents=True, exist_ok=True)
        zip_path = upd / "package.zip"
        staging_root = upd / "staging"
        staging_payload = upd / "payload"

        _set_progress(fase="baixando", percent=5, mensagem="Iniciando download…")
        _download_pacote(manifest, zip_path)
        _set_progress(fase="desbloqueando", percent=72, mensagem="Desbloqueando pacote…")
        _unblock_path(zip_path)

        def _on_hash(lidos: int, total: int | None, _fase: str) -> None:
            pct = 73
            if total:
                pct = 73 + int((lidos / total) * 5)
            _set_progress(
                fase="verificando",
                percent=min(78, pct),
                mensagem="Verificando integridade (SHA-256)…",
            )

        digest = _sha256_file(zip_path, on_progress=_on_hash)
        if digest != expected_sha:
            zip_path.unlink(missing_ok=True)
            raise RuntimeError(
                f"Hash SHA-256 não confere (esperado {expected_sha[:12]}…, "
                f"obtido {digest[:12]}…). Update cancelado — arquivo do Drive pode estar desatualizado."
            )

        _set_progress(fase="extraindo", percent=78, mensagem="Extraindo pacote…")
        payload = _extrair_zip(zip_path, staging_root)
        if staging_payload.exists():
            shutil.rmtree(staging_payload, ignore_errors=True)
        shutil.copytree(payload, staging_payload)
        _set_progress(fase="desbloqueando", percent=90, mensagem="Desbloqueando arquivos…")
        _unblock_path(staging_payload)

        exe_name = "ConferenciaPedidos.exe"
        if not (staging_payload / exe_name).is_file():
            exes = list(staging_payload.glob("*.exe"))
            if not exes:
                raise RuntimeError("Pacote sem executável .exe.")
            exe_name = exes[0].name

        meta = {
            "from_version": get_app_version(),
            "to_version": latest,
            "exe_name": exe_name,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        (upd / "pending.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        _iniciar_atualizador_externo(
            app_dir=app_dir,
            staging=staging_payload,
            exe_name=exe_name,
        )

        _set_progress(
            fase="reiniciando",
            percent=100,
            mensagem="Pacote pronto. Fechando o app — a janela verde do atualizador continua…",
            erro=None,
        )
        _agendar_encerramento(3.0)
    except Exception as e:
        _set_progress(
            ativo=False,
            fase="erro",
            percent=0,
            mensagem="Falha na atualização",
            erro=str(e),
        )
    finally:
        with _lock:
            _aplicar_em_andamento = False


def iniciar_atualizacao(solicitante: str = "") -> dict[str, Any]:
    """Inicia o update em background e devolve imediatamente (UI acompanha via /progress)."""
    global _aplicar_em_andamento

    with _lock:
        if _aplicar_em_andamento or _progress.get("fase") in {
            "preparando",
            "baixando",
            "verificando",
            "extraindo",
            "desbloqueando",
            "reiniciando",
        }:
            raise RuntimeError("Já existe uma atualização em andamento.")
        _aplicar_em_andamento = True
        _progress.update(
            {
                "ativo": True,
                "fase": "preparando",
                "percent": 1,
                "mensagem": "Iniciando…",
                "erro": None,
                "to_version": None,
                "from_version": get_app_version(),
                "bytes_baixados": 0,
                "bytes_total": None,
            }
        )

    log_evento(
        solicitante or "desconhecido",
        "UPDATE_INICIADO",
        f"Atualização disparada a partir da versão {get_app_version()}.",
    )
    threading.Thread(target=_rodar_atualizacao, daemon=True).start()
    return {"ok": True, "message": "Atualização iniciada.", "started": True}
