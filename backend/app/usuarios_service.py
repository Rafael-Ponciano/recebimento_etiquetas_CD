"""Utilidades genéricas de usuário, sem relação com chat/conferência.

Extraído de `chat_service.py` na remoção do chat (o chat foi desligado e
depois removido; esta função era reaproveitada por `acesso_telas_router` e
`etiqueta_prefetch_router` e não podia sumir junto).
"""

from __future__ import annotations

from .supabase_client import get_client, executar_com_retry


def listar_usuarios(eu: str) -> list[dict]:
    """Lista usuários cadastrados (exclui o próprio `eu`)."""
    client = get_client()
    resp = executar_com_retry(
        lambda: (
            client.table("usuarios")
            .select("usuario,nome,role,imagem")
            .order("nome")
            .limit(200)
            .execute()
        )
    )
    items = []
    for row in resp.data or []:
        u = str(row.get("usuario") or "").strip()
        if not u or u.casefold() == eu.casefold():
            continue
        items.append(
            {
                "usuario": u,
                "nome": row.get("nome") or u,
                "role": row.get("role"),
                "imagem": row.get("imagem"),
            }
        )
    return items
