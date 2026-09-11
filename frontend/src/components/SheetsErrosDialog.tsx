import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, TriangleAlert, X, CheckCircle2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { formatarData, textoUtil, resumirErroSheets } from "../lib/format";

export type SheetsErroItem = {
  order_id: string;
  line_key: string;
  sku?: string;
  seller?: string;
  erro: string;
  conferido_por?: string | null;
  data_conferencia?: string | null;
  status_item?: string | null;
  pedido?: string | null;
  pedido_any?: string | null;
  cliente?: string | null;
  mkp?: string | null;
  status_any?: string | null;
  data_coleta?: string | null;
};

type Props = {
  onClose: () => void;
};

function chaveItem(item: SheetsErroItem) {
  return `${item.order_id}|${item.line_key}`;
}

export default function SheetsErrosDialog({ onClose }: Props) {
  const qc = useQueryClient();
  const [erroRetry, setErroRetry] = useState<string | null>(null);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["erros-sheets"],
    queryFn: async () => {
      const { data: resp } = await api.get<{ items: SheetsErroItem[]; total: number }>(
        "/pedidos/erros-sheets"
      );
      return resp;
    },
    refetchOnWindowFocus: true,
  });

  const resolver = useMutation({
    mutationFn: async (item: SheetsErroItem) => {
      await api.post("/pedidos/erros-sheets/resolver", {
        order_id: item.order_id,
        line_key: item.line_key,
      });
      return item;
    },
    onSuccess: async () => {
      setErroRetry(null);
      await qc.invalidateQueries({ queryKey: ["erros-sheets"] });
      await qc.invalidateQueries({ queryKey: ["erros-sheets-count"] });
    },
  });

  const retry = useMutation({
    mutationFn: async (item: SheetsErroItem) => {
      const { data: resp } = await api.post<{ ok: boolean; mensagem?: string }>(
        "/pedidos/erros-sheets/retry",
        {
          order_id: item.order_id,
          line_key: item.line_key,
        }
      );
      return { item, resp };
    },
    onSuccess: async () => {
      setErroRetry(null);
      await qc.invalidateQueries({ queryKey: ["erros-sheets"] });
      await qc.invalidateQueries({ queryKey: ["erros-sheets-count"] });
      await qc.invalidateQueries({ queryKey: ["historico"] });
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data
        ?.detail;
      setErroRetry(
        typeof detail === "string" ? detail : "Falha ao tentar de novo na planilha."
      );
    },
  });

  const items = data?.items ?? [];
  const ocupado = resolver.isPending || retry.isPending;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/50">
        <div className="flex items-center justify-between gap-3 border-b border-border-soft px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <TriangleAlert size={16} className="shrink-0 text-amber" />
            <h2 className="font-display text-base font-semibold text-text">Erros Sheets</h2>
            {items.length > 0 && (
              <span className="rounded-full bg-amber/15 px-2 py-0.5 font-mono text-[11px] text-amber">
                {items.length}
              </span>
            )}
            {isFetching && !isLoading && (
              <Loader2 size={13} className="animate-spin text-text-faint" />
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-faint transition hover:bg-elevated hover:text-text"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {erroRetry && (
            <div className="mb-3 rounded-xl border border-red/25 bg-red/10 px-3 py-2 text-xs text-red">
              {erroRetry}
            </div>
          )}
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin" />
              Carregando…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red/25 bg-red/10 px-4 py-3 text-sm text-red">
              Não foi possível carregar a fila.
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <CheckCircle2 size={26} className="text-green" />
              <p className="text-sm text-text">Nenhum erro pendente</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => {
                const k = chaveItem(item);
                const resolvendo =
                  resolver.isPending &&
                  resolver.variables &&
                  chaveItem(resolver.variables) === k;
                const tentando =
                  retry.isPending &&
                  retry.variables &&
                  chaveItem(retry.variables) === k;
                const resumo = resumirErroSheets(item.erro);
                const meta = [
                  textoUtil(item.cliente),
                  textoUtil(item.mkp),
                  item.data_conferencia ? formatarData(item.data_conferencia, true) : "",
                ]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <li
                    key={k}
                    className="flex items-start gap-3 rounded-xl border border-border-soft bg-elevated/40 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-mono text-sm font-medium text-text">
                          {textoUtil(item.pedido) ||
                            textoUtil(item.pedido_any) ||
                            `ID ${item.order_id}`}
                        </p>
                        <span className="rounded border border-amber/30 bg-amber/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber">
                          Planilha
                        </span>
                      </div>
                      {meta ? (
                        <p className="mt-0.5 truncate text-[11px] text-text-muted">{meta}</p>
                      ) : null}
                      <p className="mt-1.5 text-xs leading-snug text-text">{resumo}</p>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <button
                        type="button"
                        disabled={ocupado}
                        onClick={() => {
                          setErroRetry(null);
                          retry.mutate(item);
                        }}
                        className="inline-flex items-center justify-center gap-1 rounded-lg border border-amber/35 bg-amber/10 px-2.5 py-1.5 text-xs font-semibold text-amber transition hover:bg-amber/20 disabled:opacity-50"
                        title="Tentar atualizar a planilha de novo"
                      >
                        {tentando ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <RefreshCw size={12} />
                        )}
                        Retry
                      </button>
                      <button
                        type="button"
                        disabled={ocupado}
                        onClick={() => resolver.mutate(item)}
                        className="rounded-lg border border-green/30 bg-green/10 px-2.5 py-1.5 text-xs font-semibold text-green transition hover:bg-green/20 disabled:opacity-50"
                        title="Marcar como resolvido sem reenviar"
                      >
                        {resolvendo ? <Loader2 size={12} className="animate-spin" /> : "OK"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-end border-t border-border-soft px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-muted transition hover:bg-elevated hover:text-text"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
