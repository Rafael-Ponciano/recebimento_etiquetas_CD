import { useMemo, useState, Fragment, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Search, Timer } from "lucide-react";
import { api } from "../lib/api";

type EtapaItem = {
  etapa: string;
  ms: number;
  acumulado_ms: number;
};

type PerfRow = {
  id: number;
  created_at: string;
  order_id: string;
  usuario: string | null;
  total_ms: number | null;
  etapas: EtapaItem[] | Record<string, number> | null;
  texto: string | null;
  pedido_concluido: boolean;
  status_pedido: string | null;
};

type PerfResponse = {
  items: PerfRow[];
  resumo: {
    amostras: number;
    media_ms: number | null;
    p95_ms: number | null;
    max_ms: number | null;
  };
  medias_etapa: { etapa: string; media_ms: number; n: number }[];
};

const LABEL_ETAPA: Record<string, string> = {
  carregar_itens: "Carregar itens",
  supabase_recebimento: "Salvar recebimento",
  checar_pedido_completo: "Checar pedido completo",
  lock_finalizacao: "Travar finalização",
  am_enviar_conferencia: "AnyMarket · enviar",
  am_conferir_itens: "AnyMarket · conferir",
  download_etiqueta_danfe: "Baixar etiqueta / DANFE",
  impressao_etiqueta: "Impressão da etiqueta",
  impressao_danfe: "Impressão do DANFE",
  salvar_status: "Atualizar status",
  sheets_check_b2c: "Planilha Check B2C",
  supabase_sync_sheets: "Sync planilha",
  status_recebido_parcial: "Recebido parcial",
  agendado_sem_am: "Agendado (sem AnyMarket)",
  sem_nf_pedido: "Sem NF Pedido",
  erro_finalizacao: "Erro na finalização",
};

const ETAPA_ETIQUETA = "impressao_etiqueta";

function hojeISO(offsetDias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatarDataHora(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Tempo legível; abaixo de 100ms mostra ms para não virar “0,0 s”. */
function formatTempo(ms: number | null | undefined) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 100) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1).replace(".", ",")} s`;
  return `${Math.round(s)} s`;
}

function corTempo(ms: number | null | undefined) {
  if (ms == null) return "text-text-muted";
  if (ms >= 15000) return "text-red";
  if (ms >= 8000) return "text-amber";
  return "text-green";
}

function labelEtapa(nome: string) {
  if (LABEL_ETAPA[nome]) return LABEL_ETAPA[nome];
  return nome.replace(/_/g, " ");
}

/** Normaliza dict antigo (desordenado) ou lista nova (ordem + acumulado). */
function etapasOrdenadas(etapas: PerfRow["etapas"]): EtapaItem[] {
  if (!etapas) return [];
  if (Array.isArray(etapas)) {
    const out: EtapaItem[] = [];
    let acum = 0;
    for (const item of etapas) {
      if (!item || typeof item !== "object") continue;
      const nome = String((item as EtapaItem).etapa || "").trim();
      if (!nome) continue;
      const ms = Number((item as EtapaItem).ms);
      if (Number.isNaN(ms)) continue;
      const acumulado =
        (item as EtapaItem).acumulado_ms != null &&
        !Number.isNaN(Number((item as EtapaItem).acumulado_ms))
          ? Number((item as EtapaItem).acumulado_ms)
          : Math.round((acum + ms) * 10) / 10;
      acum = acumulado;
      out.push({ etapa: nome, ms, acumulado_ms: acumulado });
    }
    return out;
  }
  if (typeof etapas === "object") {
    // Dict legado: sem ordem confiável — ordena pelo fluxo conhecido.
    const ordem = Object.keys(LABEL_ETAPA);
    const keys = Object.keys(etapas);
    keys.sort((a, b) => {
      const ia = ordem.indexOf(a);
      const ib = ordem.indexOf(b);
      if (ia < 0 && ib < 0) return a.localeCompare(b);
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
    const out: EtapaItem[] = [];
    let acum = 0;
    for (const nome of keys) {
      const ms = Number(etapas[nome]);
      if (Number.isNaN(ms)) continue;
      acum = Math.round((acum + ms) * 10) / 10;
      out.push({ etapa: nome, ms, acumulado_ms: acum });
    }
    return out;
  }
  return [];
}

/** Tempo acumulado até a impressão da etiqueta (se a etapa existir). */
function tempoAteImpressaoMs(row: PerfRow): number | null {
  const etapas = etapasOrdenadas(row.etapas);
  for (const e of etapas) {
    if (e.etapa === ETAPA_ETIQUETA) return e.acumulado_ms;
  }
  return null;
}

export default function PerformancePage() {
  const hoje = hojeISO(0);
  const [dataIni, setDataIni] = useState(hoje);
  const [dataFim, setDataFim] = useState(hoje);
  const [pedidoFiltro, setPedidoFiltro] = useState("");
  const [usuarioFiltro, setUsuarioFiltro] = useState("");
  const [filtros, setFiltros] = useState({
    dataIni: hoje,
    dataFim: hoje,
    pedidoFiltro: "",
    usuarioFiltro: "",
  });
  const [expandido, setExpandido] = useState<number | null>(null);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["performance", filtros],
    queryFn: async () => {
      const { data: resp } = await api.get<PerfResponse>("/performance", {
        params: {
          data_ini: filtros.dataIni,
          data_fim: filtros.dataFim,
          order_id: filtros.pedidoFiltro || undefined,
          usuario: filtros.usuarioFiltro || undefined,
        },
      });
      return resp;
    },
    staleTime: 15_000,
  });

  const erroMsg = useMemo(() => {
    const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data
      ?.detail;
    return detail || (error ? "Falha ao carregar performance." : null);
  }, [error]);

  const itens = data?.items ?? [];

  const kpis = useMemo(() => {
    const tempos = itens
      .map((r) => r.total_ms)
      .filter((v): v is number => v != null && !Number.isNaN(v));
    const ateImp = itens
      .map((r) => tempoAteImpressaoMs(r))
      .filter((v): v is number => v != null && !Number.isNaN(v));
    return {
      conferencias: itens.length,
      mediaMs: tempos.length ? tempos.reduce((a, b) => a + b, 0) / tempos.length : null,
      maxMs: tempos.length ? Math.max(...tempos) : null,
      mediaAteImpMs: ateImp.length
        ? ateImp.reduce((a, b) => a + b, 0) / ateImp.length
        : null,
      maxAteImpMs: ateImp.length ? Math.max(...ateImp) : null,
    };
  }, [itens]);

  function aplicarFiltros(e?: FormEvent) {
    e?.preventDefault();
    setFiltros({
      dataIni,
      dataFim,
      pedidoFiltro: pedidoFiltro.trim(),
      usuarioFiltro: usuarioFiltro.trim(),
    });
  }

  function atalhoPeriodo(dias: number) {
    const fim = hojeISO(0);
    const ini = hojeISO(dias === 0 ? 0 : -(dias - 1));
    setDataIni(ini);
    setDataFim(fim);
    setFiltros({
      dataIni: ini,
      dataFim: fim,
      pedidoFiltro: pedidoFiltro.trim(),
      usuarioFiltro: usuarioFiltro.trim(),
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-6 pt-5 pb-2">
      <div className="mb-4 flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">Performance</h1>
          <p className="mt-1 text-sm text-text-muted">
            Do clique em Conferir até o processo terminar e o modal fechar
          </p>
        </div>
        <form onSubmit={aplicarFiltros} className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-faint">
              De
            </label>
            <input
              type="date"
              value={dataIni}
              onChange={(e) => setDataIni(e.target.value)}
              className="h-9 rounded-lg border border-border bg-elevated px-2.5 text-sm outline-none focus:border-amber"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-faint">
              Até
            </label>
            <input
              type="date"
              value={dataFim}
              onChange={(e) => setDataFim(e.target.value)}
              className="h-9 rounded-lg border border-border bg-elevated px-2.5 text-sm outline-none focus:border-amber"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-faint">
              Pedido / ID Any
            </label>
            <input
              value={pedidoFiltro}
              onChange={(e) => setPedidoFiltro(e.target.value)}
              placeholder="348804697"
              className="h-9 w-40 rounded-lg border border-border bg-elevated px-2.5 font-mono text-sm outline-none focus:border-amber"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-faint">
              Usuário
            </label>
            <input
              value={usuarioFiltro}
              onChange={(e) => setUsuarioFiltro(e.target.value)}
              placeholder="rafael"
              className="h-9 w-36 rounded-lg border border-border bg-elevated px-2.5 text-sm outline-none focus:border-amber"
            />
          </div>
          <button
            type="submit"
            disabled={isFetching}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber px-3 text-sm font-medium text-void transition hover:brightness-110 disabled:opacity-60"
          >
            <Search size={14} />
            Filtrar
          </button>
          <div className="flex gap-1">
            {[
              { label: "Hoje", dias: 0 },
              { label: "7d", dias: 7 },
              { label: "30d", dias: 30 },
            ].map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => atalhoPeriodo(a.dias)}
                className="h-9 rounded-lg border border-border px-2.5 text-xs text-text-muted transition hover:border-text-faint hover:text-text"
              >
                {a.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-text-muted transition hover:border-text-faint hover:text-text"
          >
            <Activity size={14} />
            Atualizar
          </button>
        </form>
      </div>

      {erroMsg && (
        <div className="mb-4 shrink-0 rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
          {erroMsg}
        </div>
      )}

      <div className="mb-4 grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <ResumoCard
          label="Conferências"
          hint="No período"
          value={String(kpis.conferencias)}
        />
        <ResumoCard
          label="Tempo médio"
          hint="Clique → fim do processo"
          value={formatTempo(kpis.mediaMs)}
          valueClass={corTempo(kpis.mediaMs)}
        />
        <ResumoCard
          label="Mais lenta"
          hint="Maior tempo no período"
          value={formatTempo(kpis.maxMs)}
          valueClass={corTempo(kpis.maxMs)}
        />
        <ResumoCard
          label="Média até impressão"
          hint="Até sair a etiqueta"
          value={formatTempo(kpis.mediaAteImpMs)}
          valueClass={corTempo(kpis.mediaAteImpMs)}
        />
        <ResumoCard
          label="Mais lenta até impressão"
          hint="Pior tempo até a etiqueta"
          value={formatTempo(kpis.maxAteImpMs)}
          valueClass={corTempo(kpis.maxAteImpMs)}
        />
      </div>



      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-soft">
        <table className="data-table w-full min-w-[680px] text-left text-sm">
          <thead className="sticky top-0 bg-elevated text-xs text-text-muted">
            <tr>
              <th className="px-3 py-2.5 font-medium">Quando</th>
              <th className="px-3 py-2.5 font-medium">Pedido</th>
              <th className="px-3 py-2.5 font-medium">Quem</th>
              <th className="px-3 py-2.5 font-medium">Tempo total</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {isFetching && !data && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-text-faint">
                  Carregando…
                </td>
              </tr>
            )}
            {!isFetching && itens.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-text-faint">
                  Nenhuma conferência no período. Confira um pedido para gerar tempos.
                </td>
              </tr>
            )}
            {itens.map((row) => {
              const aberto = expandido === row.id;
              const etapas = etapasOrdenadas(row.etapas);
              const status = row.pedido_concluido
                ? row.status_pedido || "Concluído"
                : "Parcial";
              return (
                <Fragment key={row.id}>
                  <tr className="border-t border-border-soft hover:bg-elevated/40">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-text-muted">
                      {formatarDataHora(row.created_at)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{row.order_id}</td>
                    <td className="px-3 py-2 text-xs">{row.usuario || "—"}</td>
                    <td className={`px-3 py-2 font-mono text-sm font-semibold ${corTempo(row.total_ms)}`}>
                      <span className="inline-flex items-center gap-1.5">
                        <Timer size={13} className="opacity-70" />
                        {formatTempo(row.total_ms)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-muted">{status}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setExpandido(aberto ? null : row.id)}
                        className="text-xs font-medium text-amber hover:underline"
                      >
                        {aberto ? "Fechar" : "Detalhes"}
                      </button>
                    </td>
                  </tr>
                  {aberto && (
                    <tr className="border-t border-border-soft bg-elevated/30">
                      <td colSpan={6} className="px-3 py-3">
                        {etapas.length === 0 ? (
                          <p className="text-[11px] text-text-faint">Sem detalhe de etapas.</p>
                        ) : (
                          <ol className="space-y-1.5">
                            {etapas.map((e, i) => {
                              const destaque = e.etapa === ETAPA_ETIQUETA;
                              return (
                                <li
                                  key={`${e.etapa}-${i}`}
                                  className={`flex items-center gap-3 rounded-md border px-2.5 py-1.5 text-[12px] ${
                                    destaque
                                      ? "border-green/35 bg-green/10"
                                      : "border-border-soft bg-surface/80"
                                  }`}
                                >
                                  <span className="w-5 shrink-0 font-mono text-[10px] text-text-faint">
                                    {i + 1}.
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-text">
                                    {labelEtapa(e.etapa)}
                                  </span>
                                  <span
                                    className={`w-16 shrink-0 text-right font-mono text-[11px] font-semibold tabular-nums ${corTempo(e.acumulado_ms)}`}
                                    title="Tempo somado desde o início"
                                  >
                                    {formatTempo(e.acumulado_ms)}
                                  </span>
                                  <span
                                    className="w-16 shrink-0 text-right font-mono text-[10px] tabular-nums text-text-faint"
                                    title="Duração só desta etapa"
                                  >
                                    +{formatTempo(e.ms)}
                                  </span>
                                </li>
                              );
                            })}
                          </ol>
                        )}
                        <p className="mt-2 text-[10px] text-text-faint">
                          Coluna da esquerda: tempo somado · direita: só a etapa
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResumoCard({
  label,
  hint,
  value,
  valueClass,
}: {
  label: string;
  hint?: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-border-soft bg-elevated/40 px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">{label}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-text-faint">{hint}</p> : null}
      <p className={`mt-1.5 font-mono text-2xl font-semibold tabular-nums ${valueClass ?? "text-text"}`}>
        {value}
      </p>
    </div>
  );
}
