import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, Loader2, Search, Wrench } from "lucide-react";
import { api } from "../lib/api";
import { formatarData } from "../lib/format";
import StatusBadge from "../components/StatusBadge";

type PedidoBaixa = {
  id_any: string;
  pedido?: string | null;
  pedido_any?: string | null;
  pedido_seller?: string | null;
  cliente?: string | null;
  mkp?: string | null;
  status_any?: string | null;
  data_pedido?: string | null;
  data_coleta?: string | null;
  filial_seller?: string | null;
};

type ResultadoBaixa = {
  ok: boolean;
  order_id: string;
  status_anterior?: string | null;
  status_novo: string;
  mensagem: string;
  alterado: boolean;
};

export default function BaixaManualPage() {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState("");
  const [termoAplicado, setTermoAplicado] = useState("");
  const [selecionado, setSelecionado] = useState<PedidoBaixa | null>(null);
  const [novoStatus, setNovoStatus] = useState("");
  const [observacao, setObservacao] = useState("");
  const [resultado, setResultado] = useState<ResultadoBaixa | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const { data: statusOpts } = useQuery({
    queryKey: ["baixa-manual-status"],
    queryFn: async () => {
      const { data } = await api.get<{ items: string[] }>("/baixa-manual/status");
      return data.items;
    },
  });

  const { data: encontrados, isFetching: buscando } = useQuery({
    queryKey: ["baixa-manual-buscar", termoAplicado],
    queryFn: async () => {
      const { data } = await api.get<{ items: PedidoBaixa[] }>("/baixa-manual/buscar", {
        params: { q: termoAplicado },
      });
      return data.items;
    },
    enabled: termoAplicado.trim().length >= 2,
  });

  const mutacao = useMutation({
    mutationFn: async () => {
      if (!selecionado) throw new Error("Selecione um pedido.");
      if (!novoStatus) throw new Error("Escolha o novo status.");
      const { data } = await api.post<ResultadoBaixa>("/baixa-manual/aplicar", {
        order_id: selecionado.id_any,
        novo_status: novoStatus,
        observacao: observacao.trim(),
      });
      return data;
    },
    onSuccess: (data) => {
      setErro(null);
      setResultado(data);
      if (data.alterado) {
        setSelecionado((atual) =>
          atual ? { ...atual, status_any: data.status_novo } : atual
        );
        void queryClient.invalidateQueries({ queryKey: ["pedidos"] });
        void queryClient.invalidateQueries({ queryKey: ["baixa-manual-buscar"] });
      }
    },
    onError: (e: any) => {
      setResultado(null);
      setErro(e?.response?.data?.detail ?? e?.message ?? "Falha na baixa manual.");
    },
  });

  const lista = encontrados ?? [];
  const statusLista = useMemo(() => statusOpts ?? [], [statusOpts]);

  function aplicarBusca(e?: FormEvent) {
    e?.preventDefault();
    const t = busca.trim();
    if (t.length < 2) {
      setErro("Digite ao menos 2 caracteres.");
      return;
    }
    setErro(null);
    setResultado(null);
    setSelecionado(null);
    setNovoStatus("");
    setTermoAplicado(t);
  }

  function escolher(p: PedidoBaixa) {
    setSelecionado(p);
    setNovoStatus(p.status_any || "");
    setObservacao("");
    setResultado(null);
    setErro(null);
  }

  function confirmar() {
    if (!selecionado || !novoStatus) return;
    if (novoStatus === selecionado.status_any) {
      setErro("Escolha um status diferente do atual.");
      return;
    }
    const ok = window.confirm(
      `Alterar status do pedido ${selecionado.id_any}?\n\n` +
        `${selecionado.status_any || "—"} → ${novoStatus}\n\n` +
        "Isso grava no banco e gera log na timeline."
    );
    if (!ok) return;
    mutacao.mutate();
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-6 pt-5 pb-4">
      <div className="mb-5 shrink-0">
        <h1 className="font-display font-semibold text-xl">Baixa manual</h1>
        <p className="mt-1 text-sm text-text-muted">
          Busque um pedido e altere o status manualmente. A ação gera log e aparece na timeline.
        </p>
      </div>

      <form onSubmit={aplicarBusca} className="mb-4 flex flex-wrap items-end gap-2 shrink-0">
        <div className="min-w-[240px] flex-1">
          <label className="mb-1 block text-xs text-text-muted">
            Pedido / PM / Seller / ID Any / Cliente
          </label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Ex.: PM-626H138, S-4754… ou ID Any"
              className="h-10 w-full rounded-lg border border-border bg-elevated pl-9 pr-3 text-sm text-text outline-none focus:border-amber"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={buscando}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-amber px-4 text-sm font-medium text-void transition hover:brightness-110 disabled:opacity-60"
        >
          {buscando ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Buscar
        </button>
      </form>

      {(erro || resultado) && (
        <div
          className={`mb-4 shrink-0 rounded-lg border px-3 py-2 text-sm ${
            erro
              ? "border-red/30 bg-red/10 text-red"
              : resultado?.alterado
                ? "border-green/30 bg-green/10 text-green"
                : "border-amber/30 bg-amber/10 text-amber"
          }`}
        >
          <div className="flex items-center gap-2">
            {erro ? <CircleX size={15} /> : <CircleCheck size={15} />}
            {erro || resultado?.mensagem}
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="flex min-h-0 flex-col rounded-xl border border-border-soft bg-surface/40">
          <div className="border-b border-border-soft px-3 py-2 text-xs font-medium uppercase tracking-wide text-text-faint">
            Resultados {termoAplicado ? `(${lista.length})` : ""}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!termoAplicado && (
              <p className="px-4 py-10 text-center text-sm text-text-faint">
                Busque por ID Any, PM-, S-, seller ou cliente.
              </p>
            )}
            {termoAplicado && !buscando && lista.length === 0 && (
              <p className="px-4 py-10 text-center text-sm text-text-faint">
                Nenhum pedido encontrado.
              </p>
            )}
            {lista.map((p) => {
              const ativo = selecionado?.id_any === p.id_any;
              return (
                <button
                  key={p.id_any}
                  type="button"
                  onClick={() => escolher(p)}
                  className={`flex w-full flex-col gap-1 border-b border-border-soft px-3 py-2.5 text-left transition hover:bg-elevated/60 ${
                    ativo ? "bg-elevated/80" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-text">{p.id_any}</span>
                    <StatusBadge status={p.status_any || ""} />
                  </div>
                  <p className="truncate text-xs text-text-muted">
                    {[p.pedido, p.pedido_any, p.pedido_seller, p.cliente]
                      .filter(Boolean)
                      .filter((v, i, arr) => arr.indexOf(v) === i)
                      .join(" · ") || "—"}
                  </p>
                  <p className="font-mono text-[10px] text-text-faint">
                    Pedido {formatarData(p.data_pedido ?? null)} · Coleta{" "}
                    {formatarData(p.data_coleta ?? null)}
                    {p.mkp ? ` · ${p.mkp}` : ""}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex min-h-0 flex-col rounded-xl border border-border-soft bg-surface/40 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text">
            <Wrench size={15} className="text-amber" />
            Atualizar status
          </div>

          {!selecionado ? (
            <p className="py-8 text-center text-sm text-text-faint">
              Selecione um pedido na lista ao lado.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-border-soft bg-elevated/50 px-3 py-2 text-sm">
                <p className="font-mono text-text">{selecionado.id_any}</p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {[selecionado.pedido, selecionado.cliente].filter(Boolean).join(" · ") || "—"}
                </p>
                <p className="mt-2 text-xs text-text-faint">
                  Status atual:{" "}
                  <span className="text-text">{selecionado.status_any || "—"}</span>
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs text-text-muted">Novo status</label>
                <select
                  value={novoStatus}
                  onChange={(e) => setNovoStatus(e.target.value)}
                  className="h-10 w-full rounded-lg border border-border bg-elevated px-3 text-sm text-text outline-none focus:border-amber"
                >
                  <option value="">Selecione…</option>
                  {statusLista.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs text-text-muted">
                  Observação (opcional)
                </label>
                <textarea
                  value={observacao}
                  onChange={(e) => setObservacao(e.target.value)}
                  rows={3}
                  placeholder="Motivo da baixa manual…"
                  className="w-full resize-none rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text outline-none focus:border-amber"
                />
              </div>

              <button
                type="button"
                onClick={confirmar}
                disabled={mutacao.isPending || !novoStatus}
                className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-amber px-4 text-sm font-medium text-void transition hover:brightness-110 disabled:opacity-60"
              >
                {mutacao.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Wrench size={14} />
                )}
                Confirmar baixa manual
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
