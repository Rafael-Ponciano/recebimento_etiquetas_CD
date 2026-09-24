import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  FileSpreadsheet,
  Printer,
  Search,
  RotateCcw,
  Eye,
  Download,
  X,
  Clock,
  Package,
  CheckCircle2,
} from "lucide-react";

export interface RomaneioPacote {
  id: string;
  pedido: string;
  nf: string;
  cliente: string;
  tipo_coleta?: string;
  horario_bip?: string;
}

export interface RomaneioExpedido {
  codigo_romaneio: string;
  data_coleta: string;
  horario_coleta: string;
  marketplace: string;
  transportadora: string;
  operador: string;
  total_pedidos: number;
  pedidos: RomaneioPacote[];
}

const LOGOS_MKP: Record<string, { nome: string; logo: string; cor: string }> = {
  meli: { nome: "Mercado Livre", logo: "/mkp/meli.png", cor: "border-amber/40 bg-amber/10 text-amber" },
  shopee: { nome: "Shopee", logo: "/mkp/shopee.png", cor: "border-orange-500/40 bg-orange-500/10 text-orange-400" },
  magalu: { nome: "Magalu", logo: "/mkp/magalu.png", cor: "border-blue-500/40 bg-blue-500/10 text-blue-400" },
  total_express: { nome: "Tray / Total", logo: "/mkp/tray.png", cor: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300" },
  tray: { nome: "Tray / Total", logo: "/mkp/tray.png", cor: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300" },
};

export default function RomaneiosExpedidosTab() {
  const [buscaTexto, setBuscaTexto] = useState("");
  const [filtroPeriodo, setFiltroPeriodo] = useState<"hoje" | "ontem" | "7dias" | "30dias">("hoje");
  const [filtroMkp, setFiltroMkp] = useState<string>("todos");
  const [romaneioSelecionado, setRomaneioSelecionado] = useState<RomaneioExpedido | null>(null);

  const diasConsulta = filtroPeriodo === "30dias" ? 30 : filtroPeriodo === "7dias" ? 7 : 2;

  const {
    data: romaneiosData,
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["romaneios-expedidos", diasConsulta],
    queryFn: async () => {
      const resp = await api.get<{ items: RomaneioExpedido[]; total: number }>(
        `/pedidos/despachos/romaneios?dias=${diasConsulta}&refresh=true`
      );
      return resp.data.items || [];
    },
    staleTime: 30_000,
  });

  const imprimirRomaneioModal = () => {
    const limparModo = () => document.body.classList.remove("imprimindo-romaneio-despacho");
    document.body.classList.add("imprimindo-romaneio-despacho");
    window.addEventListener("afterprint", limparModo, { once: true });
    window.print();
    window.setTimeout(limparModo, 1_000);
  };

  const exportarCsvRomaneio = (r: RomaneioExpedido) => {
    const cabecalho = ["Código Romaneio", "Data Coleta", "Transportadora", "Operador", "Pedido", "NF Venda", "Cliente", "Horário Bip"];
    const linhas = (r.pedidos || []).map((p) => [
      `"${r.codigo_romaneio}"`,
      `"${r.data_coleta}"`,
      `"${r.transportadora || r.marketplace}"`,
      `"${r.operador}"`,
      `"${p.pedido}"`,
      `"${p.nf}"`,
      `"${(p.cliente || "").replace(/"/g, '""')}"`,
      `"${p.horario_bip || ""}"`,
    ]);

    const csvContent = "\uFEFF" + [cabecalho.join(";"), ...linhas.map((l) => l.join(";"))].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `romaneio_${r.codigo_romaneio}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filtragem local por período, marketplace e busca textual
  const hojeStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const ontemStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }, []);

  const romaneiosFiltrados = useMemo(() => {
    const lista = romaneiosData || [];
    return lista.filter((r) => {
      // Filtro de período
      if (filtroPeriodo === "hoje" && r.data_coleta !== hojeStr) return false;
      if (filtroPeriodo === "ontem" && r.data_coleta !== ontemStr) return false;

      // Filtro de marketplace
      if (filtroMkp !== "todos") {
        const mkpNorm = (r.marketplace || "").toLowerCase();
        const filtroNorm = filtroMkp.toLowerCase();
        const bate = filtroNorm === "total_express" ? (mkpNorm === "tray" || mkpNorm === "total_express") : mkpNorm === filtroNorm;
        if (!bate) return false;
      }

      // Busca textual
      if (buscaTexto.trim()) {
        const termo = buscaTexto.toLowerCase();
        const noCabecalho =
          (r.codigo_romaneio || "").toLowerCase().includes(termo) ||
          (r.transportadora || "").toLowerCase().includes(termo) ||
          (r.operador || "").toLowerCase().includes(termo);

        if (noCabecalho) return true;

        const nosPedidos = (r.pedidos || []).some(
          (p) =>
            (p.pedido || "").toLowerCase().includes(termo) ||
            (p.nf || "").toLowerCase().includes(termo) ||
            (p.cliente || "").toLowerCase().includes(termo)
        );
        return nosPedidos;
      }

      return true;
    });
  }, [romaneiosData, filtroPeriodo, filtroMkp, buscaTexto, hojeStr, ontemStr]);

  // Estatísticas do topo
  const totais = useMemo(() => {
    const lista = romaneiosFiltrados;
    const totalRomaneios = lista.length;
    const totalPacotes = lista.reduce((acc, r) => acc + (r.total_pedidos || (r.pedidos?.length ?? 0)), 0);
    return { totalRomaneios, totalPacotes };
  }, [romaneiosFiltrados]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-void">
      {/* Barra de Filtros e Controles */}
      <div className="shrink-0 border-b border-border bg-surface px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* Seletor de Período */}
            <div className="flex items-center rounded-lg border border-border bg-elevated p-0.5 text-xs">
              {(
                [
                  { id: "hoje", label: "Hoje" },
                  { id: "ontem", label: "Ontem" },
                  { id: "7dias", label: "7 dias" },
                  { id: "30dias", label: "30 dias" },
                ] as const
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setFiltroPeriodo(p.id)}
                  className={`rounded-md px-2.5 py-1 font-medium transition ${
                    filtroPeriodo === p.id
                      ? "bg-surface text-amber font-semibold shadow-xs"
                      : "text-text-muted hover:text-text"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Seletor de Canal */}
            <select
              value={filtroMkp}
              aria-label="Filtrar por canal ou transportadora"
              onChange={(e) => setFiltroMkp(e.target.value)}
              className="h-8 rounded-lg border border-border bg-elevated px-2.5 text-xs text-text outline-none transition hover:border-text-faint focus:border-amber"
            >
              <option value="todos">Todos os Canais</option>
              <option value="meli">Mercado Livre</option>
              <option value="shopee">Shopee</option>
              <option value="magalu">Magalu</option>
              <option value="total_express">Tray / Total Express</option>
            </select>

            {/* Input de Busca */}
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-2.5 text-text-faint" />
              <input
                type="text"
                value={buscaTexto}
                onChange={(e) => setBuscaTexto(e.target.value)}
                placeholder="Buscar cód, NF, pedido, cliente..."
                className="h-8 w-56 rounded-lg border border-border bg-elevated pl-8 pr-7 text-xs text-text outline-none transition placeholder:text-text-faint focus:border-amber focus:w-64"
              />
              {buscaTexto && (
                <button
                  type="button"
                  onClick={() => setBuscaTexto("")}
                  className="absolute right-2 top-2 text-text-faint hover:text-text"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Ações e Contadores */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className="rounded-md border border-border bg-elevated px-2 py-0.5 text-text-muted">
                {totais.totalRomaneios} {totais.totalRomaneios === 1 ? "romaneio" : "romaneios"}
              </span>
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-bold text-emerald-400">
                {totais.totalPacotes} pacotes expedidos
              </span>
            </div>

            <button
              type="button"
              onClick={() => refetch()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 text-xs text-text-muted transition hover:border-text-faint hover:text-text"
              title="Recarregar romaneios"
            >
              <RotateCcw size={12} className={isFetching ? "animate-spin" : ""} />
              Atualizar
            </button>
          </div>
        </div>
      </div>

      {/* Lista de Romaneios */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-text-muted">
            <RotateCcw size={20} className="animate-spin text-amber" />
            <span className="text-xs">Carregando romaneios expedidos...</span>
          </div>
        ) : romaneiosFiltrados.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-elevated/30 text-text-muted">
            <FileSpreadsheet size={32} className="text-text-faint" />
            <p className="text-sm font-semibold text-text">Nenhum romaneio encontrado no período</p>
            <p className="text-xs text-text-faint">
              Quando a transportadora coletar os pacotes e o operador clicar em &quot;Confirmar Despacho&quot;, o romaneio aparecerá aqui.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-elevated/70 font-mono text-[11px] uppercase tracking-wider text-text-faint">
                  <th className="px-4 py-3">Código</th>
                  <th className="px-4 py-3">Data e Horário</th>
                  <th className="px-4 py-3">Transportadora</th>
                  <th className="px-4 py-3">Operador</th>
                  <th className="px-4 py-3 text-center">Pacotes</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60 text-xs">
                {romaneiosFiltrados.map((r) => {
                  const mkpInfo = LOGOS_MKP[(r.marketplace || "").toLowerCase()] || {
                    nome: r.marketplace || "Transportadora",
                    logo: "",
                    cor: "border-border bg-elevated text-text",
                  };

                  let horarioFmt = r.horario_coleta;
                  try {
                    const d = new Date(r.horario_coleta);
                    horarioFmt = `${d.toLocaleDateString("pt-BR")} às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
                  } catch {
                    // Fallback
                  }

                  const totalP = r.total_pedidos || (r.pedidos?.length ?? 0);

                  return (
                    <tr key={r.codigo_romaneio} className="transition hover:bg-white/[.02]">
                      <td className="px-4 py-3 font-mono font-bold text-white">
                        <span className="rounded-md border border-border bg-elevated px-2 py-0.5 text-[11px] text-amber">
                          {r.codigo_romaneio}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-text-muted">
                        <div className="flex items-center gap-1.5">
                          <Clock size={12} className="text-text-faint" />
                          <span>{horarioFmt}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold ${mkpInfo.cor}`}>
                            {mkpInfo.nome}
                          </span>
                          <span className="text-text-muted text-[11px]">{r.transportadora}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-text-muted">
                        <span className="font-medium text-text">{r.operador || "Operador"}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] font-bold text-emerald-400">
                          <Package size={11} />
                          {totalP}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setRomaneioSelecionado(r)}
                            className="inline-flex items-center gap-1 rounded-lg border border-border bg-elevated px-2.5 py-1 text-xs font-medium text-text transition hover:border-amber hover:text-amber"
                            title="Ver detalhes dos pedidos deste romaneio"
                          >
                            <Eye size={12} />
                            Ver Pedidos
                          </button>
                          <button
                            type="button"
                            onClick={() => exportarCsvRomaneio(r)}
                            className="inline-flex items-center gap-1 rounded-lg border border-border bg-elevated px-2 py-1 text-xs text-text-muted transition hover:bg-surface hover:text-text"
                            title="Exportar relação em CSV"
                          >
                            <Download size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* MODAL DE DETALHES E REIMPRESSÃO DO ROMANEIO SELECIONADO                  */}
      {/* ========================================================================= */}
      {romaneioSelecionado && (
        <div className="despacho-fundo-romaneio fixed inset-0 z-60 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
          <div className="despacho-romaneio flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/80">
            {/* Topo */}
            <div className="flex shrink-0 items-center justify-between border-b border-border bg-elevated/70 px-6 py-3.5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber/30 bg-amber/15 text-amber">
                  <FileSpreadsheet size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-display text-sm font-bold text-white">
                      Romaneio de Coleta — {romaneioSelecionado.transportadora || romaneioSelecionado.marketplace}
                    </h3>
                    <span className="font-mono text-[11px] font-bold text-amber">
                      {romaneioSelecionado.codigo_romaneio}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-text-faint">
                    Coletado em {romaneioSelecionado.horario_coleta} por <strong>{romaneioSelecionado.operador}</strong>
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setRomaneioSelecionado(null)}
                className="despacho-nao-imprimir rounded-lg p-1 text-text-faint transition hover:bg-surface hover:text-text"
                aria-label="Fechar modal"
              >
                <X size={16} />
              </button>
            </div>

            {/* Conteúdo da Tabela do Romaneio */}
            <div className="flex flex-1 flex-col overflow-y-auto p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-elevated/40 px-4 py-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-text-faint">Status:</span>
                  <span className="inline-flex items-center gap-1 font-bold text-emerald-400">
                    <CheckCircle2 size={13} />
                    COLETA CONFIRMADA / ENVIADO
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-faint">Total de Pacotes Coletados:</span>
                  <strong className="font-mono text-white">
                    {romaneioSelecionado.total_pedidos || romaneioSelecionado.pedidos?.length || 0}
                  </strong>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-border bg-[#0e1218]">
                <table className="w-full border-collapse text-left font-mono text-xs">
                  <thead>
                    <tr className="border-b border-border bg-elevated/70 text-[10px] uppercase tracking-wider text-text-faint">
                      <th className="px-3.5 py-2.5">#</th>
                      <th className="px-3.5 py-2.5">Pedido</th>
                      <th className="px-3 py-2.5">NF Venda</th>
                      <th className="px-3 py-2.5 font-sans">Cliente</th>
                      <th className="px-3 py-2.5">Tipo</th>
                      <th className="px-3.5 py-2.5 text-right">Bipado às</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {(romaneioSelecionado.pedidos || []).map((p, idx) => (
                      <tr key={p.id || idx} className="hover:bg-white/[.02]">
                        <td className="px-3.5 py-2 text-text-faint">{idx + 1}</td>
                        <td className="px-3.5 py-2 font-bold text-white">{p.pedido}</td>
                        <td className="px-3 py-2 text-text-muted">{p.nf}</td>
                        <td className="max-w-[200px] truncate px-3 py-2 font-sans text-text-muted" title={p.cliente}>
                          {p.cliente}
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-[10px] text-text-faint uppercase">{p.tipo_coleta || "Coleta"}</span>
                        </td>
                        <td className="px-3.5 py-2 text-right text-emerald-400 font-semibold">
                          {p.horario_bip || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border bg-elevated/60 text-[11px]">
                      <td colSpan={6} className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-4 font-sans text-xs">
                          <div>
                            <span className="text-text-faint">👤 Operador Expedidor: </span>
                            <strong className="text-white">{romaneioSelecionado.operador}</strong>
                          </div>
                          <div>
                            <span className="text-text-faint">🚚 Transportadora: </span>
                            <strong className="text-white">{romaneioSelecionado.transportadora}</strong>
                          </div>
                          <div className="font-semibold text-emerald-400">
                            ✓ Visto / Comprovante de Coleta CD
                          </div>
                        </div>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Rodapé do Modal */}
            <div className="despacho-nao-imprimir flex shrink-0 items-center justify-between border-t border-border bg-elevated/60 px-6 py-3">
              <button
                type="button"
                onClick={() => exportarCsvRomaneio(romaneioSelecionado)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-muted transition hover:bg-elevated hover:text-text"
              >
                <Download size={13} />
                Exportar CSV
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRomaneioSelecionado(null)}
                  className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-text-muted transition hover:bg-elevated hover:text-text"
                >
                  Voltar
                </button>
                <button
                  type="button"
                  onClick={imprimirRomaneioModal}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber px-4 py-1.5 font-display text-xs font-bold text-void shadow transition hover:brightness-110 active:brightness-95"
                >
                  <Printer size={13} />
                  Reimprimir Romaneio
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
