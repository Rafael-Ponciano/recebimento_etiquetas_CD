import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  Clock,
  Truck,
  RotateCw,
  AlertTriangle,
  Info,
  Package,
  Calendar,
  CheckCircle2,
  XCircle,
  Car,
  User,
  Hash,
} from "lucide-react";
import { api } from "../lib/api";

export type DispatchDetail = {
  from: string | null;
  to: string | null;
  cutoff: string | null;
  carrier?: { id: number | null; name: string | null } | null;
  vehicle?: {
    id: number | null;
    licensePlate: string | null;
    vehicleType: string | null;
    onlyForToday?: boolean;
    newDriver?: boolean;
  } | null;
  driver?: { id: number | null; name: string | null } | null;
  sla?: string | null;
  logisticType?: string | null;
};

export type ProcessingOption = {
  processingTime: string;
  selected: boolean;
  cutoff: string | null;
  disabled: boolean;
};

export type CapacityInfo = {
  value: number;
  minimum?: number;
  maximum?: number;
  canAdd?: boolean;
  canSubtract?: boolean;
  intervention?: string | null;
};

export type DaySchedule = {
  work: boolean;
  detail?: DispatchDetail[] | null;
  availableOptions?: ProcessingOption[] | null;
  capacity?: CapacityInfo | null;
};

export type ColetaMeliData = {
  accountId: number;
  logisticType: string;
  marketplace: string;
  monday: DaySchedule;
  tuesday: DaySchedule;
  wednesday: DaySchedule;
  thursday: DaySchedule;
  friday: DaySchedule;
  saturday: DaySchedule;
  sunday: DaySchedule;
};

type DayKey = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

const DIAS_CONFIG: { key: DayKey; label: string; indexSemana: number }[] = [
  { key: "monday", label: "Segunda", indexSemana: 1 },
  { key: "tuesday", label: "Terça", indexSemana: 2 },
  { key: "wednesday", label: "Quarta", indexSemana: 3 },
  { key: "thursday", label: "Quinta", indexSemana: 4 },
  { key: "friday", label: "Sexta", indexSemana: 5 },
  { key: "saturday", label: "Sábado", indexSemana: 6 },
  { key: "sunday", label: "Domingo", indexSemana: 0 },
];

export default function ColetaMeliPage() {
  const [dataAtualizacao, setDataAtualizacao] = useState<string | null>(null);

  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<ColetaMeliData>({
    queryKey: ["coleta-meli-horarios"],
    queryFn: async () => {
      const resp = await api.get<ColetaMeliData>("/expedicao/coleta-meli");
      setDataAtualizacao(new Date().toLocaleTimeString("pt-BR"));
      return resp.data;
    },
    staleTime: 60_000 * 5, // 5 min
    refetchOnWindowFocus: false,
  });

  // Mapeia os 7 dias da semana corrente (Segunda a Domingo)
  const colunasSemana = useMemo(() => {
    const hoje = new Date();
    const diaHojeSemana = hoje.getDay(); // 0 = Domingo, 1 = Segunda, etc.
    const diffParaSegunda = diaHojeSemana === 0 ? -6 : 1 - diaHojeSemana;
    const segundaFeira = new Date(hoje);
    segundaFeira.setDate(hoje.getDate() + diffParaSegunda);

    return DIAS_CONFIG.map((d, index) => {
      const diaObj = new Date(segundaFeira);
      diaObj.setDate(segundaFeira.getDate() + index);

      const ehHoje = diaObj.toDateString() === hoje.toDateString();
      const dataFormatada = diaObj.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

      const schedule = data ? data[d.key] : null;

      return {
        ...d,
        dataStr: dataFormatada,
        ehHoje,
        schedule,
      };
    });
  }, [data]);

  // Estatísticas rápidas
  const resumo = useMemo(() => {
    if (!data) return null;
    let diasAtivos = 0;
    let capacidadeTotal = 0;

    colunasSemana.forEach((c) => {
      if (c.schedule?.work) {
        diasAtivos++;
        capacidadeTotal += c.schedule.capacity?.value ?? 0;
      }
    });

    const capacidadeMedia = diasAtivos > 0 ? Math.round(capacidadeTotal / diasAtivos) : 0;
    const colHoje = colunasSemana.find((c) => c.ehHoje);

    return {
      diasAtivos,
      capacidadeTotal,
      capacidadeMedia,
      colHoje,
    };
  }, [data, colunasSemana]);

  return (
    <div className="flex-1 overflow-y-auto bg-void p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Cabeçalho da Tela */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-elevated text-amber shadow-xs">
              <CalendarClock size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="font-display text-xl font-bold tracking-tight text-text">
                  Coleta Meli
                </h1>
                <span className="inline-flex items-center gap-1 rounded-full border border-amber/30 bg-amber/10 px-2 py-0.5 text-[11px] font-medium text-amber">
                  Mercado Envios Coleta
                </span>
              </div>
              <p className="text-xs text-text-muted">
                Grade de horários de corte, janelas de expedição e capacidade diária de pacotes
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {dataAtualizacao && (
              <span className="text-[11px] font-mono text-text-faint">
                Atualizado às {dataAtualizacao}
              </span>
            )}
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text transition hover:bg-elevated hover:text-text-bright disabled:opacity-50"
            >
              <RotateCw size={14} className={isFetching ? "animate-spin text-amber" : ""} />
              Atualizar Grade
            </button>
          </div>
        </div>

        {/* Card Informativo com Filtros Fixos da Operação */}
        <div className="flex flex-wrap items-center gap-y-2 gap-x-6 rounded-lg border border-border-soft bg-surface/80 px-4 py-2.5 text-xs text-text-muted">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wider text-[10px] text-text-faint">
              Marketplace:
            </span>
            <span className="font-medium text-text">Mercado Livre</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wider text-[10px] text-text-faint">
              Conta:
            </span>
            <span className="font-mono text-text">PEPE202404301611S4 (47155)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wider text-[10px] text-text-faint">
              Modo de Envio:
            </span>
            <span className="font-medium text-text">Mercado Envios Coleta (Cross-docking)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold uppercase tracking-wider text-[10px] text-text-faint">
              Local de Estoque:
            </span>
            <span className="font-medium text-text">Estoque Físico (7341)</span>
          </div>
        </div>

        {/* Cards de Resumo Operacional */}
        {resumo && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Card Hoje */}
            <div className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-muted">Operação de Hoje</span>
                <span className="rounded-md bg-amber/10 px-2 py-0.5 text-[10px] font-semibold text-amber uppercase">
                  {resumo.colHoje?.label || "Hoje"}
                </span>
              </div>
              <div className="mt-2.5">
                {resumo.colHoje?.schedule?.work ? (
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-2xl font-bold tracking-tight text-text">
                        {resumo.colHoje.schedule.detail?.[0]?.cutoff || "—"}
                      </span>
                      <span className="text-xs text-text-muted">Horário de corte</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-text-faint">
                      <span>
                        Janela:{" "}
                        <strong className="text-text font-mono font-medium">
                          {resumo.colHoje.schedule.detail?.[0]?.from} às{" "}
                          {resumo.colHoje.schedule.detail?.[0]?.to}
                        </strong>
                      </span>
                      <span>
                        Capacidade:{" "}
                        <strong className="text-amber font-mono font-bold">
                          {resumo.colHoje.schedule.capacity?.value}
                        </strong>
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 py-1 text-text-faint">
                    <XCircle size={16} />
                    <span className="text-xs">Sem coleta programada para hoje</span>
                  </div>
                )}
              </div>
            </div>

            {/* Dias com Coleta */}
            <div className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-muted">Dias Ativos</span>
                <Calendar size={14} className="text-text-faint" />
              </div>
              <div className="mt-2.5 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-bold tracking-tight text-text">
                  {resumo.diasAtivos} / 7
                </span>
                <span className="text-xs text-text-muted">dias na semana</span>
              </div>
              <p className="mt-1 text-[11px] text-text-faint">
                Terça a Sexta-feira ativos (Seg, Sáb e Dom sem coleta)
              </p>
            </div>

            {/* Capacidade Média */}
            <div className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-muted">Capacidade Diária</span>
                <Package size={14} className="text-text-faint" />
              </div>
              <div className="mt-2.5 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-bold tracking-tight text-amber">
                  {resumo.capacidadeMedia}
                </span>
                <span className="text-xs text-text-muted">pedidos / dia ativo</span>
              </div>
              <p className="mt-1 text-[11px] text-text-faint">
                Total semanal programado: {resumo.capacidadeTotal} pacotes
              </p>
            </div>

            {/* Janela de Coleta */}
            <div className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-muted">Janela de Envio</span>
                <Truck size={14} className="text-text-faint" />
              </div>
              <div className="mt-2.5 flex items-baseline gap-2">
                <span className="font-mono text-xl font-bold tracking-tight text-text">
                  13:00 às 15:00
                </span>
              </div>
              <p className="mt-1 text-[11px] text-text-faint">
                Horário padrão de passagem do veículo de coleta
              </p>
            </div>
          </div>
        )}

        {/* Estado de Carregamento e Erro */}
        {isLoading && (
          <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-border bg-surface/50 text-text-muted">
            <RotateCw size={28} className="animate-spin text-amber" />
            <span className="mt-3 text-sm font-medium">Consultando grade do Mercado Livre na AnyMarket...</span>
          </div>
        )}

        {isError && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-red/40 bg-red/10 p-8 text-center text-red">
            <AlertTriangle size={32} />
            <h3 className="mt-2 text-base font-semibold">Falha ao obter dados da grade</h3>
            <p className="mt-1 max-w-md text-xs text-red/80">
              {error instanceof Error ? error.message : "Não foi possível conectar com a AnyMarket."}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-4 rounded-md border border-red/40 bg-red/20 px-4 py-2 text-xs font-medium text-red hover:bg-red/30"
            >
              Tentar Novamente
            </button>
          </div>
        )}

        {/* Tabela Principal — Grade Semanal (Segunda a Domingo) */}
        {!isLoading && !isError && data && (
          <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-elevated/70">
                    <th className="w-48 border-r border-border-soft p-3 font-semibold uppercase tracking-wider text-[11px] text-text-muted">
                      Campo / Regra
                    </th>
                    {colunasSemana.map((col) => {
                      const ativo = col.schedule?.work ?? false;
                      return (
                        <th
                          key={col.key}
                          className={`min-w-[150px] border-r border-border-soft p-3 last:border-r-0 ${
                            col.ehHoje
                              ? "bg-amber/10 text-amber font-semibold"
                              : ativo
                                ? "text-text"
                                : "text-text-faint bg-surface/30"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-sm">{col.label}</span>
                            {col.ehHoje && (
                              <span className="rounded-full bg-amber px-1.5 py-0.2 text-[9px] font-bold text-void uppercase">
                                Hoje
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] opacity-80">
                            {col.dataStr}
                          </div>
                          <div className="mt-1">
                            {ativo ? (
                              <span className="inline-flex items-center gap-1 text-[10px] text-green">
                                <CheckCircle2 size={11} /> Coleta Ativa
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] text-text-faint">
                                <XCircle size={11} /> Sem Coleta
                              </span>
                            )}
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>

                <tbody className="divide-y divide-border-soft">
                  {/* Linha 1: Horário de Corte */}
                  <tr className="hover:bg-elevated/30">
                    <td className="border-r border-border-soft bg-surface/40 p-3 font-medium text-text-muted">
                      <div className="flex items-center gap-2">
                        <Clock size={14} className="text-amber" />
                        <span>Horário de corte</span>
                      </div>
                    </td>
                    {colunasSemana.map((col) => {
                      const cutoff = col.schedule?.detail?.[0]?.cutoff;
                      const ativo = col.schedule?.work;
                      return (
                        <td
                          key={col.key}
                          className={`border-r border-border-soft p-3 font-mono text-sm last:border-r-0 ${
                            col.ehHoje ? "bg-amber/5 font-semibold text-amber" : ""
                          }`}
                        >
                          {ativo && cutoff ? (
                            <span className="rounded bg-elevated px-2 py-0.5 text-text font-bold">
                              {cutoff}
                            </span>
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Linha 2: Horário de Envio / Janela de Coleta */}
                  <tr className="hover:bg-elevated/30">
                    <td className="border-r border-border-soft bg-surface/40 p-3 font-medium text-text-muted">
                      <div className="flex items-center gap-2">
                        <Truck size={14} className="text-text-faint" />
                        <span>Horário de envio</span>
                      </div>
                    </td>
                    {colunasSemana.map((col) => {
                      const detail = col.schedule?.detail?.[0];
                      const ativo = col.schedule?.work;
                      return (
                        <td
                          key={col.key}
                          className={`border-r border-border-soft p-3 font-mono text-xs last:border-r-0 ${
                            col.ehHoje ? "bg-amber/5" : ""
                          }`}
                        >
                          {ativo && detail?.from && detail?.to ? (
                            <span className="text-text">
                              De <strong className="font-semibold">{detail.from}</strong> até{" "}
                              <strong className="font-semibold">{detail.to}</strong>
                            </span>
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Linha 3: Motorista */}
                  <tr className="hover:bg-elevated/30">
                    <td className="border-r border-border-soft bg-surface/40 p-3 font-medium text-text-muted">
                      <div className="flex items-center gap-2">
                        <User size={14} className="text-text-faint" />
                        <span>Motorista</span>
                      </div>
                    </td>
                    {colunasSemana.map((col) => {
                      const driver = col.schedule?.detail?.[0]?.driver?.name;
                      return (
                        <td
                          key={col.key}
                          className={`border-r border-border-soft p-3 text-xs last:border-r-0 ${
                            col.ehHoje ? "bg-amber/5" : ""
                          }`}
                        >
                          {driver ? (
                            <span className="text-text">{driver}</span>
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Linha 4: Veículo */}
                  <tr className="hover:bg-elevated/30">
                    <td className="border-r border-border-soft bg-surface/40 p-3 font-medium text-text-muted">
                      <div className="flex items-center gap-2">
                        <Car size={14} className="text-text-faint" />
                        <span>Veículo</span>
                      </div>
                    </td>
                    {colunasSemana.map((col) => {
                      const vehicle = col.schedule?.detail?.[0]?.vehicle?.vehicleType;
                      return (
                        <td
                          key={col.key}
                          className={`border-r border-border-soft p-3 text-xs last:border-r-0 ${
                            col.ehHoje ? "bg-amber/5" : ""
                          }`}
                        >
                          {vehicle ? (
                            <span className="text-text">{vehicle}</span>
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Linha 5: Placa */}
                  <tr className="hover:bg-elevated/30">
                    <td className="border-r border-border-soft bg-surface/40 p-3 font-medium text-text-muted">
                      <div className="flex items-center gap-2">
                        <Hash size={14} className="text-text-faint" />
                        <span>Placa</span>
                      </div>
                    </td>
                    {colunasSemana.map((col) => {
                      const plate = col.schedule?.detail?.[0]?.vehicle?.licensePlate;
                      return (
                        <td
                          key={col.key}
                          className={`border-r border-border-soft p-3 font-mono text-xs last:border-r-0 ${
                            col.ehHoje ? "bg-amber/5" : ""
                          }`}
                        >
                          {plate ? (
                            <span className="text-text">{plate}</span>
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Linha 6: Transportadora */}
                  <tr className="hover:bg-elevated/30">
                    <td className="border-r border-border-soft bg-surface/40 p-3 font-medium text-text-muted">
                      <div className="flex items-center gap-2">
                        <Truck size={14} className="text-text-faint" />
                        <span>Transportadora</span>
                      </div>
                    </td>
                    {colunasSemana.map((col) => {
                      const carrier = col.schedule?.detail?.[0]?.carrier?.name;
                      return (
                        <td
                          key={col.key}
                          className={`border-r border-border-soft p-3 text-xs last:border-r-0 ${
                            col.ehHoje ? "bg-amber/5" : ""
                          }`}
                        >
                          {carrier ? (
                            <span className="text-text">{carrier}</span>
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Linha 7: Tempo de Processamento */}
                  <tr className="hover:bg-elevated/30">
                    <td className="border-r border-border-soft bg-surface/40 p-3 font-medium text-text-muted">
                      <div className="flex items-center gap-2">
                        <Clock size={14} className="text-text-faint" />
                        <span>Tempo de processamento</span>
                      </div>
                    </td>
                    {colunasSemana.map((col) => {
                      const selectedOption = col.schedule?.availableOptions?.find((o) => o.selected);
                      const ativo = col.schedule?.work;
                      return (
                        <td
                          key={col.key}
                          className={`border-r border-border-soft p-3 font-mono text-xs last:border-r-0 ${
                            col.ehHoje ? "bg-amber/5 font-semibold text-text" : ""
                          }`}
                        >
                          {ativo && selectedOption?.processingTime ? (
                            <span className="rounded bg-elevated px-2 py-0.5 text-text">
                              {selectedOption.processingTime}
                            </span>
                          ) : (
                            <span className="text-text-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Linha 8: Capacidade de Envio */}
                  <tr className="bg-elevated/20 hover:bg-elevated/40">
                    <td className="border-r border-border-soft bg-surface/60 p-3 font-semibold text-text">
                      <div className="flex items-center gap-2">
                        <Package size={14} className="text-amber" />
                        <span>Capacidade de envio</span>
                        <span className="text-[10px] text-text-faint font-normal">(em pedidos)</span>
                      </div>
                    </td>
                    {colunasSemana.map((col) => {
                      const capacity = col.schedule?.capacity;
                      const ativo = col.schedule?.work;
                      return (
                        <td
                          key={col.key}
                          className={`border-r border-border-soft p-3 font-mono text-sm font-bold last:border-r-0 ${
                            col.ehHoje ? "bg-amber/10 text-amber" : "text-text"
                          }`}
                        >
                          {ativo && capacity?.value != null ? (
                            <div className="flex items-center gap-1.5">
                              <span className="rounded-md border border-amber/30 bg-amber/10 px-2 py-0.5 text-amber">
                                {capacity.value}
                              </span>
                              {capacity.minimum != null && (
                                <span
                                  className="text-[10px] font-normal text-text-faint"
                                  title={`Mínimo: ${capacity.minimum} | Máximo: ${capacity.maximum ?? "—"}`}
                                >
                                  (mín {capacity.minimum})
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-text-faint font-normal">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Informações Complementares / Regras de Corte */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Box de Lógica do Mercado Envios */}
          <div className="rounded-lg border border-border-soft bg-surface p-4 text-xs">
            <div className="flex items-center gap-2 font-semibold text-text">
              <Info size={15} className="text-amber" />
              <span>Lógica de Coleta e Tempo de Preparo</span>
            </div>
            <div className="mt-3 space-y-2 text-text-muted">
              <p>
                • <strong>Terça a Quinta-feira:</strong> Horário de corte às <strong>09:00</strong> com tempo de preparo de <strong>05:00</strong>. Todos os pedidos confirmados até as 09:00 ficam liberados para expedição às 14:00, dentro da janela da transportadora (13:00 às 15:00).
              </p>
              <p>
                • <strong>Sexta-feira:</strong> Horário de corte estendido para às <strong>12:00</strong> com tempo de preparo de <strong>01:00</strong>. Pedidos confirmados até o meio-dia ficam liberados para embarque às 13:00.
              </p>
              <p>
                • <strong>Segunda, Sábado e Domingo:</strong> Operação de coleta física desativada pelo Mercado Livre para este contrato.
              </p>
            </div>
          </div>

          {/* Opções de Processamento por Dia */}
          <div className="rounded-lg border border-border-soft bg-surface p-4 text-xs">
            <div className="flex items-center gap-2 font-semibold text-text">
              <CalendarClock size={15} className="text-amber" />
              <span>Opções de Tempo de Preparo Disponíveis</span>
            </div>
            <div className="mt-3 space-y-2 text-text-muted">
              <p className="text-[11px] text-text-faint">
                Opções configuráveis registradas na AnyMarket para cada dia útil:
              </p>
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between border-b border-border-soft pb-1">
                  <span className="font-medium text-text">Terça a Quinta</span>
                  <span className="font-mono text-[11px] text-text-muted">
                    00:30 até 05:00 liberadas (Atual selecionado: <strong className="text-amber">05:00</strong>)
                  </span>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="font-medium text-text">Sexta-feira</span>
                  <span className="font-mono text-[11px] text-text-muted">
                    00:30 e 01:00 liberadas | Acima de 01:00 bloqueadas (Atual: <strong className="text-amber">01:00</strong>)
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
