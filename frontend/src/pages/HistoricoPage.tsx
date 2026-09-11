import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Download,
  History,
  X,
  Package,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Cog,
  Printer,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { api } from "../lib/api";
import StatusBadge from "../components/StatusBadge";
import ReimprimirDialog from "../components/ReimprimirDialog";
import PageSizeSelect from "../components/PageSizeSelect";
import type { Pedido } from "../types/pedido";

const PAGE_SIZES = [10, 15, 25, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 100;

type HistoricoRow = {
  id_any: string;
  pedido: string | null;
  pedido_any: string | null;
  cliente: string | null;
  mkp: string | null;
  status_any: string | null;
  data_pedido: string | null;
  ultimo_recebimento: string | null;
  operadores: string[];
  usuario_finalizou?: string | null;
  itens_resumo: string;
  qtd_itens: number;
  qtnd_total: number;
  qtd_recebimentos: number;
  tag?: "erro" | "corrigido" | null;
};

type TimelineEvento = {
  em: string | null;
  tipo: string;
  titulo: string;
  detalhe: string;
  usuario: string;
  meta?: { tipo_acao?: string; ok?: boolean; tag?: "erro" | "corrigido" | null };
};

type DetalheHistorico = {
  pedido: HistoricoRow & { itens?: string[]; tag?: "erro" | "corrigido" | null };
  timeline: TimelineEvento[];
};

function TagMini({ tag }: { tag?: "erro" | "corrigido" | null }) {
  if (!tag) return null;
  if (tag === "erro") {
    return (
      <span className="inline-flex items-center rounded border border-red/40 bg-red/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-red">
        erro
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded border border-green/40 bg-green/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-green">
      corrigido
    </span>
  );
}

function hojeISO(offsetDias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatarDataHora(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function iconeEvento(tipo: string) {
  if (tipo === "item_recebido") return <Package size={15} className="text-amber" />;
  if (tipo === "item_completo") return <CheckCircle2 size={15} className="text-green" />;
  if (tipo === "item_status") return <CheckCircle2 size={15} className="text-green" />;
  if (tipo === "planilha") return <FileSpreadsheet size={15} className="text-cyan" />;
  if (tipo === "sistema") return <Cog size={15} className="text-text-muted" />;
  return <AlertTriangle size={15} className="text-amber" />;
}

export default function HistoricoPage() {
  const queryClient = useQueryClient();
  const [dataIni, setDataIni] = useState(hojeISO(0));
  const [dataFim, setDataFim] = useState(hojeISO(0));
  const [usuarioFiltro, setUsuarioFiltro] = useState("");
  const [pedidoFiltro, setPedidoFiltro] = useState("");
  const [filtrosAplicados, setFiltrosAplicados] = useState({
    dataIni: hojeISO(0),
    dataFim: hojeISO(0),
    usuarioFiltro: "",
    pedidoFiltro: "",
  });
  const [pedidoAberto, setPedidoAberto] = useState<string | null>(null);
  const [reimprimirPedido, setReimprimirPedido] = useState<Pedido | null>(null);
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  const { data, isFetching } = useQuery({
    queryKey: [
      "historico",
      filtrosAplicados,
      pagination.pageIndex,
      pagination.pageSize,
    ],
    queryFn: async () => {
      const { data } = await api.get<{ total: number; items: HistoricoRow[] }>("/historico", {
        params: {
          data_ini: filtrosAplicados.dataIni,
          data_fim: filtrosAplicados.dataFim,
          usuario: filtrosAplicados.usuarioFiltro || undefined,
          pedido: filtrosAplicados.pedidoFiltro || undefined,
          limit: pagination.pageSize,
          offset: pagination.pageIndex * pagination.pageSize,
        },
      });
      return data;
    },
    staleTime: 20_000,
    placeholderData: (prev) => prev,
  });

  const itemsPagina = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize) || 1);

  useEffect(() => {
    setPagination((p) => {
      const maxPage = Math.max(0, Math.ceil(total / p.pageSize) - 1);
      if (p.pageIndex <= maxPage) return p;
      return { ...p, pageIndex: maxPage };
    });
  }, [total, pagination.pageSize]);

  const { data: detalhe, isPending: carregandoPrimeiraVez } = useQuery({
    queryKey: ["historico-detalhe", pedidoAberto],
    queryFn: async () => {
      const { data } = await api.get<DetalheHistorico>(`/historico/${pedidoAberto}`);
      return data;
    },
    enabled: Boolean(pedidoAberto),
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPedidoAberto(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function aplicarFiltros() {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
    setFiltrosAplicados({ dataIni, dataFim, usuarioFiltro, pedidoFiltro });
  }

  async function exportarCSV() {
    const { data: exportData } = await api.get<{ total: number; items: HistoricoRow[] }>(
      "/historico",
      {
        params: {
          data_ini: filtrosAplicados.dataIni,
          data_fim: filtrosAplicados.dataFim,
          usuario: filtrosAplicados.usuarioFiltro || undefined,
          pedido: filtrosAplicados.pedidoFiltro || undefined,
          limit: 0,
          offset: 0,
        },
      }
    );
    if (!exportData?.items?.length) return;
    const header = [
      "Status",
      "Pedido",
      "Pedido Any",
      "ID Any",
      "Último recebimento",
      "Cliente",
      "Operadores",
      "Finalizou",
      "Itens",
      "Qtd itens",
      "Marketplace",
    ];
    const linhas = exportData.items.map((r) => [
      r.status_any ?? "",
      r.pedido ?? "",
      r.pedido_any ?? "",
      r.id_any,
      formatarDataHora(r.ultimo_recebimento),
      r.cliente ?? "",
      (r.operadores || []).join("; "),
      r.usuario_finalizou ?? "",
      r.itens_resumo ?? "",
      String(r.qtd_itens ?? ""),
      r.mkp ?? "",
    ]);
    const csv = [header, ...linhas]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    a.href = url;
    a.download = `historico_pedidos_${ts}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const falhasImpressao = useMemo(() => {
    const timeline = detalhe?.timeline ?? [];
    const etiqueta = timeline.some(
      (ev) =>
        (ev.meta?.tipo_acao === "ERRO_IMPRESSAO" || ev.titulo === "Falha na impressão") &&
        /impressao_etiqueta|etiqueta_/i.test(ev.detalhe || "")
    );
    const danfe = timeline.some(
      (ev) =>
        (ev.meta?.tipo_acao === "ERRO_IMPRESSAO" || ev.titulo === "Falha na impressão") &&
        /impressao_danfe|danfe_/i.test(ev.detalhe || "")
    );

    const generica = timeline.some(
      (ev) =>
        (ev.meta?.tipo_acao === "ERRO_IMPRESSAO" || ev.titulo === "Falha na impressão") &&
        !/impressao_etiqueta|impressao_danfe|etiqueta_|danfe_/i.test(ev.detalhe || "")
    );
    return {
      etiqueta: etiqueta || generica,
      danfe: danfe || generica,
      alguma: etiqueta || danfe || generica,
    };
  }, [detalhe?.timeline]);

  const podeReimprimirFaltantes = detalhe?.pedido.status_any === "AG AJUSTE";

  const labelReimprimir = falhasImpressao.etiqueta && falhasImpressao.danfe
    ? "Reimprimir etiqueta + DANFE"
    : falhasImpressao.etiqueta
      ? "Reimprimir etiqueta"
      : falhasImpressao.danfe
        ? "Reimprimir DANFE"
        : "Reimprimir faltantes";

  return (
    <div className="flex h-full min-h-0 flex-col px-6 pt-5 pb-2">
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber/15 text-amber">
          <History size={16} />
        </span>
        <div>
          <h1 className="font-display text-xl font-semibold">Histórico de pedidos</h1>
          <p className="text-xs text-text-faint">
            Só pedidos com recebimento no CD no período — consulta e timeline
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">De</label>
          <input
            type="date"
            value={dataIni}
            onChange={(e) => setDataIni(e.target.value)}
            className="rounded-lg border border-border bg-elevated px-3 py-2 text-sm outline-none focus:border-amber"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Até</label>
          <input
            type="date"
            value={dataFim}
            onChange={(e) => setDataFim(e.target.value)}
            className="rounded-lg border border-border bg-elevated px-3 py-2 text-sm outline-none focus:border-amber"
          />
        </div>
        <div className="min-w-[140px]">
          <label className="mb-1 block text-xs text-text-muted">Login / operador</label>
          <input
            value={usuarioFiltro}
            onChange={(e) => setUsuarioFiltro(e.target.value)}
            className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm outline-none focus:border-amber"
          />
        </div>
        <div className="min-w-[180px] flex-1">
          <label className="mb-1 block text-xs text-text-muted">Pedido</label>
          <input
            value={pedidoFiltro}
            onChange={(e) => setPedidoFiltro(e.target.value)}
            className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm outline-none focus:border-amber"
          />
        </div>
        <button
          type="button"
          onClick={aplicarFiltros}
          className="flex items-center gap-2 rounded-lg bg-amber px-4 py-2 text-sm font-medium text-void transition hover:brightness-110"
        >
          <Search size={15} />
          Filtrar
        </button>
        <button
          type="button"
          onClick={() => void exportarCSV()}
          disabled={!total || isFetching}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-text-muted transition hover:border-text-faint hover:text-text disabled:opacity-40"
        >
          <Download size={15} />
          Exportar CSV
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-soft">
        <table className="data-table w-full text-sm">
          <thead>
            <tr className="bg-surface text-xs uppercase tracking-wide text-text-muted">
              <th className="px-4 py-2.5 text-left font-medium">Status</th>
              <th className="px-4 py-2.5 text-left font-medium">Pedido</th>
              <th className="px-4 py-2.5 text-left font-medium">Recebimento</th>
              <th className="px-4 py-2.5 text-left font-medium">Cliente</th>
              <th className="px-4 py-2.5 text-left font-medium">Operador(es)</th>
              <th className="px-4 py-2.5 text-left font-medium">Finalizou</th>
              <th className="px-4 py-2.5 text-left font-medium">Itens</th>
              <th className="px-4 py-2.5 text-left font-medium">Mkp</th>
            </tr>
          </thead>
          <tbody>
            {itemsPagina.length ? (
              itemsPagina.map((r) => (
                <tr
                  key={r.id_any}
                  onClick={() => setPedidoAberto(r.id_any)}
                  className="cursor-pointer border-t border-border-soft transition hover:bg-elevated/50"
                >
                  <td className="px-4 py-2.5">
                    <StatusBadge status={r.status_any || ""} />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{r.pedido || r.pedido_any || r.id_any}</div>
                    <div className="font-mono text-[10px] text-text-faint">ID {r.id_any}</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-muted">
                    {formatarDataHora(r.ultimo_recebimento)}
                  </td>
                  <td className="max-w-[200px] truncate px-4 py-2.5">{r.cliente || "—"}</td>
                  <td className="px-4 py-2.5 text-text-muted">
                    {(r.operadores || []).length ? r.operadores.join(", ") : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">
                    {r.usuario_finalizou || "—"}
                  </td>
                  <td className="max-w-[240px] px-4 py-2.5">
                    <span className="line-clamp-2 text-text-muted">{r.itens_resumo || "—"}</span>
                    <span className="mt-0.5 block font-mono text-[10px] text-text-faint">
                      {r.qtd_itens} item(ns) · {r.qtd_recebimentos} receb.
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">{r.mkp || "—"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-text-faint">
                  {isFetching
                    ? "Carregando…"
                    : "Nenhum pedido no histórico para os filtros selecionados."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-1.5 flex shrink-0 items-center justify-end gap-3 text-xs text-text-faint">
        <div className="flex items-center gap-1.5">
          <span className="mr-1 font-mono tabular-nums">
            {total === 0
              ? "0 de 0"
              : `${pagination.pageIndex * pagination.pageSize + 1}–${Math.min(
                  (pagination.pageIndex + 1) * pagination.pageSize,
                  total
                )} de ${total}`}
          </span>
          <PageSizeSelect
            value={pagination.pageSize}
            options={PAGE_SIZES}
            onChange={(tamanho) =>
              setPagination({ pageIndex: 0, pageSize: tamanho })
            }
          />
          <button
            type="button"
            onClick={() =>
              setPagination((p) => ({
                ...p,
                pageIndex: Math.max(0, p.pageIndex - 1),
              }))
            }
            disabled={pagination.pageIndex <= 0}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-elevated text-text-muted transition hover:text-text disabled:opacity-30"
            aria-label="Página anterior"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="min-w-8 px-0.5 text-center font-mono tabular-nums">
            {pagination.pageIndex + 1}/{pageCount}
          </span>
          <button
            type="button"
            onClick={() =>
              setPagination((p) => ({
                ...p,
                pageIndex: Math.min(pageCount - 1, p.pageIndex + 1),
              }))
            }
            disabled={pagination.pageIndex >= pageCount - 1}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-elevated text-text-muted transition hover:text-text disabled:opacity-30"
            aria-label="Próxima página"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {pedidoAberto && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-void/65 backdrop-blur-[2px]"
          onMouseDown={() => setPedidoAberto(null)}
        >
          <aside
            className="flex h-full w-full max-w-lg flex-col border-l border-border bg-surface shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-3 border-b border-border-soft px-5 py-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.08em] text-text-faint">Timeline</p>
                <h2 className="font-display text-lg font-semibold">
                  {detalhe?.pedido.pedido ||
                    detalhe?.pedido.pedido_any ||
                    pedidoAberto}
                </h2>
                <p className="mt-1 text-xs text-text-muted">
                  {detalhe?.pedido.cliente || "—"}
                  {detalhe?.pedido.status_any ? ` · ${detalhe.pedido.status_any}` : ""}
                </p>
                {(detalhe?.pedido.operadores?.length || detalhe?.pedido.usuario_finalizou) && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-text-faint">
                    {detalhe.pedido.operadores?.length
                      ? `Conferiram: ${detalhe.pedido.operadores.join(", ")}`
                      : null}
                    {detalhe.pedido.operadores?.length && detalhe.pedido.usuario_finalizou
                      ? " · "
                      : null}
                    {detalhe.pedido.usuario_finalizou
                      ? `Finalizou: ${detalhe.pedido.usuario_finalizou}`
                      : null}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPedidoAberto(null)}
                className="rounded-lg p-2 text-text-muted hover:bg-elevated hover:text-text"
              >
                <X size={17} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              {carregandoPrimeiraVez && (
                <p className="py-8 text-center text-sm text-text-faint">Carregando timeline…</p>
              )}
              {!carregandoPrimeiraVez && detalhe?.timeline?.length === 0 && (
                <p className="py-8 text-center text-sm text-text-faint">
                  Nenhum evento registrado para este pedido.
                </p>
              )}
              {!carregandoPrimeiraVez && (detalhe?.timeline?.length ?? 0) > 0 && (
              <ol className="relative space-y-3.5">
                <span
                  aria-hidden
                  className="absolute bottom-3 left-[14px] top-3 w-px -translate-x-1/2 bg-border-soft"
                />
                {detalhe?.timeline?.map((ev, i) => {
                  const ehCardErro =
                    ev.meta?.tag === "erro" ||
                    ev.meta?.ok === false ||
                    Boolean(ev.meta?.tipo_acao?.startsWith("ERRO_")) ||
                    ev.titulo.toLowerCase().includes("falha") ||
                    ev.titulo.includes("AG AJUSTE");

                  const tagEv = ehCardErro
                    ? detalhe?.pedido.tag === "corrigido"
                      ? "corrigido"
                      : "erro"
                    : null;
                  return (
                  <li key={`${ev.em}-${ev.tipo}-${i}`} className="relative pl-11">
                    <span className="absolute left-0 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-elevated shadow-sm shadow-black/20">
                      {iconeEvento(ev.tipo)}
                    </span>
                    <div
                      className={`space-y-1 rounded-xl border px-3 py-2 ${
                        tagEv === "erro"
                          ? "border-red/30 bg-red/5"
                          : tagEv === "corrigido"
                            ? "border-green/30 bg-green/5"
                            : "border-border-soft/80 bg-elevated/40"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-mono text-[11px] text-text-faint">{formatarDataHora(ev.em)}</p>
                        <TagMini tag={tagEv} />
                      </div>
                      <p className="text-sm font-medium leading-snug text-text">{ev.titulo}</p>
                      {ev.detalhe && (
                        <p className="text-xs leading-relaxed text-text-muted">{ev.detalhe}</p>
                      )}
                      <p className="text-[11px] text-text-faint">
                        {ev.meta?.tipo_acao?.startsWith("FINALIZACAO_")
                          ? `finalizado por ${ev.usuario || "—"}`
                          : `por ${ev.usuario || "—"}`}
                      </p>
                    </div>
                  </li>
                  );
                })}
              </ol>
              )}
            </div>

            {podeReimprimirFaltantes && detalhe?.pedido && (
              <footer className="border-t border-border-soft px-5 py-3">
                <button
                  type="button"
                  onClick={() => {
                    const p = detalhe.pedido;
                    setReimprimirPedido({
                      id_any: p.id_any,
                      Pedido: p.pedido || "",
                      "Pedido Any": p.pedido_any || "",
                      Cliente: p.cliente || "",
                      "Status Any": p.status_any || "AG AJUSTE",
                      "Status CD": "",
                      Data: null,
                      "Data Coleta": null,
                      CPF: "",
                      Item: "",
                      QTND: "",
                      filial_seller: "",
                      "Pedido Seller": "",
                      Mkp: p.mkp || "",
                      "NF Venda": "",
                      "NF Seller": "",
                      ean: "",
                    });
                  }}
                  className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-amber px-3.5 text-sm font-medium text-void transition hover:brightness-110"
                >
                  <Printer size={15} />
                  {labelReimprimir}
                </button>
              </footer>
            )}
          </aside>
        </div>
      )}

      {reimprimirPedido && (
        <ReimprimirDialog
          pedido={reimprimirPedido}
          modo="faltantes"
          onClose={() => setReimprimirPedido(null)}
          onConcluido={() => {
            void queryClient.invalidateQueries({ queryKey: ["historico"] });
            void queryClient.invalidateQueries({
              queryKey: ["historico-detalhe", pedidoAberto],
            });
            void queryClient.invalidateQueries({ queryKey: ["pedidos"] });
          }}
        />
      )}
    </div>
  );
}
