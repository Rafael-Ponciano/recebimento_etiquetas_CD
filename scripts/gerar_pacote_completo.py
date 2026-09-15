from __future__ import annotations

"""
Gera o ZIP completo da release + latest.json (ou latest-teste.json).

Uso:
  python scripts/gerar_pacote_completo.py
  python scripts/gerar_pacote_completo.py --teste
  python scripts/gerar_pacote_completo.py --teste --notes "..."
  python scripts/gerar_pacote_completo.py --drive-url "https://..."
"""

import argparse
import hashlib
import json
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "release"
OUT_DIR = ROOT / "releases"

# Empacota a chave SA no ZIP (necessária pro BigQuery). Nunca empacota config.ini.
SKIP_NAMES = {"config.ini", "credenciais.json"}
# Pastas que nunca entram no ZIP (cache WebView2, dados de dev, etc.)
SKIP_DIRS = {"_webview_data"}


def _version() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip().splitlines()[0].strip()


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def compactar(zip_path: Path) -> int:
    if zip_path.exists():
        zip_path.unlink()
    count = 0
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in SRC.rglob("*"):
            if not path.is_file():
                continue
            if path.name.lower() in SKIP_NAMES:
                continue
            # Ignora pastas de cache/runtime que não devem ir no pacote
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            rel = path.relative_to(SRC).as_posix()
            zf.write(path, arcname=rel)
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--drive-url", default="", help="Link público do ZIP (Drive ou HTTPS)")
    parser.add_argument(
        "--teste",
        action="store_true",
        help="Gera latest-teste.json (canal de teste; não sobrescreve latest.json)",
    )
    parser.add_argument("--notes", default="", help="Notas da versão")
    args = parser.parse_args()

    if not SRC.is_dir():
        raise SystemExit("Pasta release\\ não existe. Rode build.bat antes.")

    sa = SRC / "dados" / "recebimento-sa-key.json"
    if not sa.is_file():
        sa = SRC / "recebimento-sa-key.json"
    if not sa.is_file():
        print("AVISO: release\\dados\\recebimento-sa-key.json ausente — BQ falhará nos PCs.")

    version = _version()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    zip_name = f"ConferenciaPedidos-{version}.zip"
    zip_path = OUT_DIR / zip_name

    print(f"Compactando release\\ -> {zip_path} ...")
    n = compactar(zip_path)
    digest = _sha256(zip_path)
    size = zip_path.stat().st_size

    notes = (args.notes or "").strip()
    if not notes:
        if args.teste:
            notes = (
                f"TESTE {version} — UI compacta, filtros Erro Integração / Agendados Recebidos, "
                "histórico paginado, merge automático de config.ini + chave BQ. "
                "Não usar como latest.json oficial."
            )
        else:
            notes = f"Versão {version} do Conferência CD."

    latest = {
        "version": version,
        "min_version": "1.0.0",
        "mandatory": False,
        "released_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "notes": notes,
        "file": zip_name,
        "sha256": digest,
        "size_bytes": size,
    }
    drive_url = (args.drive_url or "").strip()
    latest["url"] = drive_url

    out_json = OUT_DIR / ("latest-teste.json" if args.teste else "latest.json")
    out_json.write_text(json.dumps(latest, ensure_ascii=False, indent=2), encoding="utf-8")

    print("OK")
    print(f"  arquivos: {n}")
    print(f"  zip:      {zip_path}")
    print(f"  tamanho:  {size / 1024 / 1024:.2f} MB")
    print(f"  sha256:   {digest}")
    print(f"  json:     {out_json}")
    if drive_url:
        print(f"  url:      {drive_url}")
    else:
        print("")
        print("Sem --drive-url: o updater pode baixar via 'file' no bucket, ou preencha url depois.")


if __name__ == "__main__":
    main()
