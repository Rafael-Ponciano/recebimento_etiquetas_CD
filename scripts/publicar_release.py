from __future__ import annotations

"""
Publica uma release completa via GitHub Releases + Supabase Storage.

Substitui o fluxo manual de upload no Google Drive.

Uso:
  python scripts/publicar_release.py --notes "resumo da mudança"
  python scripts/publicar_release.py --notes "..." --teste

O script:
  1. Lê a VERSION e o ZIP em releases/ConferenciaPedidos-<VERSION>.zip
  2. Cria (ou sobrescreve) a GitHub Release v<VERSION> no repo
  3. Anexa o ZIP como asset da release
  4. Pega a URL de download direta do asset
  5. Atualiza releases/latest.json com a URL do GitHub
  6. Publica o latest.json no Supabase Storage (bucket app-releases)

Pré-requisitos:
  - gh CLI autenticado (gh auth status)
  - ZIP já gerado (python scripts/gerar_pacote_completo.py --notes "...")
  - config/config.ini ou config.ini com SUPABASE_URL / SUPABASE_KEY
"""

import argparse
import configparser
import json
import subprocess
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
REPO = "Rafael-Ponciano/recebimento_etiquetas_CD"
BUCKET = "app-releases"


def _version() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip().splitlines()[0].strip()


def _cfg_path() -> Path:
    for p in (ROOT / "config" / "config.ini", ROOT / "config.ini"):
        if p.is_file():
            return p
    raise SystemExit("config.ini não encontrado (config/config.ini ou raiz).")


def _cfg() -> configparser.SectionProxy:
    cfg = configparser.ConfigParser()
    cfg.read(_cfg_path(), encoding="utf-8")
    return cfg["DEFAULT"]


def _gh(*args: str) -> str:
    """Roda um comando gh e retorna stdout. Levanta SystemExit em erro."""
    result = subprocess.run(
        ["gh", *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if result.returncode != 0:
        print("ERRO gh:", result.stderr.strip(), file=sys.stderr)
        raise SystemExit(1)
    return result.stdout.strip()


def _put_supabase(client: httpx.Client, base: str, key: str, nome: str, raw: bytes) -> None:
    url = f"{base}/storage/v1/object/{BUCKET}/{nome}"
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
        "x-upsert": "true",
    }
    resp = client.put(url, content=raw, headers=headers)
    if resp.status_code in (404, 400):
        resp = client.post(url, content=raw, headers=headers)
    if resp.status_code >= 400:
        client.delete(url, headers=headers)
        resp = client.post(url, content=raw, headers=headers)
    resp.raise_for_status()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--notes", default="", help="Notas da versão (resumo para o operador)")
    parser.add_argument(
        "--teste",
        action="store_true",
        help="Publica como pre-release (latest-teste.json no Supabase; tag v<VERSION>-teste no GitHub)",
    )
    args = parser.parse_args()

    version = _version()
    tag = f"v{version}" + ("-teste" if args.teste else "")
    nome_json = "latest-teste.json" if args.teste else "latest.json"
    zip_name = f"ConferenciaPedidos-{version}.zip"
    zip_path = ROOT / "releases" / zip_name
    json_path = ROOT / "releases" / nome_json

    if not zip_path.is_file():
        raise SystemExit(
            f"ZIP não encontrado: {zip_path}\n"
            f"Rode antes: python scripts/gerar_pacote_completo.py --notes \"...\""
        )
    if not json_path.is_file():
        raise SystemExit(f"latest.json não encontrado: {json_path}")

    data = json.loads(json_path.read_text(encoding="utf-8"))

    # ── 1. Apaga release anterior com a mesma tag (se existir) ──────────────
    print(f"Verificando release existente para {tag}...")
    existing = subprocess.run(
        ["gh", "release", "view", tag, "--repo", REPO, "--json", "tagName"],
        capture_output=True, text=True, cwd=ROOT,
    )
    if existing.returncode == 0:
        print(f"  Deletando release anterior {tag}...")
        _gh("release", "delete", tag, "--repo", REPO, "--yes", "--cleanup-tag")

    # ── 2. Cria a GitHub Release ─────────────────────────────────────────────
    print(f"Criando GitHub Release {tag}...")
    notes = args.notes or f"Release {version}"
    create_args = [
        "release", "create", tag,
        "--repo", REPO,
        "--title", f"v{version}",
        "--notes", notes,
    ]
    if args.teste:
        create_args.append("--prerelease")
    _gh(*create_args)
    print(f"  Release criada: https://github.com/{REPO}/releases/tag/{tag}")

    # ── 3. Anexa o ZIP como asset ────────────────────────────────────────────
    print(f"Enviando {zip_name} ({zip_path.stat().st_size / 1024 / 1024:.1f} MB)...")
    _gh(
        "release", "upload", tag,
        str(zip_path),
        "--repo", REPO,
        "--clobber",
    )
    print("  Upload concluído.")

    # ── 4. Pega a URL de download direta do asset ────────────────────────────
    print("Obtendo URL do asset...")
    assets_json = _gh(
        "release", "view", tag,
        "--repo", REPO,
        "--json", "assets",
    )
    assets = json.loads(assets_json).get("assets", [])
    asset = next((a for a in assets if a["name"] == zip_name), None)
    if not asset:
        raise SystemExit(f"Asset {zip_name} não encontrado na release {tag} após upload.")
    download_url = asset["url"]  # URL direta do asset (browser_download_url)
    # gh retorna 'url' como API url; preferimos browser_download_url para o updater
    browser_url = asset.get("url", download_url)
    # Monta a URL pública de download direto
    public_url = f"https://github.com/{REPO}/releases/download/{tag}/{zip_name}"
    print(f"  URL: {public_url}")

    # ── 5. Atualiza o latest.json com a URL do GitHub ────────────────────────
    data["url"] = public_url
    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  {nome_json} atualizado com URL do GitHub.")

    # ── 6. Publica latest.json no Supabase ───────────────────────────────────
    d = _cfg()
    base = d.get("SUPABASE_URL", "").strip().rstrip("/")
    key = d.get("SUPABASE_KEY", "").strip()
    if not base or not key:
        raise SystemExit("SUPABASE_URL / SUPABASE_KEY ausentes no config.ini")

    raw = json_path.read_bytes()
    print(f"Publicando {nome_json} no Supabase ({len(raw)} bytes)...")
    with httpx.Client(timeout=httpx.Timeout(60.0, connect=15.0)) as client:
        _put_supabase(client, base, key, nome_json, raw)
    print(f"  OK: {nome_json} no bucket {BUCKET}")

    # ── Resumo ───────────────────────────────────────────────────────────────
    print()
    print("=" * 55)
    print(f"  Release {version} publicada com sucesso!")
    print(f"  GitHub : https://github.com/{REPO}/releases/tag/{tag}")
    print(f"  URL ZIP: {public_url}")
    print(f"  sha256 : {data.get('sha256', '?')}")
    print("=" * 55)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FALHA:", e, file=sys.stderr)
        raise
