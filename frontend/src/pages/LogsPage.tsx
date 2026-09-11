import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Download } from "lucide-react";
import { api } from "../lib/api";

type LogRow = {
  created_at: string;
  usuario: string;
  tipo_acao: string;
  detalhes: string;
  pedido_id: string | null;
  /** PM se existir; senão Pedido Any / id */
  pedido_exibicao?: string | null;
};

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

function ehAcaoErro(tipo: string) {
  const t = (tipo || "").toUpperCase();
  if (!t) return false;
  // Resolvido / sucesso: não tratar como erro mesmo se o nome tenha "ERRO".
  if (t.includes("RESOLVIDO") || t.includes("SUCCESS") || t.endsWith("_OK")) {
    return false;
  }
  return t.includes("ERRO") || t.includes("ERROR") || t.includes("FAIL");
}

function corAcao(tipo: string) {
  const t = (tipo || "").toUpperCase();
  if (t.includes("RESOLVIDO") || t.includes("SUCCESS") || t.endsWith("_OK")) {
    return "text-green";
  }
  if (ehAcaoErro(tipo)) return "text-red";
  return "text-cyan";
}

function rotuloPedido(r: LogRow) {
  const exibicao = String(r.pedido_exibicao ?? "").trim();
  if (exibicao) return exibicao;
  const id = String(r.pedido_id ?? "").trim();
  return id || "—";
}

export default function LogsPage() {
  const hoje = hojeISO(0);
  const [dataIni, setDataIni] = useState(hoje);
  const [dataFim, setDataFim] = useState(hoje);
  const [tipoAcao, setTipoAcao] = useState("");
  const [usuarioFiltro, setUsuarioFiltro] = useState("");
  const [pedidoFiltro, setPedidoFiltro] = useState("");

  const [filtrosAplicados, setFiltrosAplicados] = useState({
    dataIni: hoje,
    dataFim: hoje,
    tipoAcao: "",
    usuarioFiltro: "",
    pedidoFiltro: "",
  });

  const { data, isFetching } = useQuery({
    queryKey: ["logs", filtrosAplicados],
    queryFn: async () => {
      const { data } = await api.get<{ total: number; items: LogRow[] }>("/logs", {
        params: {
          data_ini: filtrosAplicados.dataIni,
          data_fim: filtrosAplicados.dataFim,
          tipo_acao: filtrosAplicados.tipoAcao || undefined,
          usuario: filtrosAplicados.usuarioFiltro || undefined,
          pedido_id: filtrosAplicados.pedidoFiltro || undefined,
        },
      });
      return data;
    },
    staleTime: 20_000,
  });

  function aplicarFiltros() {
    setFiltrosAplicados({ dataIni, dataFim, tipoAcao, usuarioFiltro, pedidoFiltro });
  }

  function exportarCSV() {
    if (!data?.items?.length) return;
    const header = ["Data/Hora", "Usuário", "Ação", "Detalhes", "Pedido"];
    const linhas = data.items.map((r) => [
      formatarDataHora(r.created_at),
      r.usuario,
      r.tipo_acao,
      r.detalhes ?? "",
      rotuloPedido(r),
    ]);
    const csv = [header, ...linhas]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    a.href = url;
    a.download = `logs_${ts}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-6 pt-5 pb-2">
      <h1 className="mb-5 shrink-0 font-display text-xl font-semibold">Logs do sistema</h1>

      <div className="mb-4 flex shrink-0 flex-wrap items-end gap-3">
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
        <div className="min-w-[160px] flex-1">
          <label className="mb-1 block text-xs text-text-muted">Tipo de ação (contém)</label>
          <input
            value={tipoAcao}
            onChange={(e) => setTipoAcao(e.target.value)}
            placeholder="Ex: LOGIN, ERRO, IMPRESSAO"
            className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm outline-none focus:border-amber"
          />
        </div>
        <div className="min-w-[140px]">
          <label className="mb-1 block text-xs text-text-muted">Usuário</label>
          <input
            value={usuarioFiltro}
            onChange={(e) => setUsuarioFiltro(e.target.value)}
            className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm outline-none focus:border-amber"
          />
        </div>
        <div className="min-w-[140px]">
          <label className="mb-1 block text-xs text-text-muted">Nº do pedido</label>
          <input
            value={pedidoFiltro}
            onChange={(e) => setPedidoFiltro(e.target.value)}
            className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm outline-none focus:border-amber"
          />
        </div>
        <button
          onClick={aplicarFiltros}
          className="flex items-center gap-2 rounded-lg bg-amber px-4 py-2 text-sm font-medium text-void transition hover:brightness-110"
        >
          <Search size={15} />
          Filtrar
        </button>
        <button
          onClick={exportarCSV}
          disabled={!data?.items?.length || isFetching}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-text-muted transition hover:border-text-faint hover:text-text disabled:opacity-40"
        >
          <Download size={15} />
          Exportar CSV
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-soft">
        <table className="data-table w-full min-w-[720px] text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="bg-elevated text-xs uppercase tracking-wide text-text-muted">
              <th className="px-4 py-2.5 text-left font-medium">Data/Hora</th>
              <th className="px-4 py-2.5 text-left font-medium">Usuário</th>
              <th className="px-4 py-2.5 text-left font-medium">Ação</th>
              <th className="px-4 py-2.5 text-left font-medium">Detalhes</th>
              <th className="px-4 py-2.5 text-left font-medium">Pedido</th>
            </tr>
          </thead>
          <tbody>
            {data?.items?.length ? (
              data.items.map((r, i) => {
                return (
                  <tr
                    key={i}
                    className="border-t border-border-soft transition hover:bg-elevated/50"
                  >
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-text-muted">
                      {formatarDataHora(r.created_at)}
                    </td>
                    <td className="px-4 py-2">{r.usuario}</td>
                    <td className={`px-4 py-2 font-mono text-xs font-medium ${corAcao(r.tipo_acao)}`}>
                      {r.tipo_acao}
                    </td>
                    <td className="px-4 py-2 text-text-muted">{r.detalhes}</td>
                    <td className="px-4 py-2 font-mono text-xs">{rotuloPedido(r)}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-text-faint">
                  Nenhum log encontrado para os filtros selecionados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
