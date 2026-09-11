import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

import { setOffsetHorasTeste } from "./filtrosPedidos";

export type RegrasNegocio = {
  status_coleta_hoje: string;
  status_agendado: string;
  status_parcial: string;
  /** Itens 100% recebidos, mas finalização (AnyMarket/etiqueta) falhou — ex.: erro de NF. */
  status_recebido_pendente: string;
  sheets_status_feito: string;
  sheets_status_parcial: string;
  imprimir_em_parcial: boolean;
  /** Teste: soma horas ao "hoje" dos filtros (vem do config OFFSET_HORAS_TESTE). */
  offset_horas_teste?: number;
};

export const REGRAS_DEFAULT: RegrasNegocio = {
  status_coleta_hoje: "Conferido",
  status_agendado: "Recebido",
  status_parcial: "Recebido Parcial",
  status_recebido_pendente: "Recebido - Pendência Any",
  sheets_status_feito: "FEITO",
  sheets_status_parcial: "FALTANDO ITEM",
  imprimir_em_parcial: false,
  offset_horas_teste: 0,
};

type HealthResponse = {
  status: string;
  version?: string;
  regras?: Partial<RegrasNegocio>;
};

export function useRegras() {
  const { data } = useQuery({
    queryKey: ["regras-negocio"],
    queryFn: async () => {
      const { data } = await api.get<HealthResponse>("/health");
      const regras = { ...REGRAS_DEFAULT, ...(data.regras || {}) } as RegrasNegocio;
      setOffsetHorasTeste(Number(regras.offset_horas_teste) || 0);
      return regras;
    },
    staleTime: 60_000,
  });
  return data ?? REGRAS_DEFAULT;
}

export function statusLiberamImpressao(r: RegrasNegocio): string[] {
  const base = [
    r.sheets_status_feito,
    r.status_coleta_hoje,
    r.status_agendado,
    "FEITO",
    "AG AJUSTE",
    "Conferido",
    "Recebido",
    "Ag. Coleta",
    "Ag. Coleta CD",
  ];
  if (r.imprimir_em_parcial) {
    base.push(r.status_parcial, "Recebido Parcial");
  }
  return [...new Set(base)];
}

export function ehStatusCancelado(status: string | undefined): boolean {
  return (status ?? "").toLowerCase().includes("cancel");
}

/** Recebido/FEITO antecipado no dia da coleta (Status CD = Coleta Hoje). */
export function ehLiberarHojeEraAgendado(
  statusCd: string | undefined,
  statusAny?: string,
  r: RegrasNegocio = REGRAS_DEFAULT
): boolean {
  const cd = (statusCd ?? "").trim();
  // Rótulo legado (antes de unificar em "Coleta Hoje").
  if (cd.startsWith("📦") || cd.includes("Liberar Hoje")) return true;
  if (!cd.startsWith("Coleta Hoje")) return false;
  const any = (statusAny ?? "").trim().toLowerCase();
  if (!any) return false;
  return [r.status_agendado, "Recebido", "FEITO", r.sheets_status_feito]
    .filter(Boolean)
    .some((s) => s.toLowerCase() === any);
}

export function ehStatusFechadoCd(status: string | undefined, r: RegrasNegocio): boolean {
  if (!status) return false;
  if (ehStatusCancelado(status)) return true;
  return [
    r.status_coleta_hoje,
    r.status_agendado,
    r.sheets_status_feito,
    "Conferido",
    "Recebido",
    "FEITO",
    "Ag. Coleta",
    "Ag. Coleta CD",
  ].includes(status);
}

export function ehStatusParcial(status: string | undefined, r: RegrasNegocio): boolean {
  if (!status) return false;
  return status === r.status_parcial || status === "Recebido Parcial";
}

/**
 * Itens 100% recebidos, mas finalização (AnyMarket/etiqueta) falhou.
 * Propositalmente NÃO entra em `ehStatusFechadoCd` — continua contando como
 * pendente (aparece em "Pendentes Hoje"/"Coleta Hoje") até alguém resolver
 * o erro e retomar a finalização.
 */
export function ehRecebidoPendente(status: string | undefined, r: RegrasNegocio): boolean {
  if (!status) return false;
  return status === r.status_recebido_pendente;
}
