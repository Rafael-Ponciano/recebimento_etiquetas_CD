import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, TriangleAlert, X, CheckCircle2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { formatarData, textoUtil } from "../lib/format";

export type FinalizacaoErroItem = {
  order_id: string;
  tipo?: string;
  categoria?: string;
  erro: string;
  usuario?: string | null;
  created_at?: string | null;
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

/** Texto curto por tipo — evita repetir o parágrafo longo do log. */
function resumoErro(item: FinalizacaoErroItem): { badge: string; acao: string } {
  const tipo = (item.tipo || "").toUpperCase();
  switch (tipo) {
    case "ERRO_NF_PEDIDO":
      return { badge: "Sem NF", acao: "Emita a NF Pedido e conclua a finalização." };
    case "ERRO_CONFERENCIA":
    case "ERRO_ANYMARKET":
      return { badge: "AnyMarket", acao: textoUtil(item.erro) || "Falha na conferência." };
    case "ERRO_ETIQUETA":
      return { badge: "Etiqueta", acao: textoUtil(item.erro) || "Falha ao baixar etiqueta/DANFE." };
    case "ERRO_IMPRESSAO":
    case "FINALIZACAO_AVISO_IMPRESSAO":
      return { badge: "Impressão", acao: textoUtil(item.erro) || "Falha na impressão." };
    case "FINALIZACAO_PENDENTE":
      return { badge: "Incompleto", acao: "Reabra o pedido e conclua a finalização." };
    default:
      return {
        badge: textoUtil(item.categoria) || "Erro",
        acao: textoUtil(item.erro) || "Reabra o pedido e conclua a finalização.",
      };
  }
}

export default function FinalizacaoErrosDialog({ onClose }: Props) {
  const qc = useQueryClient();
  const [erroRetry, setErroRetry] = useState<string | null>(null);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["erros-finalizacao"],
    queryFn: async () => {
      const { data: resp } = await api.get<{
        items: FinalizacaoErroItem[];
        total: number;
      }>("/pedidos/erros-finalizacao");
      return resp;
    },
    refetchOnWindowFocus: true,
  });

  const resolver = useMutation({
    mutationFn: async (item: FinalizacaoErroItem) => {
      await api.post("/pedidos/erros-finalizacao/resolver", {
        order_id: item.order_id,
      });
      return item;
    },
    onSuccess: async () => {
      setErroRetry(null);
      await qc.invalidateQueries({ queryKey: ["erros-finalizacao"] });
      await qc.invalidateQueries({ queryKey: ["erros-finalizacao-count"] });
      await qc.invalidateQueries({ queryKey: ["historico"] });
    },
  });

  const retry = useMutation({
    mutationFn: async (item: FinalizacaoErroItem) => {
      const { data: resp } = await api.post<{ ok: boolean; mensagem?: string }>(
        "/pedidos/erros-finalizacao/retry",
        { order_id: item.order_id }
      );
      return { item, resp };
    },
    onSuccess: async () => {
      setErroRetry(null);
      await qc.invalidateQueries({ queryKey: ["erros-finalizacao"] });
      await qc.invalidateQueries({ queryKey: ["erros-finalizacao-count"] });
      await qc.invalidateQueries({ queryKey: ["historico"] });
      await qc.invalidateQueries({ queryKey: ["pedidos"] });
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data
        ?.detail;
      setErroRetry(
        typeof detail === "string" ? detail : "Falha ao tentar de novo a finalização."
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
            <TriangleAlert size={16} className="shrink-0 text-red" />
            <h2 className="font-display text-base font-semibold text-text">
              Erros de conferência
            </h2>
            {items.length > 0 && (
              <span className="rounded-full bg-red/15 px-2 py-0.5 font-mono text-[11px] text-red">
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
                const { badge, acao } = resumoErro(item);
                const resolvendo =
                  resolver.isPending && resolver.variables?.order_id === item.order_id;
                const tentando =
                  retry.isPending && retry.variables?.order_id === item.order_id;
                const meta = [
                  textoUtil(item.cliente),
                  textoUtil(item.mkp),
                  item.created_at ? formatarData(item.created_at, true) : "",
                ]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <li
                    key={item.order_id}
                    className="flex items-start gap-3 rounded-xl border border-border-soft bg-elevated/40 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-mono text-sm font-medium text-text">
                          {textoUtil(item.pedido) ||
                            textoUtil(item.pedido_any) ||
                            `ID ${item.order_id}`}
                        </p>
                        <span className="rounded border border-red/25 bg-red/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-red">
                          {badge}
                        </span>
                      </div>
                      {meta ? (
                        <p className="mt-0.5 truncate text-[11px] text-text-muted">{meta}</p>
                      ) : null}
                      <p className="mt-1.5 text-xs leading-snug text-text">{acao}</p>
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
                        title="Tentar finalizar de novo"
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
                        title="Marcar como resolvido sem retentar"
                      >
                        {resolvendo ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          "OK"
                        )}
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
