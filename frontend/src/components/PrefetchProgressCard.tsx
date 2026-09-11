import { useQuery } from "@tanstack/react-query";
import {
  CloudDownload,
  Loader2,
  PauseCircle,
  CheckCircle2,
  X,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";

type PrefetchStatus = {
  habilitado: boolean;
  baixando: boolean;
  pausado: boolean;
  pedido_atual: string | null;
  concluidos: number;
  faltando: number;
  total: number;
  pct: number;
  erros: number;
};

function rotuloStatus(data: PrefetchStatus) {
  if (data.pausado) return "Pausada — conferência tem prioridade";
  if (data.baixando) return "Baixando etiquetas e DANFE";
  if (data.faltando > 0) return "Na fila";
  if (data.pct >= 100 && data.total > 0) return "Concluída";
  return "Aguardando";
}

export default function PrefetchProgressCard() {
  const usuario = useAuthStore((s) => s.user?.usuario);
  const [aberto, setAberto] = useState(false);

  const { data } = useQuery({
    queryKey: ["etiquetas-prefetch-status", usuario],
    enabled: !!usuario,
    queryFn: async () => {
      const { data: body } = await api.get<PrefetchStatus>("/etiquetas-prefetch/status");
      return body;
    },
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d?.habilitado) return false;
      if (aberto) return 2_000;
      if (d.faltando > 0 || d.baixando) return 2_500;
      return 15_000;
    },
    staleTime: 1_500,
  });

  if (!data?.habilitado) return null;
  if (data.total <= 0 && data.faltando <= 0 && !data.baixando) return null;

  const pct = Math.min(100, Math.max(0, data.pct ?? 0));
  const ativo = data.baixando || data.faltando > 0;
  const total = data.total || data.concluidos + data.faltando;
  const barra =
    data.pausado ? "bg-amber/70" : pct >= 100 ? "bg-green" : "bg-cyan";

  return (
    <>
      <button
        type="button"
        onClick={() => setAberto(true)}
        title="Ver andamento da pré-baixa"
        className="flex min-w-[7.5rem] flex-col justify-center rounded-md border border-border-soft bg-elevated/50 px-2 py-1 leading-none transition hover:border-cyan/40 hover:bg-cyan/10"
      >
        <div className="flex items-center justify-between gap-1.5">
          <span className="inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wide text-text-faint">
            {ativo && !data.pausado ? (
              <Loader2 size={8} className="animate-spin text-cyan" />
            ) : (
              <CloudDownload
                size={8}
                className={data.pausado ? "text-amber" : "text-text-faint"}
              />
            )}
            Pré-baixa
          </span>
          <span className="font-mono text-[10px] tabular-nums text-text-muted">{pct}%</span>
        </div>
        <div className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-void">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barra}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-0.5 flex justify-between font-mono text-[9px] tabular-nums text-text-faint">
          <span>
            {data.concluidos}/{total}
          </span>
          <span>{data.faltando > 0 ? `${data.faltando} rest.` : "ok"}</span>
        </div>
      </button>

      {aberto && (
        <PrefetchAndamentoDialog data={data} onClose={() => setAberto(false)} />
      )}
    </>
  );
}

function PrefetchAndamentoDialog({
  data,
  onClose,
}: {
  data: PrefetchStatus;
  onClose: () => void;
}) {
  const pct = Math.min(100, Math.max(0, data.pct ?? 0));
  const total = data.total || data.concluidos + data.faltando;
  const ativo = data.baixando || data.faltando > 0;
  const barra =
    data.pausado ? "bg-amber" : pct >= 100 ? "bg-green" : "bg-cyan";
  const status = rotuloStatus(data);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prefetch-andamento-titulo"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-soft px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            {ativo && !data.pausado ? (
              <Loader2 size={16} className="shrink-0 animate-spin text-cyan" />
            ) : data.pausado ? (
              <PauseCircle size={16} className="shrink-0 text-amber" />
            ) : pct >= 100 ? (
              <CheckCircle2 size={16} className="shrink-0 text-green" />
            ) : (
              <CloudDownload size={16} className="shrink-0 text-text-muted" />
            )}
            <h2
              id="prefetch-andamento-titulo"
              className="font-display text-base font-semibold text-text"
            >
              Pré-baixa
            </h2>
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

        <div className="space-y-5 p-5">
          <div>
            <div className="mb-2 flex items-end justify-between gap-3">
              <p className="text-sm text-text-muted">{status}</p>
              <span className="font-mono text-2xl font-semibold tabular-nums text-text">
                {pct}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-void">
              <div
                className={`h-full rounded-full transition-all duration-500 ${barra}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatMini label="Concluídos" value={String(data.concluidos)} />
            <StatMini label="Restantes" value={String(data.faltando)} />
            <StatMini label="Total" value={String(total)} />
            <StatMini
              label="Erros"
              value={String(data.erros)}
              destaque={data.erros > 0 ? "red" : undefined}
            />
          </div>

          {data.pedido_atual && (
            <div className="rounded-xl border border-border-soft bg-elevated/40 px-3.5 py-3">
              <p className="text-[10px] uppercase tracking-wide text-text-faint">
                Pedido atual
              </p>
              <p className="mt-1 font-mono text-sm text-text">{data.pedido_atual}</p>
            </div>
          )}

          {data.pausado && (
            <div className="flex items-start gap-2 rounded-xl border border-amber/30 bg-amber/10 px-3.5 py-3 text-sm text-amber">
              <PauseCircle size={15} className="mt-0.5 shrink-0" />
              <span>
                Pausada enquanto há conferência em andamento. Retoma automaticamente
                depois.
              </span>
            </div>
          )}

          {data.erros > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-red/25 bg-red/10 px-3.5 py-3 text-sm text-red">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" />
              <span>
                {data.erros} falha{data.erros === 1 ? "" : "s"} ignorada
                {data.erros === 1 ? "" : "s"} — o pedido segue sem bloquear a fila.
              </span>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-text-faint">
            Pré-baixa de etiqueta e DANFE para pedidos com NF, em separação ou a
            conferir. Ordem: data de coleta mais antiga primeiro.
          </p>
        </div>
      </div>
    </div>
  );
}

function StatMini({
  label,
  value,
  destaque,
}: {
  label: string;
  value: string;
  destaque?: "red";
}) {
  return (
    <div className="rounded-xl border border-border-soft bg-elevated/40 px-3 py-2.5 text-center">
      <p className="text-[10px] uppercase tracking-wide text-text-faint">{label}</p>
      <p
        className={`mt-1 font-mono text-lg tabular-nums ${
          destaque === "red" ? "text-red" : "text-text"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
