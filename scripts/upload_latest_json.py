from __future__ import annotations

"""
Sobe latest.json OU latest-teste.json (+ opcionalmente o ZIP) no bucket app-releases.

  python scripts/upload_latest_json.py
  python scripts/upload_latest_json.py --teste
  python scripts/upload_latest_json.py --also-old
  python scripts/upload_latest_json.py --teste --zip

--also-old: também sobe o mesmo JSON no Supabase ANTIGO (PCs que ainda não
atualizaram). Credenciais em scripts/old_supabase.ini ou env
OLD_SUPABASE_URL / OLD_SUPABASE_KEY.
"""

import argparse
import configparser
import json
import os
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
BUCKET = "app-releases"
OLD_INI = ROOT / "scripts" / "old_supabase.ini"


def _cfg_path() -> Path:
    for p in (ROOT / "config" / "config.ini", ROOT / "config.ini"):
        if p.is_file():
            return p
    raise SystemExit("config.ini não encontrado (config/config.ini ou raiz).")


def _cfg() -> configparser.SectionProxy:
    cfg = configparser.ConfigParser()
    cfg.read(_cfg_path(), encoding="utf-8")
    return cfg["DEFAULT"]


def _old_creds() -> tuple[str, str]:
    url = (os.environ.get("OLD_SUPABASE_URL") or "").strip().rstrip("/")
    key = (os.environ.get("OLD_SUPABASE_KEY") or "").strip()
    if url and key:
        return url, key
    if OLD_INI.is_file():
        cfg = configparser.ConfigParser()
        cfg.read(OLD_INI, encoding="utf-8")
        d = cfg["DEFAULT"] if "DEFAULT" in cfg else {}
        url = str(d.get("SUPABASE_URL", "")).strip().rstrip("/")
        key = str(d.get("SUPABASE_KEY", "")).strip()
        if url and key:
            return url, key
    raise SystemExit(
        "--also-old exige scripts/old_supabase.ini (veja old_supabase.ini.example) "
        "ou env OLD_SUPABASE_URL / OLD_SUPABASE_KEY."
    )


def _put(client: httpx.Client, url: str, key: str, raw: bytes, content_type: str) -> None:
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    resp = client.put(url, content=raw, headers=headers)
    if resp.status_code in (404, 400):
        resp = client.post(url, content=raw, headers=headers)
    if resp.status_code >= 400:
        client.delete(url, headers=headers)
        resp = client.post(url, content=raw, headers=headers)
    resp.raise_for_status()


def _upload_manifest(
    client: httpx.Client,
    *,
    base: str,
    key: str,
    nome_json: str,
    raw: bytes,
    label: str,
) -> None:
    endpoint = f"{base}/storage/v1/object/{BUCKET}/{nome_json}"
    print(f"Enviando {nome_json} -> {label} ({len(raw)} bytes)...")
    _put(client, endpoint, key, raw, "application/json")
    print(f"OK: {nome_json} no bucket {BUCKET} ({label})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--teste", action="store_true")
    parser.add_argument("--zip", action="store_true", help="Também sobe o ZIP do manifest")
    parser.add_argument(
        "--also-old",
        action="store_true",
        help="Também sobe o JSON no Supabase antigo (PCs pré-migração)",
    )
    args = parser.parse_args()

    nome_json = "latest-teste.json" if args.teste else "latest.json"
    path_json = ROOT / "releases" / nome_json
    if not path_json.is_file():
        raise SystemExit(f"{path_json} não encontrado")

    data = json.loads(path_json.read_text(encoding="utf-8"))
    d = _cfg()
    base = d.get("SUPABASE_URL", "").strip().rstrip("/")
    key = d.get("SUPABASE_KEY", "").strip()
    if not base or not key:
        raise SystemExit("SUPABASE_URL / SUPABASE_KEY ausentes no config.ini")

    with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
        if args.zip:
            zip_name = str(data.get("file") or "").strip()
            zip_path = ROOT / "releases" / zip_name
            if not zip_path.is_file():
                raise SystemExit(f"ZIP não encontrado: {zip_path}")
            print(f"Enviando {zip_name} ({zip_path.stat().st_size / 1024 / 1024:.1f} MB)...")
            endpoint_zip = f"{base}/storage/v1/object/{BUCKET}/{zip_name}"
            _put(client, endpoint_zip, key, zip_path.read_bytes(), "application/zip")
            public_url = f"{base}/storage/v1/object/public/{BUCKET}/{zip_name}"
            data["url"] = public_url
            path_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print("OK zip:", public_url)

        if not str(data.get("url") or "").strip() and not str(data.get("file") or "").strip():
            raise SystemExit(f"{nome_json} sem url nem file")

        raw = path_json.read_bytes()
        _upload_manifest(
            client, base=base, key=key, nome_json=nome_json, raw=raw, label="novo"
        )

        if args.also_old:
            old_base, old_key = _old_creds()
            _upload_manifest(
                client,
                base=old_base,
                key=old_key,
                nome_json=nome_json,
                raw=raw,
                label="antigo",
            )

    print("version:", data.get("version"))
    print("url:", data.get("url"))
    print("file:", data.get("file"))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FALHA:", e, file=sys.stderr)
        raise
