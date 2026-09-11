import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Search,
  Package,
  Users,
  CheckCircle2,
  Printer,
  AlertTriangle,
  Boxes,
  RefreshCw,
} from "lucide-react";
import { api } from "../lib/api";
import type { Pedido } from "../types/pedido";
import { useRegras } from "../lib/regras";
import {
  CARDS_MKP_VISUAL,
  CARDS_RESUMO_VISUAL,
  contagensOperacionais,
  diaLocalHoje,
  indexarClassesProduto,
  pedidosDoFiltroOperacional,
  type FiltroOperacionalId,
} from "../lib/filtrosPedidos";
import { MKPS_FIXOS, type MkpFixoId } from "../lib/marketplace";
import PedidosRecorteDialog from "../components/PedidosRecorteDialog";

type Kpis = {
  pecas: number;
  pedidos: number;
  finalizacoes: number;
  impressoes: number;
  erros: number;
  operadores: number;
};

type OperadorRow = {
  operador: string;
  pecas: number;
  pedidos_tocados: number;
  finalizacoes: number;
  impressoes: number;
  erros: number;
};

type DashboardResponse = {
  periodo: { data_ini: string; data_fim: string };
  kpis: Kpis;
  por_operador: OperadorRow[];
};

type Aba = "operacional" | "produtividade";

type RecorteAberto = {
  id: FiltroOperacionalId;
  label: string;
  mkpId?: MkpFixoId | null;
  mkpLabel?: string | null;
};

function hojeISO(offsetDias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatarDiaBr(iso: string) {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function SolidMetricCard({
  label,
  count,
  bg,
  onClick,
  size = "md",
}: {
  label: string;
  count: number;
  bg: string;
  onClick: () => void;
  size?: "md" | "sm";
}) {
  const pad = size === "sm" ? "px-2 py-2" : "px-3 py-2.5";
  const titulo = size === "sm" ? "text-[12px]" : "text-[13px]";
  const numero = size === "sm" ? "text-xl" : "text-2xl";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ backgroundColor: bg }}
      className={`w-full rounded-lg ${pad} text-center text-black shadow-sm transition hover:brightness-110 active:brightness-95`}
    >
      <span className={`block font-semibold leading-tight ${titulo}`}>{label}</span>
      <span className={`mt-0.5 block font-bold tabular-nums leading-none ${numero}`}>
        {count.toLocaleString("pt-BR")}
      </span>
    </button>
  );
}

function KpiCard({
  label,
  value,
  icon,
  destaque,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  destaque?: "amber" | "green" | "red" | "cyan";
}) {
  const cor =
    destaque === "green"
      ? "text-green"
      : destaque === "red"
        ? "text-red"
        : destaque === "cyan"
          ? "text-cyan"
          : "text-amber";
  return (
    <div className="rounded-xl border border-border-soft bg-elevated/40 px-4 py-3">
      <div className="flex items-center gap-2 text-text-faint">
        <span className={cor}>{icon}</span>
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className={`mt-1.5 font-display text-2xl font-semibold tabular-nums ${cor}`}>
        {value.toLocaleString("pt-BR")}
      </p>
    </div>
  );
}

function AbaOperacional() {
  const queryClient = useQueryClient();
  const regras = useRegras();
  const [recorte, setRecorte] = useState<RecorteAberto | null>(null);
  const [diaSelecionado, setDiaSelecionado] = useState(() => diaLocalHoje());
  const forcarRefreshRef = useRef(false);

  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["pedidos"],
    queryFn: async () => {
      const refresh = forcarRefreshRef.current;
      forcarRefreshRef.current = false;
      const { data: body } = await api.get<{ items: Pedido[]; total: number }>("/pedidos", {
        params: refresh ? { refresh: true } : undefined,
      });
      return body.items;
    },
  });

  const pedidos = useMemo(() => data ?? [], [data]);

  const contexto = useMemo(() => {
    const ids = indexarClassesProduto(pedidos);
    return { regras, ...ids };
  }, [pedidos, regras]);

  const contagensGlobais = useMemo(
    () => contagensOperacionais(pedidos, contexto, null, diaSelecionado),
    [pedidos, contexto, diaSelecionado]
  );

  const contagensPorMkp = useMemo(() => {
    const mapa = new Map<MkpFixoId, Record<FiltroOperacionalId, number>>();
    for (const mkp of MKPS_FIXOS) {
      mapa.set(mkp.id, contagensOperacionais(pedidos, contexto, mkp.id, diaSelecionado));
    }
    return mapa;
  }, [pedidos, contexto, diaSelecionado]);

  const pedidosRecorte = useMemo(() => {
    if (!recorte) return [];
    return pedidosDoFiltroOperacional(
      pedidos,
      recorte.id,
      contexto,
      recorte.mkpId,
      diaSelecionado
    );
  }, [recorte, pedidos, contexto, diaSelecionado]);

  const tituloRecorte = useMemo(() => {
    if (!recorte) return "";
    const base = recorte.mkpLabel ? `${recorte.label} · ${recorte.mkpLabel}` : recorte.label;
    return `${base} · ${formatarDiaBr(diaSelecionado)}`;
  }, [recorte, diaSelecionado]);

  async function atualizar() {
    forcarRefreshRef.current = true;
    try {
      await queryClient.fetchQuery({
        queryKey: ["pedidos"],
        queryFn: async () => {
          forcarRefreshRef.current = false;
          const { data: body } = await api.get<{ items: Pedido[]; total: number }>("/pedidos", {
            params: { refresh: true },
          });
          return body.items;
        },
        staleTime: 0,
      });
    } catch {
      forcarRefreshRef.current = false;
      await refetch();
    }
  }

  function abrir(
    id: FiltroOperacionalId,
    label: string,
    mkp?: { id: MkpFixoId; label: string } | null
  ) {
    setRecorte({
      id,
      label,
      mkpId: mkp?.id,
      mkpLabel: mkp?.label,
    });
  }

  const erroMsg =
    (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
    (isError ? "Falha ao carregar pedidos." : null);

  return (
    <>
      <div className="mb-5 flex shrink-0 flex-col items-center text-center">
        <div className="flex items-center justify-center gap-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            Acompanhamento CD
          </h1>
          <button
            type="button"
            onClick={() => void atualizar()}
            disabled={isFetching}
            title="Atualizar"
            className="rounded-md p-1.5 text-text-faint transition hover:bg-elevated hover:text-text disabled:opacity-50"
          >
            <RefreshCw size={15} className={isFetching ? "animate-spin" : ""} />
          </button>
        </div>

        <p className="mt-1.5 flex flex-wrap items-center justify-center gap-2 text-sm text-text-muted">
          <span>Exibindo pedidos do dia:</span>
          <input
            type="date"
            value={diaSelecionado}
            onChange={(e) => {
              if (e.target.value) setDiaSelecionado(e.target.value);
            }}
            className="h-8 rounded-md border border-amber/50 bg-amber/10 px-2.5 font-mono text-sm font-medium text-amber outline-none transition hover:border-amber hover:bg-amber/15 focus:border-amber"
            aria-label="Escolher dia"
            title="Escolher outro dia"
          />
        </p>

        <div className="mt-4 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-4">
          {CARDS_RESUMO_VISUAL.map((c) => (
            <SolidMetricCard
              key={c.id}
              label={c.label}
              count={contagensGlobais[c.id] ?? 0}
              bg={c.bg}
              onClick={() => abrir(c.id, c.label)}
            />
          ))}
        </div>
      </div>

      {erroMsg && (
        <div className="mb-4 rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
          {erroMsg}
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {MKPS_FIXOS.map((mkp) => {
          const contagens = contagensPorMkp.get(mkp.id)!;
          return (
            <section
              key={mkp.id}
              className="flex flex-col rounded-xl border border-white/10 bg-elevated/50 p-3 shadow-[0_4px_12px_rgba(0,0,0,0.25)]"
            >
              <div className="mb-3 flex min-h-[5rem] items-center justify-center gap-2">
                {mkp.logoSrc ? (
                  <img
                    src={mkp.logoSrc}
                    alt={mkp.label}
                    className={`w-auto object-contain ${
                      mkp.id === "meli"
                        ? "h-20 max-w-[13rem]"
                        : mkp.id === "shopee"
                          ? "h-16 max-w-[11rem]"
                          : "h-9 max-w-[7.5rem]"
                    }`}
                  />
                ) : (
                  <h2 className="text-center font-display text-lg font-semibold text-text">
                    {mkp.label}
                  </h2>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                {CARDS_MKP_VISUAL.map((c) => (
                  <SolidMetricCard
                    key={`${mkp.id}-${c.id}`}
                    label={c.label}
                    count={contagens[c.id] ?? 0}
                    bg={c.bg}
                    size="sm"
                    onClick={() => abrir(c.id, c.label, mkp)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {recorte && (
        <PedidosRecorteDialog
          titulo={tituloRecorte}
          pedidos={pedidosRecorte}
          onClose={() => setRecorte(null)}
        />
      )}
    </>
  );
}

function AbaProdutividade() {
  const [dataIni, setDataIni] = useState(hojeISO(0));
  const [dataFim, setDataFim] = useState(hojeISO(0));
  const [usuario, setUsuario] = useState("");
  const [filtros, setFiltros] = useState({
    dataIni: hojeISO(0),
    dataFim: hojeISO(0),
    usuario: "",
  });

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["dashboard", filtros],
    queryFn: async () => {
      const { data: resp } = await api.get<DashboardResponse>("/dashboard", {
        params: {
          data_ini: filtros.dataIni,
          data_fim: filtros.dataFim,
          usuario: filtros.usuario || undefined,
        },
      });
      return resp;
    },
  });

  const erroMsg =
    (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
    (error ? "Falha ao carregar dashboard." : null);

  const kpis = data?.kpis;
  const pessoas = data?.por_operador ?? [];

  function aplicarFiltros(e?: FormEvent) {
    e?.preventDefault();
    setFiltros({
      dataIni,
      dataFim,
      usuario: usuario.trim(),
    });
  }

  function atalhoPeriodo(dias: number) {
    const fim = hojeISO(0);
    const ini = hojeISO(dias === 0 ? 0 : -(dias - 1));
    setDataIni(ini);
    setDataFim(fim);
    setFiltros({ dataIni: ini, dataFim: fim, usuario: usuario.trim() });
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 shrink-0">
        <div>
          <h1 className="font-display text-xl font-semibold">Produtividade</h1>
          <p className="mt-1 text-sm text-text-muted">
            Produtividade por operador · período selecionado
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
              Operador
            </label>
            <input
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
              placeholder="Nome / usuário"
              className="h-9 w-40 rounded-lg border border-border bg-elevated px-2.5 text-sm outline-none focus:border-amber"
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
        </form>
      </div>

      {erroMsg && (
        <div className="mb-4 rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
          {erroMsg}
        </div>
      )}

      <div className="mb-4 grid shrink-0 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Peças" value={kpis?.pecas ?? 0} icon={<Package size={14} />} />
        <KpiCard
          label="Pedidos"
          value={kpis?.pedidos ?? 0}
          icon={<Boxes size={14} />}
          destaque="cyan"
        />
        <KpiCard
          label="Finalizações"
          value={kpis?.finalizacoes ?? 0}
          icon={<CheckCircle2 size={14} />}
          destaque="green"
        />
        <KpiCard label="Impressões" value={kpis?.impressoes ?? 0} icon={<Printer size={14} />} />
        <KpiCard
          label="ERROS EM ABERTO"
          value={kpis?.erros ?? 0}
          icon={<AlertTriangle size={14} />}
          destaque="red"
        />
        <KpiCard label="Operadores" value={kpis?.operadores ?? 0} icon={<Users size={14} />} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border-soft">
        <div className="flex items-center justify-between border-b border-border-soft px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <LayoutDashboard size={15} className="text-amber" />
            Produtividade por pessoa
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="text-xs text-text-faint transition hover:text-text"
          >
            {isFetching ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr className="bg-surface text-xs uppercase tracking-wide text-text-muted">
                <th className="px-4 py-2.5 text-left font-medium">Operador</th>
                <th className="px-4 py-2.5 text-right font-medium">Peças</th>
                <th className="px-4 py-2.5 text-right font-medium">Pedidos</th>
                <th className="px-4 py-2.5 text-right font-medium">Finalizações</th>
                <th className="px-4 py-2.5 text-right font-medium">Impressões</th>
                <th className="px-4 py-2.5 text-right font-medium">ERROS EM ABERTO</th>
              </tr>
            </thead>
            <tbody>
              {pessoas.length ? (
                pessoas.map((p) => (
                  <tr key={p.operador} className="border-t border-border-soft">
                    <td className="px-4 py-2.5 font-medium">{p.operador}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-amber">
                      {p.pecas.toLocaleString("pt-BR")}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-muted">
                      {p.pedidos_tocados.toLocaleString("pt-BR")}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-green">
                      {p.finalizacoes.toLocaleString("pt-BR")}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-muted">
                      {p.impressoes.toLocaleString("pt-BR")}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right font-mono tabular-nums ${
                        p.erros > 0 ? "text-red" : "text-text-faint"
                      }`}
                    >
                      {p.erros.toLocaleString("pt-BR")}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-text-faint">
                    {isFetching
                      ? "Carregando…"
                      : "Nenhum dado no período / operador selecionado."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function DashboardPage() {
  const [aba, setAba] = useState<Aba>("operacional");

  return (
    <div className="flex h-full min-h-0 flex-col px-6 pt-5 pb-4">
      <div className="mb-4 flex shrink-0 gap-1 rounded-lg border border-border-soft bg-elevated/40 p-1 w-fit">
        {(
          [
            { id: "operacional" as const, label: "Operacional" },
            { id: "produtividade" as const, label: "Produtividade" },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setAba(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              aba === t.id
                ? "bg-amber text-void"
                : "text-text-muted hover:bg-elevated hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {aba === "operacional" ? <AbaOperacional /> : <AbaProdutividade />}
      </div>
    </div>
  );
}
