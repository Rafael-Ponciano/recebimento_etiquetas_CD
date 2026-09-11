import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { Pedido } from "../types/pedido";
import { formatarData, normalizarParaBusca, termosBuscaUniversal } from "../lib/format";
import StatusCdComNf from "./StatusCdComNf";

type Props = {
  titulo: string;
  pedidos: Pedido[];
  onClose: () => void;
};

export default function PedidosRecorteDialog({ titulo, pedidos, onClose }: Props) {
  const [busca, setBusca] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtrados = useMemo(() => {
    const termos = termosBuscaUniversal(busca);
    if (!termos.length) return pedidos;
    return pedidos.filter((p) => {
      const texto = normalizarParaBusca(
        [
          p.Pedido,
          p.id_any,
          p.Cliente,
          p["Status CD"],
          p["Status Any"],
          p.Mkp,
          p["NF Venda"],
          p["Data Coleta"],
        ].join(" ")
      );
      return termos.every((t) => texto.includes(t));
    });
  }, [pedidos, busca]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pedidos-recorte-titulo"
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-soft px-5 py-3.5">
          <div className="min-w-0">
            <h2
              id="pedidos-recorte-titulo"
              className="truncate font-display text-base font-semibold text-text"
            >
              {titulo}
            </h2>
            <p className="mt-0.5 font-mono text-[11px] text-text-faint">
              {filtrados.length.toLocaleString("pt-BR")} pedido
              {filtrados.length === 1 ? "" : "s"}
              {busca.trim() ? ` · filtrado de ${pedidos.length}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted transition hover:bg-elevated hover:text-text"
            aria-label="Fechar"
          >
            <X size={17} />
          </button>
        </div>

        <div className="border-b border-border-soft px-5 py-3">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-elevated/80 px-3 focus-within:border-amber/70">
            <Search size={14} className="shrink-0 text-text-faint" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar no recorte…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-faint"
              autoFocus
            />
            {busca ? (
              <button
                type="button"
                onClick={() => setBusca("")}
                className="text-text-faint hover:text-text"
                aria-label="Limpar busca"
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="data-table w-full text-sm">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="text-xs uppercase tracking-wide text-text-muted">
                <th className="px-4 py-2.5 text-left font-medium">Pedido</th>
                <th className="px-4 py-2.5 text-left font-medium">Cliente</th>
                <th className="px-4 py-2.5 text-left font-medium">Status CD</th>
                <th className="px-4 py-2.5 text-left font-medium">STATUS</th>
                <th className="px-4 py-2.5 text-left font-medium">Data Coleta</th>
                <th className="px-4 py-2.5 text-left font-medium">Mkp</th>
                <th className="px-4 py-2.5 text-left font-medium">NF Pedido</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.length ? (
                filtrados.map((p) => (
                  <tr
                    key={String(p.id_any)}
                    className="border-t border-border-soft hover:bg-elevated/40"
                  >
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-[12px]">
                      {p.Pedido || "—"}
                    </td>
                    <td className="max-w-[12rem] truncate px-4 py-2 text-text-muted">
                      {p.Cliente || "—"}
                    </td>
                    <td className="px-4 py-2">
                      <StatusCdComNf statusCd={p["Status CD"]} statusNf={p.status_nf} />
                    </td>
                    <td className="px-4 py-2 text-[12px] text-text-muted">
                      {p["Status Any"] || "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-[12px] tabular-nums text-text-muted">
                      {formatarData(p["Data Coleta"])}
                    </td>
                    <td className="px-4 py-2 text-[12px] text-text-muted">{p.Mkp || "—"}</td>
                    <td className="px-4 py-2 font-mono text-[12px] text-text-muted">
                      {p["NF Venda"]?.trim() || "—"}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-text-faint">
                    Nenhum pedido neste recorte.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
