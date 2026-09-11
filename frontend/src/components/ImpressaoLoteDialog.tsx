import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Loader2,
  CircleCheck,
  CircleX,
  Package,
  FileText,
  Printer,
  Table2,
  RotateCcw,
  Download,
  Play,
  AlertTriangle,
  ClipboardCheck,
} from "lucide-react";
import { api } from "../lib/api";

export type PedidoLoteItem = {
  id_any: string;
  pedido: string;
  cliente: string;
  mkp: string;
  agendado?: boolean;
};

type EtapaStatus = "idle" | "ativo" | "ok" | "erro" | "pulado";

export type PedidoProgresso = {
  id_any: string;
  conferencia: EtapaStatus;
  etiqueta_download: EtapaStatus;
  danfe_download: EtapaStatus;
  etiqueta_impressao: EtapaStatus;
  danfe_impressao: EtapaStatus;
  planilha: EtapaStatus;
  erro_conferencia?: string;
  erro_impressao?: string;
  erro_planilha?: string;
};

export type FaseLote =
  | "confirmacao"
  | "processando"
  | "planilha"
  | "resultado";

type LotePassoResposta = {
  ok: boolean;
  fase?: string;
  order_id?: string;
  mensagem?: string;
  status_pedido?: string;
  agendado?: boolean;
  pulado?: boolean;
  ja_feito?: boolean;
  etiqueta_ok?: boolean;
  danfe_ok?: boolean;
};

type Props = {
  pedidos: PedidoLoteItem[];
  onClose: () => void;
  onConcluido?: () => void;
  forcarConferenciaPadrao?: boolean;
};

const FASES: { id: FaseLote; label: string; icon: typeof Download }[] = [
  { id: "processando", label: "Pedidos", icon: Printer },
  { id: "planilha", label: "Planilha", icon: Table2 },
  { id: "resultado", label: "Resultado", icon: CircleCheck },
];

const LOTE_TIMEOUT_MS = 180_000;

async function chamarPasso(
  orderId: string,
  fase: "conferir" | "baixar" | "imprimir" | "planilha",
  forcarConferencia = false
): Promise<LotePassoResposta> {
  try {
    const { data } = await api.post<LotePassoResposta>(
      "/pedidos/lote/passo",
      {
        order_id: orderId,
        fase,
        forcar_conferencia: forcarConferencia,
      },
      { timeout: LOTE_TIMEOUT_MS }
    );
    return data;
  } catch (e: any) {
    const msg =
      e?.response?.data?.detail ??
      e?.message ??
      `Erro na fase ${fase}`;
    return { ok: false, fase, order_id: orderId, mensagem: String(msg) };
  }
}

function statusInicial(pedidos: PedidoLoteItem[]): PedidoProgresso[] {
  return pedidos.map((p) => ({
    id_any: p.id_any,
    conferencia: "idle",
    etiqueta_download: "idle",
    danfe_download: "idle",
    etiqueta_impressao: "idle",
    danfe_impressao: "idle",
    planilha: "idle",
  }));
}

function StatusIcon({ status }: { status: EtapaStatus }) {
  if (status === "ok") return <CircleCheck size={13} className="shrink-0 text-green" />;
  if (status === "erro") return <CircleX size={13} className="shrink-0 text-red" />;
  if (status === "ativo")
    return <Loader2 size={13} className="shrink-0 animate-spin text-amber" />;
  if (status === "pulado")
    return <span className="inline-block size-[13px] shrink-0 rounded-full border border-border text-center text-[8px] leading-[11px] text-text-faint">—</span>;
  return (
    <span className="inline-block size-[13px] shrink-0 rounded-full border border-border-soft bg-elevated" />
  );
}

function MiniEtapa({
  label,
  icon: Icon,
  status,
}: {
  label: string;
  icon: typeof Package;
  status: EtapaStatus;
}) {
  const cor =
    status === "ok"
      ? "text-green"
      : status === "erro"
        ? "text-red"
        : status === "ativo"
          ? "text-amber"
          : "text-text-faint";
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
        status === "ativo"
          ? "border-amber/40 bg-amber/10"
          : status === "ok"
            ? "border-green/25 bg-green/5"
            : status === "erro"
              ? "border-red/30 bg-red/10"
              : "border-border-soft bg-elevated/40"
      } ${cor}`}
    >
      <StatusIcon status={status} />
      <Icon size={11} className="opacity-70" />
      <span className="truncate">{label}</span>
    </div>
  );
}

export default function ImpressaoLoteDialog({
  pedidos,
  onClose,
  onConcluido,
  forcarConferenciaPadrao = false,
}: Props) {
  const [fase, setFase] = useState<FaseLote>("confirmacao");
  const [progresso, setProgresso] = useState<PedidoProgresso[]>(() =>
    statusInicial(pedidos)
  );
  const [rodando, setRodando] = useState(false);
  const [pedidoAtivo, setPedidoAtivo] = useState<string | null>(null);
  const [forcarConferencia, setForcarConferencia] = useState(forcarConferenciaPadrao);
  const canceladoRef = useRef(false);
  const agendadosRef = useRef<Set<string>>(new Set());
  const conferidosOkRef = useRef<Set<string>>(new Set());
  const downloadsOkRef = useRef<Set<string>>(new Set());
  const forcarRef = useRef(forcarConferenciaPadrao);

  useEffect(() => {
    forcarRef.current = forcarConferencia;
  }, [forcarConferencia]);

  useEffect(() => {
    return () => {
      canceladoRef.current = true;
    };
  }, []);

  const temAgendado = useMemo(
    () => pedidos.some((p) => Boolean(p.agendado)),
    [pedidos]
  );

  const mapaPedido = useMemo(() => {
    const m = new Map<string, PedidoLoteItem>();
    for (const p of pedidos) m.set(p.id_any, p);
    return m;
  }, [pedidos]);

  const patch = (id: string, partial: Partial<PedidoProgresso>) => {
    setProgresso((prev) =>
      prev.map((p) => (p.id_any === id ? { ...p, ...partial } : p))
    );
  };

  async function passoConferir(id: string): Promise<boolean> {
    setPedidoAtivo(id);
    patch(id, { conferencia: "ativo", erro_conferencia: undefined });

    const forcar = forcarRef.current;
    const res = await chamarPasso(id, "conferir", forcar);
    if (canceladoRef.current) return false;
    const pularEtiqueta = Boolean(res.agendado) && !forcar;
    if (pularEtiqueta) agendadosRef.current.add(id);
    if (res.ok) {
      patch(id, { conferencia: "ok" });
      conferidosOkRef.current.add(id);
      if (pularEtiqueta) {
        patch(id, {
          etiqueta_download: "pulado",
          danfe_download: "pulado",
          etiqueta_impressao: "pulado",
          danfe_impressao: "pulado",
        });
      }
      return true;
    }
    patch(id, {
      conferencia: "erro",
      erro_conferencia: res.mensagem || "Falha na conferência",
      etiqueta_download: "pulado",
      danfe_download: "pulado",
      etiqueta_impressao: "pulado",
      danfe_impressao: "pulado",
    });
    conferidosOkRef.current.delete(id);
    return false;
  }

  async function passoBaixar(id: string): Promise<boolean> {
    if (agendadosRef.current.has(id)) {
      patch(id, {
        etiqueta_download: "pulado",
        danfe_download: "pulado",
      });
      return true;
    }
    if (!conferidosOkRef.current.has(id)) return false;

    setPedidoAtivo(id);
    patch(id, {
      etiqueta_download: "ativo",
      danfe_download: "ativo",
      erro_impressao: undefined,
    });

    const res = await chamarPasso(id, "baixar", forcarRef.current);
    if (canceladoRef.current) return false;
    if (res.pulado) {
      agendadosRef.current.add(id);
      downloadsOkRef.current.add(id);
      patch(id, {
        etiqueta_download: "pulado",
        danfe_download: "pulado",
        etiqueta_impressao: "pulado",
        danfe_impressao: "pulado",
      });
      return true;
    }
    if (res.ok) {
      patch(id, { etiqueta_download: "ok", danfe_download: "ok" });
      downloadsOkRef.current.add(id);
      return true;
    }
    downloadsOkRef.current.delete(id);
    patch(id, {
      etiqueta_download: res.etiqueta_ok ? "ok" : "erro",
      danfe_download: res.danfe_ok ? "ok" : "erro",
      erro_impressao: res.mensagem || "Falha no download",
      etiqueta_impressao: "pulado",
      danfe_impressao: "pulado",
    });
    return false;
  }

  async function passoImprimir(id: string): Promise<boolean> {
    if (agendadosRef.current.has(id)) {
      patch(id, {
        etiqueta_impressao: "pulado",
        danfe_impressao: "pulado",
      });
      return true;
    }
    if (!conferidosOkRef.current.has(id)) return false;
    if (!downloadsOkRef.current.has(id)) {
      patch(id, {
        etiqueta_impressao: "pulado",
        danfe_impressao: "pulado",
        erro_impressao: "Sem PDF — download falhou.",
      });
      return false;
    }

    setPedidoAtivo(id);
    patch(id, {
      etiqueta_impressao: "ativo",
      erro_impressao: undefined,
    });

    const res = await chamarPasso(id, "imprimir", forcarRef.current);
    if (canceladoRef.current) return false;
    if (res.pulado) {
      patch(id, {
        etiqueta_impressao: "pulado",
        danfe_impressao: "pulado",
      });
      return true;
    }
    if (res.ok) {
      patch(id, {
        etiqueta_impressao: "ok",
        danfe_impressao: "ok",
      });
      return true;
    }
    patch(id, {
      etiqueta_impressao: res.etiqueta_ok ? "ok" : "erro",
      danfe_impressao: res.danfe_ok ? "ok" : "erro",
      erro_impressao: res.mensagem || "Falha na impressão",
    });
    return false;
  }

  async function passoPlanilha(id: string): Promise<boolean> {
    setPedidoAtivo(id);
    patch(id, { planilha: "ativo", erro_planilha: undefined });

    const res = await chamarPasso(id, "planilha");
    if (canceladoRef.current) return false;
    if (res.ok) {
      patch(id, { planilha: "ok" });
      return true;
    }
    patch(id, {
      planilha: "erro",
      erro_planilha: res.mensagem || "Falha ao marcar planilha",
    });
    return false;
  }

  async function executarLote(ids?: string[]) {
    const lista = ids ?? pedidos.map((p) => p.id_any);
    if (lista.length === 0 || rodando) return;
    setRodando(true);
    canceladoRef.current = false;

    try {
      // Por pedido: conferir → baixar → imprimir (etiqueta sai mais rápido).
      // Planilha FEITO só no final, para todos (WD = produto em mãos).
      setFase("processando");
      for (const id of lista) {
        if (canceladoRef.current) return;
        const okConf = await passoConferir(id);
        if (canceladoRef.current) return;
        if (!okConf || !conferidosOkRef.current.has(id)) continue;
        await passoBaixar(id);
        if (canceladoRef.current) return;
        if (!conferidosOkRef.current.has(id)) continue;
        await passoImprimir(id);
      }

      setFase("planilha");
      for (const id of lista) {
        if (canceladoRef.current) return;
        await passoPlanilha(id);
      }

      if (!canceladoRef.current) {
        setFase("resultado");
        onConcluido?.();
      }
    } finally {
      setPedidoAtivo(null);
      setRodando(false);
    }
  }

  async function retryConferencia(ids: string[]) {
    if (rodando || ids.length === 0) return;
    await executarLote(ids);
  }

  async function retryImpressao(ids: string[]) {
    if (rodando || ids.length === 0) return;
    setRodando(true);
    canceladoRef.current = false;
    try {
      setFase("processando");
      for (const id of ids) {
        if (canceladoRef.current) return;
        conferidosOkRef.current.add(id);
        await passoBaixar(id);
        if (canceladoRef.current) return;
        await passoImprimir(id);
      }
      if (!canceladoRef.current) {
        setFase("resultado");
        onConcluido?.();
      }
    } finally {
      setPedidoAtivo(null);
      setRodando(false);
    }
  }

  async function retryPlanilha(ids: string[]) {
    if (rodando || ids.length === 0) return;
    setRodando(true);
    canceladoRef.current = false;
    try {
      setFase("planilha");
      for (const id of ids) {
        if (canceladoRef.current) return;
        await passoPlanilha(id);
      }
      if (!canceladoRef.current) {
        setFase("resultado");
        onConcluido?.();
      }
    } finally {
      setPedidoAtivo(null);
      setRodando(false);
    }
  }

  const idxFase = FASES.findIndex((f) => f.id === fase);
  const conferenciaOk = progresso.filter((p) => p.conferencia === "ok");
  const conferenciaErro = progresso.filter((p) => p.conferencia === "erro");
  const impressaoOk = progresso.filter(
    (p) =>
      (p.etiqueta_impressao === "ok" && p.danfe_impressao === "ok") ||
      (p.etiqueta_impressao === "pulado" &&
        p.danfe_impressao === "pulado" &&
        p.conferencia === "ok" &&
        !p.erro_impressao)
  );
  const impressaoErro = progresso.filter(
    (p) =>
      p.etiqueta_impressao === "erro" ||
      p.danfe_impressao === "erro" ||
      p.etiqueta_download === "erro" ||
      p.danfe_download === "erro" ||
      Boolean(p.erro_impressao)
  );
  const planilhaOk = progresso.filter((p) => p.planilha === "ok");
  const planilhaErro = progresso.filter((p) => p.planilha === "erro");

  const pedidosComErro = progresso.filter(
    (p) =>
      p.conferencia === "erro" ||
      p.etiqueta_download === "erro" ||
      p.danfe_download === "erro" ||
      p.etiqueta_impressao === "erro" ||
      p.danfe_impressao === "erro" ||
      p.planilha === "erro" ||
      Boolean(p.erro_conferencia || p.erro_impressao || p.erro_planilha)
  );
  const pedidosTudoOk = progresso.filter((p) => !pedidosComErro.some((e) => e.id_any === p.id_any));
  const totalErros =
    conferenciaErro.length + impressaoErro.length + planilhaErro.length;

  function falhasDoPedido(p: PedidoProgresso): { etapa: string; mensagem: string }[] {
    const falhas: { etapa: string; mensagem: string }[] = [];
    if (p.conferencia === "erro") {
      falhas.push({
        etapa: "Conferência",
        mensagem: p.erro_conferencia || "Falha na conferência",
      });
    }
    if (p.etiqueta_download === "erro" || p.danfe_download === "erro") {
      falhas.push({
        etapa: "Download",
        mensagem: p.erro_impressao || "Falha ao baixar etiqueta/DANFE",
      });
    } else if (p.etiqueta_impressao === "erro" || p.danfe_impressao === "erro" || p.erro_impressao) {
      falhas.push({
        etapa: "Impressão",
        mensagem: p.erro_impressao || "Falha na impressão",
      });
    }
    if (p.planilha === "erro") {
      falhas.push({
        etapa: "Planilha",
        mensagem: p.erro_planilha || "Falha ao marcar planilha",
      });
    }
    return falhas;
  }

  const progressoPct = useMemo(() => {
    if (fase === "confirmacao") return 0;
    if (fase === "resultado") return 100;
    const total = pedidos.length * 4;
    let feitos = 0;
    for (const p of progresso) {
      if (p.conferencia === "ok" || p.conferencia === "erro") feitos += 1;
      if (
        (p.etiqueta_download === "ok" && p.danfe_download === "ok") ||
        p.etiqueta_download === "pulado"
      )
        feitos += 1;
      if (
        (p.etiqueta_impressao === "ok" && p.danfe_impressao === "ok") ||
        p.etiqueta_impressao === "erro" ||
        p.etiqueta_impressao === "pulado"
      )
        feitos += 1;
      if (p.planilha === "ok" || p.planilha === "erro" || p.planilha === "pulado")
        feitos += 1;
    }
    return Math.min(99, Math.round((feitos / Math.max(total, 1)) * 100));
  }, [fase, pedidos.length, progresso]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 px-4 py-6">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-soft bg-surface shadow-2xl shadow-black/60">
        {/* Header */}
        <div className="shrink-0 border-b border-border-soft px-5 pb-4 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-base font-semibold">
                  Conferência e impressão em lote
                </h2>
              </div>
              <p className="mt-0.5 text-xs text-text-muted">
                {pedidos.length} pedido{pedidos.length === 1 ? "" : "s"} · cada um:
                conferir → baixar → imprimir · no fim: planilha FEITO (produto em
                mãos)
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={rodando}
              className="rounded-lg p-1.5 text-text-faint transition hover:bg-elevated hover:text-text disabled:opacity-40"
              aria-label="Fechar"
            >
              <X size={18} />
            </button>
          </div>

          {/* Stepper */}
          {fase !== "confirmacao" && (
            <div className="mt-4">
              <div className="mb-2 flex items-center gap-1">
                {FASES.map((f, i) => {
                  const Icon = f.icon;
                  const ativa = f.id === fase;
                  const feita = idxFase > i || fase === "resultado";
                  return (
                    <div key={f.id} className="flex min-w-0 flex-1 items-center gap-1">
                      <div
                        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium ${
                          ativa
                            ? "border-amber/40 bg-amber/10 text-amber"
                            : feita
                              ? "border-green/25 bg-green/5 text-green"
                              : "border-border-soft bg-elevated/30 text-text-faint"
                        }`}
                      >
                        {feita && !ativa ? (
                          <CircleCheck size={12} />
                        ) : ativa ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Icon size={12} />
                        )}
                        <span className="truncate">{f.label}</span>
                      </div>
                      {i < FASES.length - 1 && (
                        <div
                          className={`h-px w-2 shrink-0 ${
                            idxFase > i ? "bg-green/50" : "bg-border"
                          }`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
                <div
                  className="h-full rounded-full bg-amber transition-all duration-500 ease-out"
                  style={{ width: `${progressoPct}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between font-mono text-[10px] text-text-faint">
                <span>
                  {fase === "resultado"
                    ? "Concluído"
                    : pedidoAtivo
                      ? `Processando ${mapaPedido.get(pedidoAtivo)?.pedido ?? pedidoAtivo}`
                      : "…"}
                </span>
                <span>{progressoPct}%</span>
              </div>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {fase === "confirmacao" && (
            <div className="space-y-4">
              <div className="flex gap-3 rounded-xl border border-amber/25 bg-amber/5 px-3.5 py-3 text-sm text-text-muted">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber" />
                <div>
                  <p className="font-medium text-text">Processo sensível</p>
                  <p className="mt-1 text-xs leading-relaxed">
                    Para cada pedido: confere → baixa etiqueta/DANFE → imprime.
                    No final, marca FEITO na planilha para todos (produto em mãos no
                    CD, mesmo se alguma etapa falhar). Confira a impressora antes de
                    iniciar.
                  </p>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-border-soft">
                <div className="grid grid-cols-[1fr_1fr_1.2fr] gap-2 border-b border-border-soft bg-elevated/50 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-text-faint">
                  <span>Pedido</span>
                  <span>Marketplace</span>
                  <span>Cliente</span>
                </div>
                <ul className="max-h-56 divide-y divide-border-soft overflow-y-auto">
                  {pedidos.map((p) => (
                    <li
                      key={p.id_any}
                      className="grid grid-cols-[1fr_1fr_1.2fr] gap-2 px-3 py-2 text-xs"
                    >
                      <span className="font-mono text-amber">
                        {p.pedido}
                        {p.agendado && (
                          <span className="ml-1.5 rounded bg-amber/15 px-1 py-0.5 text-[9px] font-sans font-medium uppercase tracking-wide text-amber">
                            Agendado
                          </span>
                        )}
                      </span>
                      <span className="text-text-muted">{p.mkp}</span>
                      <span className="truncate text-text-muted">{p.cliente}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {temAgendado && (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-amber/30 bg-amber/5 px-3.5 py-3 text-xs text-text-muted">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0 accent-amber"
                    checked={forcarConferencia}
                    onChange={(e) => setForcarConferencia(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-text">Forçar conferência</span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-text-faint">
                      Nos agendados do lote, confere na AnyMarket e imprime etiqueta/DANFE agora
                      (como coleta hoje). Desmarcado: agendados só registram recebimento.
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          {(fase === "processando" || fase === "planilha") && (
            <ul className="space-y-2.5">
              {progresso.map((p) => {
                const meta = mapaPedido.get(p.id_any);
                const ativo = pedidoAtivo === p.id_any;
                return (
                  <li
                    key={p.id_any}
                    className={`rounded-xl border px-3 py-2.5 transition ${
                      ativo
                        ? "border-amber/35 bg-amber/5"
                        : "border-border-soft bg-elevated/25"
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-mono text-sm text-amber">
                          {meta?.pedido ?? p.id_any}
                        </span>
                        <span className="ml-2 text-xs text-text-faint">
                          {meta?.mkp} · {meta?.cliente}
                        </span>
                      </div>
                      {ativo && (
                        <span className="shrink-0 rounded-md bg-amber/15 px-1.5 py-0.5 text-[10px] font-medium text-amber">
                          Agora
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
                      <MiniEtapa
                        label="Conferir"
                        icon={ClipboardCheck}
                        status={p.conferencia}
                      />
                      <MiniEtapa
                        label="Etiqueta"
                        icon={Package}
                        status={p.etiqueta_download}
                      />
                      <MiniEtapa
                        label="DANFE"
                        icon={FileText}
                        status={p.danfe_download}
                      />
                      <MiniEtapa
                        label="Imp. etiqueta"
                        icon={Printer}
                        status={p.etiqueta_impressao}
                      />
                      <MiniEtapa
                        label="Imp. DANFE"
                        icon={Printer}
                        status={p.danfe_impressao}
                      />
                      <MiniEtapa
                        label="Planilha"
                        icon={Table2}
                        status={p.planilha}
                      />
                    </div>
                    {(p.erro_conferencia || p.erro_impressao || p.erro_planilha) && (
                      <p className="mt-2 text-[11px] text-red">
                        {p.erro_conferencia || p.erro_impressao || p.erro_planilha}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {fase === "resultado" && (
            <div className="space-y-4">
              {/* Resumo geral */}
              <div
                className={`rounded-xl border px-4 py-3 ${
                  pedidosComErro.length > 0
                    ? "border-red/35 bg-red/10"
                    : "border-green/30 bg-green/10"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {pedidosComErro.length > 0 ? (
                      <CircleX size={18} className="text-red" />
                    ) : (
                      <CircleCheck size={18} className="text-green" />
                    )}
                    <div>
                      <p
                        className={`text-sm font-semibold ${
                          pedidosComErro.length > 0 ? "text-red" : "text-green"
                        }`}
                      >
                        {pedidosComErro.length > 0
                          ? `${pedidosComErro.length} pedido(s) com problema`
                          : "Lote concluído sem erros"}
                      </p>
                      <p className="text-[11px] text-text-muted">
                        {pedidosTudoOk.length} ok · {conferenciaErro.length} conf. ·{" "}
                        {impressaoErro.length} impressão · {planilhaErro.length}{" "}
                        planilha
                      </p>
                    </div>
                  </div>
                  {pedidosComErro.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {conferenciaErro.length > 0 && (
                        <button
                          type="button"
                          disabled={rodando}
                          onClick={() =>
                            void retryConferencia(conferenciaErro.map((p) => p.id_any))
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-red/30 bg-red/15 px-2.5 py-1.5 text-[11px] font-medium text-red hover:bg-red/25 disabled:opacity-40"
                        >
                          <RotateCcw size={12} />
                          Retry conf. ({conferenciaErro.length})
                        </button>
                      )}
                      {impressaoErro.length > 0 && (
                        <button
                          type="button"
                          disabled={rodando}
                          onClick={() =>
                            void retryImpressao(impressaoErro.map((p) => p.id_any))
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-red/30 bg-red/15 px-2.5 py-1.5 text-[11px] font-medium text-red hover:bg-red/25 disabled:opacity-40"
                        >
                          <RotateCcw size={12} />
                          Retry imp. ({impressaoErro.length})
                        </button>
                      )}
                      {planilhaErro.length > 0 && (
                        <button
                          type="button"
                          disabled={rodando}
                          onClick={() =>
                            void retryPlanilha(planilhaErro.map((p) => p.id_any))
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-red/30 bg-red/15 px-2.5 py-1.5 text-[11px] font-medium text-red hover:bg-red/25 disabled:opacity-40"
                        >
                          <RotateCcw size={12} />
                          Retry planilha ({planilhaErro.length})
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Erros — destaque principal */}
              {pedidosComErro.length > 0 && (
                <section className="space-y-2">
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-red">
                    <AlertTriangle size={13} />
                    Precisa atenção ({pedidosComErro.length})
                  </h3>
                  <ul className="space-y-2">
                    {pedidosComErro.map((p) => {
                      const meta = mapaPedido.get(p.id_any);
                      const falhas = falhasDoPedido(p);
                      return (
                        <li
                          key={p.id_any}
                          className="rounded-xl border border-red/30 bg-red/5 px-3.5 py-3"
                        >
                          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-mono text-sm font-semibold text-text">
                                {meta?.pedido ?? p.id_any}
                              </p>
                              <p className="text-[11px] text-text-faint">
                                {meta?.mkp} · {meta?.cliente}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {p.conferencia === "erro" && (
                                <button
                                  type="button"
                                  disabled={rodando}
                                  onClick={() => void retryConferencia([p.id_any])}
                                  className="inline-flex items-center gap-1 rounded-md border border-red/25 bg-surface/60 px-2 py-1 text-[10px] font-medium text-red hover:bg-red/10 disabled:opacity-40"
                                >
                                  <RotateCcw size={10} /> Conf.
                                </button>
                              )}
                              {(p.etiqueta_impressao === "erro" ||
                                p.danfe_impressao === "erro" ||
                                p.etiqueta_download === "erro" ||
                                p.danfe_download === "erro" ||
                                p.erro_impressao) && (
                                <button
                                  type="button"
                                  disabled={rodando}
                                  onClick={() => void retryImpressao([p.id_any])}
                                  className="inline-flex items-center gap-1 rounded-md border border-red/25 bg-surface/60 px-2 py-1 text-[10px] font-medium text-red hover:bg-red/10 disabled:opacity-40"
                                >
                                  <RotateCcw size={10} /> Imp.
                                </button>
                              )}
                              {p.planilha === "erro" && (
                                <button
                                  type="button"
                                  disabled={rodando}
                                  onClick={() => void retryPlanilha([p.id_any])}
                                  className="inline-flex items-center gap-1 rounded-md border border-red/25 bg-surface/60 px-2 py-1 text-[10px] font-medium text-red hover:bg-red/10 disabled:opacity-40"
                                >
                                  <RotateCcw size={10} /> Planilha
                                </button>
                              )}
                            </div>
                          </div>
                          <ul className="space-y-1.5">
                            {falhas.map((f) => (
                              <li
                                key={f.etapa}
                                className="rounded-lg border border-red/20 bg-void/30 px-2.5 py-2"
                              >
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-red">
                                  {f.etapa}
                                </p>
                                <p className="mt-0.5 text-xs leading-snug text-text-muted">
                                  {f.mensagem}
                                </p>
                              </li>
                            ))}
                          </ul>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <MiniEtapa label="Conferir" icon={ClipboardCheck} status={p.conferencia} />
                            <MiniEtapa label="Etiqueta" icon={Package} status={p.etiqueta_download} />
                            <MiniEtapa label="DANFE" icon={FileText} status={p.danfe_download} />
                            <MiniEtapa label="Imp. eti." icon={Printer} status={p.etiqueta_impressao} />
                            <MiniEtapa label="Imp. DANFE" icon={Printer} status={p.danfe_impressao} />
                            <MiniEtapa label="Planilha" icon={Table2} status={p.planilha} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Sucessos — compacto */}
              {pedidosTudoOk.length > 0 && (
                <section className="rounded-xl border border-green/20 bg-green/5 p-3">
                  <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-green">
                    <CircleCheck size={13} />
                    Concluídos sem erro ({pedidosTudoOk.length})
                  </h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {pedidosTudoOk.map((p) => (
                      <li
                        key={p.id_any}
                        className="rounded-md border border-green/20 bg-surface/50 px-2 py-1 font-mono text-[11px] text-text-muted"
                        title={`${mapaPedido.get(p.id_any)?.cliente ?? ""}`}
                      >
                        {mapaPedido.get(p.id_any)?.pedido ?? p.id_any}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-text-faint">
                    <span>Conf. {conferenciaOk.length}</span>
                    <span>Imp. {impressaoOk.length}</span>
                    <span>Planilha {planilhaOk.length}</span>
                    {totalErros === 0 && (
                      <span className="text-green">Todas as etapas ok</span>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-soft px-5 py-3">
          <p className="text-[11px] text-text-faint">
            {fase === "confirmacao"
              ? "Nada será enviado até você iniciar."
              : fase === "resultado"
                ? pedidosComErro.length > 0
                  ? "Corrija os erros com Retry ou feche e trate depois."
                  : "Tudo certo — pode fechar."
                : "Não feche o app durante o lote."}
          </p>
          <div className="flex items-center gap-2">
            {fase === "confirmacao" ? (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-border-soft px-3 py-2 text-xs font-medium text-text-muted transition hover:bg-elevated hover:text-text"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void executarLote()}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber px-3.5 py-2 text-xs font-semibold text-void transition hover:brightness-110"
                >
                  <Play size={14} />
                  Iniciar lote
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onClose}
                disabled={rodando}
                className="rounded-lg border border-border-soft px-3 py-2 text-xs font-medium text-text-muted transition hover:bg-elevated hover:text-text disabled:opacity-40"
              >
                {fase === "resultado" ? "Fechar" : "Aguarde…"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
