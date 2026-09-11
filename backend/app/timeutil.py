from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

TZ_BR = ZoneInfo("America/Sao_Paulo")


def agora_br() -> datetime:
    """Agora em Brasília, com OFFSET_HORAS_TESTE do config (só para teste)."""
    from .config import settings

    dt = datetime.now(TZ_BR)
    offset = int(getattr(settings, "offset_horas_teste", 0) or 0)
    if offset:
        dt = dt + timedelta(hours=offset)
    return dt


def hoje_br() -> date:
    return agora_br().date()


def bounds_periodo_br(data_ini: date, data_fim: date) -> tuple[str, str]:
    """
    Início/fim do período no fuso de Brasília, em ISO com offset.
    Evita que 21h de ontem (BRT) entre no filtro de “hoje” por causa do UTC.
    """
    ini = datetime(
        data_ini.year, data_ini.month, data_ini.day, 0, 0, 0, 0, tzinfo=TZ_BR
    )
    fim = datetime(
        data_fim.year,
        data_fim.month,
        data_fim.day,
        23,
        59,
        59,
        999999,
        tzinfo=TZ_BR,
    )
    return ini.isoformat(), fim.isoformat()
