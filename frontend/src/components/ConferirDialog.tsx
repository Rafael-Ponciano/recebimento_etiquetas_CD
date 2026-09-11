import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X,
  Loader2,
  CircleCheck,
  CircleX,
  TriangleAlert,
  Package,
  Store,
  ChevronUp,
  ChevronDown,
  Printer,
  Undo2,
  Users,
} from "lucide-react";
import { api } from "../lib/api";
import {
  fetchPedidoItens,
  pedidoItensQueryKey,
  type PedidoItemApi,
} from "../lib/pedidoItens";
import type { Pedido } from "../types/pedido";
import {
  formatarData,
  formatarReferenciasPedido,
  formatarFilial,
  FILIAL_AGUARDANDO,
  textoUtil,
  mensagemConferidoSemPlanilha,
} from "../lib/format";
import { ehLiberarHojeEraAgendado, ehStatusCancelado, ehStatusFechadoCd, ehStatusParcial, useRegras } from "../lib/regras";
import { nfPedidoPreenchida } from "../lib/filtrosPedidos";
import { classificarMkp, logoMarketplace } from "../lib/marketplace";
import StatusCdComNf from "./StatusCdComNf";

type ItemPedido = PedidoItemApi;

export type ConferirToast = {
  tipo: "success" | "warning" | "error";
  mensagem: string;
};

type Props = {
  pedido: Pedido;
  eAgendado: boolean;
  usuarioLogado: string;
  ehAdmin?: boolean;
  forcarConferenciaPadrao?: boolean;
  onClose: () => void;
  onConfirmado: (opts?: { refresh?: boolean }) => void;
  onNotificar?: (toast: ConferirToast) => void;
  onImprimir?: (modo?: "todos" | "faltantes") => void;
};

function normalizar(valor?: string) {
  return (valor ?? "").trim().toLocaleLowerCase("pt-BR");
}

function sellerEfetivo(sellerApi: string | undefined, filial: string | undefined) {
  const api = textoUtil(sellerApi);
  const local = textoUtil(filial);
  const apiOk =
    api &&
    normalizar(api) !== "padrão" &&
    normalizar(api) !== "padrao" &&
    normalizar(api) !== normalizar(FILIAL_AGUARDANDO);
  if (apiOk) return api;
  if (local) return formatarFilial(local);
  return FILIAL_AGUARDANDO;
}

function formatarCpf(valor?: string | number | null) {
  if (valor === null || valor === undefined || valor === "") return "—";

  const semDecimal = String(valor).trim().replace(/[.,]0+$/, "");
  const digitos = semDecimal.replace(/\D/g, "").slice(-11).padStart(11, "0");
  if (digitos.length !== 11) return String(valor);
  return digitos.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

function separarNomeECodigo(texto: string): { nome: string; codigo: string | null } {
  const limpo = texto.trim();
  const idx = limpo.lastIndexOf(" - ");
  if (idx <= 0 || idx + 3 >= limpo.length) {
    return { nome: limpo, codigo: null };
  }
  const nome = limpo.slice(0, idx).trim();
  const codigo = limpo.slice(idx + 3).trim();
  if (!nome || !codigo) return { nome: limpo, codigo: null };
  return { nome, codigo };
}

function AutoFitText({
  text,
  className,
  maxPx,
  minPx = 8,
  maxLines = 3,
  destacarCodigo = false,
}: {
  text: string;
  className?: string;
  maxPx: number;
  minPx?: number;
  maxLines?: number;
  destacarCodigo?: boolean;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [fontSize, setFontSize] = useState(maxPx);
  const partes = useMemo(
    () => (destacarCodigo ? separarNomeECodigo(text) : { nome: text, codigo: null as string | null }),
    [text, destacarCodigo]
  );

  const ajustar = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const lineHeight = 1.25;
    let size = maxPx;
    el.style.fontSize = `${size}px`;
    el.style.lineHeight = String(lineHeight);
    el.style.maxHeight = `${maxLines * lineHeight * size}px`;

    while (size > minPx && el.scrollHeight > el.clientHeight + 1) {
      size -= 0.5;
      el.style.fontSize = `${size}px`;
      el.style.maxHeight = `${maxLines * lineHeight * size}px`;
    }
    if (el.scrollHeight > el.clientHeight + 1) {
      el.style.maxHeight = "none";
    }
    setFontSize(size);
  }, [maxPx, minPx, maxLines, text, partes.nome, partes.codigo]);

  useLayoutEffect(() => {
    ajustar();
  }, [ajustar]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => ajustar());
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [ajustar]);

  return (
    <p
      ref={ref}
      className={`break-words whitespace-normal ${className ?? ""}`}
      style={{ fontSize, lineHeight: 1.25 }}
      title={text}
    >
      {partes.codigo ? (
        <>
          {partes.nome}
          <span className="text-text-faint"> - </span>
          <span className="rounded bg-amber/15 px-1 py-0.5 font-mono font-semibold tracking-wide text-amber">
            {partes.codigo}
          </span>
        </>
      ) : (
        text
      )}
    </p>
  );
}

function InfoChip({ label, value }: { label: string; value?: string | null }) {
  const texto = (value ?? "").trim();
  return (
    <div className="min-w-0 rounded-md border border-border-soft bg-elevated/60 px-2 py-1">
      <p className="text-[8px] uppercase tracking-[0.08em] text-text-faint">{label}</p>
      <p className="truncate text-[11px] leading-tight text-text" title={texto || undefined}>
        {texto || "—"}
      </p>
    </div>
  );
}

type EtapaUi = {
  id: string;
  label: string;
  status: "pendente" | "ativo" | "ok" | "erro";
  ms?: number;
};

const ETAPAS_PARCIAL: { id: string; label: string }[] = [
  { id: "recebimento", label: "Salvar" },
  { id: "planilha", label: "Planilha" },
  { id: "pronto", label: "Pronto" },
];

const ETAPAS_FECHAMENTO: { id: string; label: string }[] = [
  { id: "anymarket", label: "Conferir na Any" },
  { id: "download", label: "Baixar Etiquetas" },
  { id: "impressao", label: "Impressão" },
  { id: "planilha", label: "Planilha" },
  { id: "recebimento", label: "Salvar" },
  { id: "status", label: "Status" },
];

/** Agendado: sem AnyMarket / etiqueta / impressão (fica para a data da coleta). */
const ETAPAS_FECHAMENTO_AGENDADO: { id: string; label: string }[] = [
  { id: "planilha", label: "Planilha" },
  { id: "recebimento", label: "Salvar" },
  { id: "status", label: "Status" },
];

const MAPA_ETAPAS_BACKEND: Record<string, string> = {
  am_enviar_conferencia: "anymarket",
  am_conferir_itens: "anymarket",
  download_etiqueta_danfe: "download",
  impressao_etiqueta: "impressao",
  impressao_danfe: "impressao",
  sheets_check_b2c: "planilha",
  supabase_sync_sheets: "planilha",
  validar_sync_sheets: "planilha",
  atualizar_item: "planilha",
  registrar_sincronizacao: "planilha",
  supabase_recebimento: "recebimento",
  carregar_itens: "recebimento",
  checar_pedido_completo: "recebimento",
  lock_finalizacao: "recebimento",
  salvar_status: "status",
  status_recebido_parcial: "pronto",
  agendado_sem_am: "status",
};

const MAPA_TIPO_ERRO_ETAPA: Record<string, string> = {
  ERRO_SHEETS: "planilha",
  ERRO_IMPRESSAO: "impressao",
  ERRO_ANYMARKET: "anymarket",
  ERRO_DOWNLOAD: "download",
  ERRO_STATUS: "status",
  ERRO_FINALIZACAO: "recebimento",
};

function montarEtapasIniciais(fechamento: boolean, agendado: boolean): EtapaUi[] {
  const base = !fechamento
    ? ETAPAS_PARCIAL
    : agendado
      ? ETAPAS_FECHAMENTO_AGENDADO
      : ETAPAS_FECHAMENTO;
  return base.map((e, i) => ({
    ...e,
    status: i === 0 ? "ativo" : "pendente",
  }));
}

/** Etapas que só podem ir para ✓ depois da resposta real (evita Planilha ✓ → depois erro). */
const ETAPAS_AGUARDAR_API = new Set([
  "planilha",
  "anymarket",
  "download",
  "impressao",
]);

function etapasComFalha(
  erros?: { tipo?: string; etapa?: string }[]
): Set<string> {
  const ids = new Set<string>();
  for (const err of erros || []) {
    const porTipo = err.tipo ? MAPA_TIPO_ERRO_ETAPA[err.tipo] : undefined;
    const porEtapa = err.etapa ? MAPA_ETAPAS_BACKEND[err.etapa] : undefined;
    if (porTipo) ids.add(porTipo);
    if (porEtapa) ids.add(porEtapa);
  }
  return ids;
}

function aplicarTemposNasEtapas(
  etapas: EtapaUi[],
  etapasMs?: Record<string, number>,
  comErro?: boolean,
  erros?: { tipo?: string; etapa?: string }[]
): EtapaUi[] {
  const soma: Record<string, number> = {};
  for (const [chave, ms] of Object.entries(etapasMs || {})) {
    const ui = MAPA_ETAPAS_BACKEND[chave];
    if (!ui) continue;
    soma[ui] = (soma[ui] || 0) + Number(ms || 0);
  }
  const falhas = etapasComFalha(erros);
  const idxPrimeiraFalha = etapas.findIndex((e) => falhas.has(e.id));
  return etapas.map((e, i) => {
    let status: EtapaUi["status"] = "ok";
    if (falhas.has(e.id)) {
      status = "erro";
    } else if (falhas.size > 0 && idxPrimeiraFalha >= 0 && i > idxPrimeiraFalha) {
      // Depois do erro (ex.: Pronto após Planilha) não marca ✓.
      status = "pendente";
    } else if (comErro && falhas.size === 0) {
      if (e.status === "ativo") status = "erro";
      else if (e.status === "ok") status = "ok";
      else status = "pendente";
    }
    return {
      ...e,
      status,
      ms: soma[e.id] != null ? Math.round(soma[e.id]) : e.ms,
    };
  });
}

function EtapasTimeline({ etapas }: { etapas: EtapaUi[] }) {
  return (
    <div className="border-t border-border-soft px-2.5 py-2">
      <div className="flex items-start gap-0">
        {etapas.map((etapa, i) => {
          const cor =
            etapa.status === "ok"
              ? "bg-green text-void"
              : etapa.status === "ativo"
                ? "bg-amber text-void"
                : etapa.status === "erro"
                  ? "bg-red text-void"
                  : "bg-elevated text-text-faint border border-border";
          const linha =
            i < etapas.length - 1
              ? etapa.status === "ok"
                ? "bg-green/50"
                : "bg-border"
              : "";
          return (
            <div key={etapa.id} className="flex min-w-0 flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                <div className="flex flex-1 justify-center">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold ${cor}`}
                  >
                    {etapa.status === "ok" ? (
                      "✓"
                    ) : etapa.status === "erro" ? (
                      "!"
                    ) : etapa.status === "ativo" ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      i + 1
                    )}
                  </span>
                </div>
                {i < etapas.length - 1 && (
                  <div className={`h-0.5 flex-1 ${linha}`} />
                )}
              </div>
              <p
                className={`mt-1 line-clamp-2 max-w-full px-0.5 text-center text-[9px] leading-tight ${
                  etapa.status === "ativo"
                    ? "font-semibold text-amber"
                    : etapa.status === "ok"
                      ? "text-green"
                      : etapa.status === "erro"
                        ? "text-red"
                        : "text-text-faint"
                }`}
              >
                {etapa.label}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ConferirDialog({
  pedido,
  eAgendado,
  usuarioLogado,
  ehAdmin = false,
  forcarConferenciaPadrao = false,
  onClose,
  onConfirmado,
  onNotificar,
  onImprimir,
}: Props) {
  const regras = useRegras();
  const queryClient = useQueryClient();
  const orderId = String(pedido.id_any);
  const {
    data: itensApi,
    isPending: carregandoItens,
    isError: falhaItens,
    error: erroItensQuery,
    refetch: refetchItens,
  } = useQuery({
    queryKey: pedidoItensQueryKey(orderId),
    queryFn: () => fetchPedidoItens(orderId),
    // Modal precisa saldo/operador frescos (desmarcar envenena cache se stale longo).
    staleTime: 0,
    refetchOnMount: "always",
  });
  const itensMapeados = useMemo(() => {
    if (!itensApi) return null;
    return itensApi.map((i) => ({
      ...i,
      seller: sellerEfetivo(i.seller, pedido.filial_seller),
      quantidade_conferida: i.quantidade_conferida || 0,
      status: i.status || "Pendente",
    }));
  }, [itensApi, pedido.filial_seller]);
  const [itensOverride, setItensOverride] = useState<ItemPedido[] | null>(null);
  const itens = itensOverride ?? itensMapeados;
  const itensMapeadosRef = useRef(itensMapeados);
  itensMapeadosRef.current = itensMapeados;

  const setItens = useCallback(
    (updater: (prev: ItemPedido[] | null) => ItemPedido[] | null) => {
      setItensOverride((prev) => {
        const base = prev ?? itensMapeadosRef.current;
        const next = updater(base);
        if (next) {
          queryClient.setQueryData(pedidoItensQueryKey(orderId), next);
        }
        return next;
      });
    },
    [orderId, queryClient]
  );

  const [quantidades, setQuantidades] = useState<Record<string, number>>({});
  const [processando, setProcessando] = useState<string | null>(null);
  const [desmarcando, setDesmarcando] = useState(false);
  const [retomando, setRetomando] = useState(false);
  const [statusAny, setStatusAny] = useState(pedido["Status Any"] || "");
  const [timeline, setTimeline] = useState<{
    lineKey: string;
    etapas: EtapaUi[];
  } | null>(null);
  const timelineTimerRef = useRef<number | null>(null);
  /** Trava síncrona: setState é async e não impede clique duplo. */
  const conferindoRef = useRef<string | null>(null);
  const [resultado, setResultado] = useState<{
    tipo: "success" | "warning" | "error";
    mensagem: string;
  } | null>(null);
  /** Só em agendado: força AnyMarket + etiqueta como coleta hoje. */
  const [forcarConferencia, setForcarConferencia] = useState(forcarConferenciaPadrao);

  const [avisoImpressao, setAvisoImpressao] = useState(false);
  const [outrosOperadores, setOutrosOperadores] = useState<
    { operador: string; nome: string }[]
  >([]);

  const liberarHojeEraAgendado = ehLiberarHojeEraAgendado(
    pedido["Status CD"],
    statusAny,
    regras
  );
  const temSaldoConferido =
    itens?.some((i) => (i.quantidade_conferida ?? 0) > 0) ?? false;
  const todosItensFeitos =
    !!itens?.length &&
    itens.every((i) => (i.quantidade_conferida ?? 0) >= (i.quantity ?? 0));
  const statusRecebidoAntecipado =
    statusAny === regras.status_agendado || statusAny === "Recebido";
  const cancelado = ehStatusCancelado(statusAny);
  const podeLiberarRecebidoHoje =
    !cancelado &&
    statusRecebidoAntecipado &&
    todosItensFeitos &&
    nfPedidoPreenchida(pedido);
  // Só trava como consulta se o status fechou E o saldo local confirma FEITO.
  // Após desmarcar, status pode ainda dizer Conferido mas itens voltam Pendente —
  // aí precisa liberar Conferir de novo (e mostrar operador ao reconferir).
  // Cancelado: sempre somente consulta — Conferir não fica ativo.
  const soConsulta =
    cancelado ||
    (ehStatusFechadoCd(statusAny, regras) &&
      !liberarHojeEraAgendado &&
      !podeLiberarRecebidoHoje &&
      todosItensFeitos);
  const precisaFinalizar =
    !cancelado &&
    ((liberarHojeEraAgendado || podeLiberarRecebidoHoje) && todosItensFeitos
      ? true
      : !soConsulta &&
        todosItensFeitos &&
        (
          ["A conferir", "FINALIZANDO", "Em separação"].includes(statusAny) ||
          ehStatusParcial(statusAny, regras)
        ));

  const podeDesmarcar =
    ehAdmin &&
    (ehStatusFechadoCd(statusAny, regras) ||
      ehStatusParcial(statusAny, regras) ||
      statusAny === "AG AJUSTE" ||
      statusAny === "FALTANDO ITEM" ||
      (statusAny === "A conferir" && temSaldoConferido));

  const totalProdutos = itens?.length ?? 0;
  const totalUnidades = useMemo(
    () => itens?.reduce((soma, item) => soma + (item.quantity ?? 0), 0) ?? 0,
    [itens]
  );
  const unidadesConferidas = useMemo(
    () => itens?.reduce((soma, item) => soma + (item.quantidade_conferida ?? 0), 0) ?? 0,
    [itens]
  );
  const pedidoComposto = totalProdutos > 1;

  const erroCarregando = useMemo(() => {
    if (!falhaItens) return null;
    const detail = (erroItensQuery as { response?: { data?: { detail?: string } } })
      ?.response?.data?.detail;
    return detail ?? (erroItensQuery instanceof Error ? erroItensQuery.message : "Falha ao buscar itens.");
  }, [falhaItens, erroItensQuery]);

  useEffect(() => {
    setItensOverride(null);
  }, [orderId, itensApi]);

  useEffect(() => {
    setStatusAny(pedido["Status Any"] || "");
  }, [pedido.id_any, pedido["Status Any"]]);

  useEffect(() => {
    if (!itensMapeados) return;
    const initialQtds: Record<string, number> = {};
    itensMapeados.forEach((i) => {
      initialQtds[i.line_key] = (i.quantity ?? 0) - (i.quantidade_conferida ?? 0);
    });
    setQuantidades(initialQtds);
  }, [itensMapeados]);

  useEffect(() => {
    setStatusAny(pedido["Status Any"] || "");
    setAvisoImpressao(false);
  }, [pedido.id_any, pedido["Status Any"]]);

  useEffect(() => {
    return () => {
      if (timelineTimerRef.current) {
        window.clearInterval(timelineTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const fecharComEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fecharComEscape);

    return () => {
      document.body.style.overflow = overflowAnterior;
      window.removeEventListener("keydown", fecharComEscape);
    };
  }, [onClose]);

  useEffect(() => {
    if (soConsulta) {
      setOutrosOperadores([]);
      return;
    }
    let cancelado = false;
    const orderId = pedido.id_any;

    async function batimento() {
      try {
        const { data } = await api.post<{
          outros?: { operador: string; nome: string }[];
        }>(`/pedidos/${orderId}/presenca`);
        if (!cancelado) setOutrosOperadores(data.outros ?? []);
      } catch {
        if (!cancelado) setOutrosOperadores([]);
      }
    }

    void batimento();
    const id = window.setInterval(() => void batimento(), 8000);

    return () => {
      cancelado = true;
      window.clearInterval(id);
      setOutrosOperadores([]);
      void api.delete(`/pedidos/${orderId}/presenca`).catch(() => undefined);
    };
  }, [pedido.id_any, soConsulta]);

  const handleQtdChange = (id: string, val: number, max: number) => {
    if (val >= 0 && val <= max) {
      setQuantidades((prev) => ({ ...prev, [id]: val }));
    }
  };

  const desmarcarConferencia = async () => {
    if (!podeDesmarcar || desmarcando) return;
    const ok = window.confirm(
      "Desmarcar a conferência deste pedido?\n\n" +
        "• Zera o saldo conferido (libera Conferir de novo)\n" +
        "• Desmarca na AnyMarket\n" +
        "• Status local volta para A conferir"
    );
    if (!ok) return;

    setDesmarcando(true);
    try {
      const { data } = await api.post<{
        mensagem?: string;
        status_pedido?: string;
        erros?: { mensagem?: string }[];
      }>(`/pedidos/${pedido.id_any}/desmarcar-conferencia`);

      setStatusAny(data.status_pedido || "A conferir");
      setItensOverride(null);
      // Remove cache envenenado (Pendente sem operador) para o próximo open buscar fresco.
      await queryClient.removeQueries({ queryKey: pedidoItensQueryKey(orderId) });

      setResultado({
        tipo: "success",
        mensagem: data.mensagem || "Conferência desmarcada.",
      });
      onConfirmado({ refresh: true });
      window.setTimeout(() => onClose(), 800);
    } catch (e: any) {
      setResultado({
        tipo: "error",
        mensagem: e?.response?.data?.detail ?? "Erro ao desmarcar conferência.",
      });
      try {
        await queryClient.invalidateQueries({ queryKey: pedidoItensQueryKey(orderId) });
        await refetchItens();
      } catch {

      }
    } finally {
      setDesmarcando(false);
    }
  };

  const retomarFinalizacao = async () => {
    if (!precisaFinalizar || retomando) return;
    setRetomando(true);
    setResultado(null);
    try {
      const { data } = await api.post<{
        mensagem?: string;
        status_pedido?: string;
        erros?: unknown[];
      }>(`/pedidos/${pedido.id_any}/retomar-finalizacao`, {
        forcar_conferencia: podeLiberarRecebidoHoje || forcarConferencia,
      });

      if (data.status_pedido) setStatusAny(data.status_pedido);
      const erros = (data.erros ?? []) as { tipo?: string; mensagem?: string }[];
      const soImpressao =
        erros.length > 0 && erros.every((e) => e.tipo === "ERRO_IMPRESSAO");
      const comErro =
        Boolean(erros.length) || data.status_pedido === "AG AJUSTE";
      setAvisoImpressao(
        soImpressao && ehStatusFechadoCd(data.status_pedido, regras)
      );
      const mensagem = data.mensagem || "Finalização concluída.";
      setResultado({
        tipo: comErro ? "warning" : "success",
        mensagem,
      });
      onConfirmado({ refresh: true });

      if (ehStatusFechadoCd(data.status_pedido, regras)) {
        onNotificar?.({
          tipo: comErro ? (soImpressao ? "warning" : "error") : "success",
          mensagem,
        });
        onClose();
      } else if (comErro) {
        onNotificar?.({ tipo: "error", mensagem });
      }
    } catch (e: any) {
      const mensagem = e?.response?.data?.detail ?? "Erro ao concluir finalização.";
      setResultado({ tipo: "error", mensagem });
      onNotificar?.({ tipo: "error", mensagem });
    } finally {
      setRetomando(false);
    }
  };

  const confirmarItem = async (lineKey: string) => {
    if (soConsulta) return;
    // Clique duplo: state ainda não atualizou; ref bloqueia na hora.
    if (conferindoRef.current || processando) return;

    const item = itens?.find((i) => i.line_key === lineKey);
    if (!item) return;

    const qtdAConferir = quantidades[lineKey] || 0;
    if (qtdAConferir <= 0) return;

    const maxAllowed = Math.max(0, (item.quantity ?? 0) - (item.quantidade_conferida ?? 0));
    if (maxAllowed <= 0) {
      setResultado({
        tipo: "warning",
        mensagem: "Esta linha já está totalmente conferida.",
      });
      return;
    }
    const qtdEnvio = Math.min(qtdAConferir, maxAllowed);

    const novaQtd = (item.quantidade_conferida ?? 0) + qtdEnvio;
    const estaLinhaFecha = novaQtd >= (item.quantity ?? 0);
    const outrasFeitas = (itens ?? [])
      .filter((i) => i.line_key !== lineKey)
      .every((i) => (i.quantidade_conferida ?? 0) >= (i.quantity ?? 0));
    const fechamento = estaLinhaFecha && outrasFeitas;
    const agendadoEfetivo = eAgendado && !forcarConferencia;

    conferindoRef.current = lineKey;
    setProcessando(lineKey);
    // Zera na hora p/ segundo clique não reenviar a mesma qtd.
    setQuantidades((prev) => ({ ...prev, [lineKey]: 0 }));

    if (timelineTimerRef.current) {
      window.clearInterval(timelineTimerRef.current);
      timelineTimerRef.current = null;
    }
    setTimeline({ lineKey, etapas: montarEtapasIniciais(fechamento, agendadoEfetivo) });

    const t0 = performance.now();

    const enviarTempoCliente = (totalMs: number) => {
      void api
        .post("/performance/tempo-cliente", {
          order_id: String(pedido.id_any),
          total_ms: Math.round(totalMs * 10) / 10,
        })
        .catch(() => {
          /* não bloqueia a conferência */
        });
    };

    timelineTimerRef.current = window.setInterval(() => {
      setTimeline((atual) => {
        if (!atual || atual.lineKey !== lineKey) return atual;
        const idx = atual.etapas.findIndex((e) => e.status === "ativo");
        if (idx < 0 || idx >= atual.etapas.length - 1) return atual;
        // Fica girando em Planilha/Any/etc. até a API responder —
        // senão aparece ✓ falso e depois vira erro.
        if (ETAPAS_AGUARDAR_API.has(atual.etapas[idx].id)) return atual;
        const next = atual.etapas.map((e, i) => {
          if (i < idx) return { ...e, status: "ok" as const };
          if (i === idx) return { ...e, status: "ok" as const };
          if (i === idx + 1) return { ...e, status: "ativo" as const };
          return e;
        });
        return { ...atual, etapas: next };
      });
    }, fechamento && !agendadoEfetivo ? 2200 : 900);

    try {
      const { data } = await api.post<{
        ok?: boolean;
        mensagem?: string;
        erros?: { tipo?: string; mensagem?: string; etapa?: string }[];
        quantidade_conferida?: number;
        novo_status?: string;
        saldo_pendente?: number;
        pedido_concluido?: boolean;
        status_pedido?: string;
        impressao_disparada?: boolean;
        tempos?: { texto?: string; total_ms?: number; etapas_ms?: Record<string, number> };
      }>(`/pedidos/${pedido.id_any}/conferir-item`, {
        line_key: lineKey,
        quantidade: qtdEnvio,
        forcar_conferencia: forcarConferencia,
      });

      if (timelineTimerRef.current) {
        window.clearInterval(timelineTimerRef.current);
        timelineTimerRef.current = null;
      }

      const erros = data.erros ?? [];
      const soImpressao =
        erros.length > 0 && erros.every((e) => e.tipo === "ERRO_IMPRESSAO");
      const temErroSheets = erros.some((e) => e.tipo === "ERRO_SHEETS");
      const temErroConferirOuEtiqueta = erros.some((e) =>
        ["ERRO_CONFERENCIA", "ERRO_NF_PEDIDO", "ERRO_ETIQUETA", "ERRO_IMPRESSAO", "ERRO_ANYMARKET"].includes(
          String(e.tipo || "")
        )
      );
      const comErro =
        data.ok === false ||
        erros.length > 0 ||
        data.status_pedido === "AG AJUSTE";
      const conferidoComAvisoImp =
        soImpressao && ehStatusFechadoCd(data.status_pedido, regras);
      setAvisoImpressao(conferidoComAvisoImp);

      setTimeline((atual) => {
        if (!atual || atual.lineKey !== lineKey) return atual;
        return {
          ...atual,
          etapas: aplicarTemposNasEtapas(
            atual.etapas,
            data.tempos?.etapas_ms,
            comErro,
            erros
          ),
        };
      });

      const soSheets =
        erros.length > 0 && erros.every((e) => e.tipo === "ERRO_SHEETS");
      const erroSheetsMsg = erros.find((e) => e.tipo === "ERRO_SHEETS")?.mensagem;
      const mensagemBruta = data.mensagem || "Item atualizado.";
      const mensagemTemSheets =
        temErroSheets ||
        /linha não encontrada|linha nao encontrada|planilha não|planilha nao/i.test(
          mensagemBruta
        );
      let mensagem = mensagemBruta;
      if (mensagemTemSheets) {
        mensagem = mensagemConferidoSemPlanilha(erroSheetsMsg || mensagemBruta);
      } else if (data.status_pedido) {
        mensagem = `${mensagemBruta} · ${data.status_pedido}`;
      }
      setResultado({
        tipo: comErro ? (soSheets || soImpressao ? "warning" : "error") : "success",
        mensagem,
      });

      if (data.status_pedido) setStatusAny(data.status_pedido);

      const salvouOk = data.ok !== false;
      setItens(
        (prev) =>
          prev?.map((i) => {
            if (i.line_key !== lineKey) return i;
            if (data.quantidade_conferida == null && !salvouOk) return i;
            const qtdConf = data.quantidade_conferida ?? i.quantidade_conferida;
            if (!salvouOk) {
              return {
                ...i,
                quantidade_conferida: qtdConf,
                status: data.novo_status ?? i.status,
              };
            }
            const ops = [...(i.operadores ?? [])];
            if (usuarioLogado && !ops.includes(usuarioLogado)) ops.push(usuarioLogado);
            return {
              ...i,
              quantidade_conferida: qtdConf,
              status: data.novo_status,
              conferido_por: usuarioLogado,
              ultimo_operador: usuarioLogado,
              operadores: ops,
              data_conferencia: new Date().toLocaleString("pt-BR"),
              historico: [
                ...(i.historico ?? []),
                {
                  quantidade: qtdEnvio,
                  operador: usuarioLogado,
                  recebido_em: new Date().toISOString(),
                },
              ],
            };
          }) || null
      );
      setQuantidades((prev) => ({
        ...prev,
        [lineKey]:
          data.saldo_pendente ??
          Math.max(
            0,
            (item.quantity ?? 0) - (data.quantidade_conferida ?? item.quantidade_conferida ?? 0)
          ),
      }));

      onConfirmado({
        refresh: Boolean(
          data.pedido_concluido ||
            ehStatusFechadoCd(data.status_pedido, regras) ||
            data.status_pedido === "AG AJUSTE" ||
            ehStatusParcial(data.status_pedido, regras)
        ),
      });

      // Fechar modal:
      // - etiqueta impressa OK → fecha (Sheets pode falhar depois → card TopBar)
      // - agendado + Sheets OK → fecha
      // Manter aberto:
      // - agendado + erro Sheets
      // - erro ao conferir / baixar / imprimir
      const etiquetaSaiu = Boolean(data.impressao_disparada);
      let fechouPedido = false;
      if (data.pedido_concluido) {
        if (agendadoEfetivo) {
          fechouPedido =
            !temErroSheets && ehStatusFechadoCd(data.status_pedido, regras);
        } else if (etiquetaSaiu) {
          fechouPedido = true;
        } else if (temErroConferirOuEtiqueta) {
          fechouPedido = false;
        } else if (
          ehStatusFechadoCd(data.status_pedido, regras) ||
          data.status_pedido === "AG AJUSTE"
        ) {
          fechouPedido = !temErroSheets;
        }
      }

      if (fechouPedido) {
        if (timelineTimerRef.current) {
          window.clearInterval(timelineTimerRef.current);
          timelineTimerRef.current = null;
        }
        enviarTempoCliente(performance.now() - t0);
        onNotificar?.({
          tipo: comErro ? (conferidoComAvisoImp || soImpressao ? "warning" : "error") : "success",
          mensagem: comErro
            ? mensagem
            : data.mensagem ||
              (agendadoEfetivo
                ? "Pedido agendado recebido."
                : "Pedido finalizado e enviado à impressora."),
        });
        onClose();
      } else if (comErro || data.ok === false) {
        enviarTempoCliente(performance.now() - t0);
        onNotificar?.({
          tipo: soSheets || soImpressao ? "warning" : "error",
          mensagem,
        });
        window.setTimeout(() => {
          setTimeline((t) => (t?.lineKey === lineKey ? null : t));
        }, 2500);
      } else {
        enviarTempoCliente(performance.now() - t0);
        window.setTimeout(() => {
          setTimeline((t) => (t?.lineKey === lineKey ? null : t));
        }, 2500);
      }
    } catch (e: any) {
      enviarTempoCliente(performance.now() - t0);
      if (timelineTimerRef.current) {
        window.clearInterval(timelineTimerRef.current);
        timelineTimerRef.current = null;
      }
      setTimeline((atual) => {
        if (!atual || atual.lineKey !== lineKey) return atual;
        return {
          ...atual,
          etapas: aplicarTemposNasEtapas(atual.etapas, undefined, true),
        };
      });
      const mensagem = e?.response?.data?.detail ?? "Erro ao confirmar item.";
      setResultado({
        tipo: "error",
        mensagem,
      });
      onNotificar?.({ tipo: "error", mensagem });
    } finally {
      conferindoRef.current = null;
      setProcessando(null);
    }
  };

  const sellers = Array.from(new Set(itens?.map((i) => i.seller) || []));
  const logoMkp = logoMarketplace(pedido.Mkp);
  const mkpId = classificarMkp(pedido.Mkp);
  const refsPedido = formatarReferenciasPedido(pedido);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3 sm:p-4">
      <div className="isolate flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-soft bg-surface shadow-2xl shadow-black/50 sm:max-h-[86vh]">
        <div className="relative z-10 flex shrink-0 items-start justify-between gap-3 border-b border-border-soft bg-surface px-3.5 pb-2.5 pt-2.5">
          <div className="flex min-w-0 flex-col justify-center gap-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="text-sm font-semibold tracking-tight text-amber">
                {textoUtil(pedido.Pedido) || textoUtil(pedido["Pedido Any"]) || pedido.id_any}
              </h2>
              {!cancelado && (
                <StatusCdComNf
                  statusCd={pedido["Status CD"]}
                  statusNf={pedido.status_nf}
                />
              )}
            </div>
            <p className="truncate text-[11px] text-text">
              {pedido.Cliente} <span className="text-text-faint">-</span>{" "}
              <span className="font-mono text-text-muted">{formatarCpf(pedido.CPF)}</span>
            </p>
            {refsPedido && (
              <p className="font-mono text-[10px] text-text-muted">
                {refsPedido}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-start gap-2">
            {logoMkp && (
              <div className="flex h-14 w-[112px] items-center justify-center">
                <img
                  src={logoMkp.src}
                  alt={logoMkp.alt}
                  title={pedido.Mkp || logoMkp.alt}
                  className={`max-h-full max-w-full object-contain ${
                    mkpId === "magalu"
                      ? "translate-y-1"
                      : mkpId === "meli"
                        ? "scale-[1.2]"
                        : mkpId === "shopee"
                          ? "scale-[1.2]"
                          : ""
                  }`}
                />
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="relative z-20 rounded-md p-1 text-text-faint transition hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              aria-label="Fechar conferência"
              title="Fechar"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="shrink-0 border-b border-border-soft px-3.5 py-2">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <InfoChip label="STATUS" value={statusAny || pedido["Status Any"]} />
            <InfoChip label="Data pedido" value={formatarData(pedido.Data, true)} />
            <InfoChip label="Data coleta" value={formatarData(pedido["Data Coleta"])} />
            <InfoChip
              label="Progresso"
              value={
                !itens
                  ? "Carregando..."
                  : soConsulta
                    ? `${totalProdutos} item(ns)`
                    : `${unidadesConferidas}/${totalUnidades} un · ${totalProdutos} item(ns)`
              }
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2">

          {outrosOperadores.length > 0 && (
            <div className="mb-1.5 flex items-start gap-2 rounded-md border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-[11px] text-amber">
              <Users size={14} className="mt-0.5 shrink-0" />
              <span>
                <strong className="font-semibold">
                  {outrosOperadores.map((o) => o.nome).join(", ")}
                </strong>
                {outrosOperadores.length === 1
                  ? " também está conferindo este pedido"
                  : " também estão conferindo este pedido"}
                . Combinem para não bater a mesma peça.
              </span>
            </div>
          )}

          {!soConsulta && pedidoComposto && (
            <div className="mb-1.5 flex items-center gap-2 rounded-md border border-red/30 bg-red/10 px-2.5 py-1.5 text-[11px] text-red">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>
                Pedido composto por <strong className="font-semibold">{totalProdutos} produtos</strong>
                {" · "}
                {unidadesConferidas} de {totalUnidades} unidades já conferidas.
              </span>
            </div>
          )}

          {eAgendado && !soConsulta && !podeLiberarRecebidoHoje && (
            <label className="mb-1.5 flex cursor-pointer items-start gap-2 rounded-md border border-amber/30 bg-amber/5 px-2.5 py-1.5 text-[11px] text-text-muted">
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 shrink-0 accent-amber"
                checked={forcarConferencia}
                disabled={Boolean(processando)}
                onChange={(e) => setForcarConferencia(e.target.checked)}
              />
              <span className="text-[11px] text-text-muted">
                <span className="font-medium text-text">Forçar conferência</span>
                {" - "}
                Mesmo sendo agendado, confere e imprime.
              </span>
            </label>
          )}

          {erroCarregando && <p className="text-sm text-red">{erroCarregando}</p>}

          {!itens && !erroCarregando && carregandoItens && (
            <div className="flex items-center justify-center gap-2 py-5 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin" /> Carregando itens...
            </div>
          )}

          {sellers.map((seller) => (
            <div key={seller!} className="mb-2">
              <h3 className="flex items-center gap-2 rounded-t-md border border-b-0 border-border-soft bg-elevated/70 px-2.5 py-1 text-[11px] font-semibold">
                <Store size={13} className="text-amber" />
                <span className="min-w-0 truncate">Seller: {seller}</span>
                {(liberarHojeEraAgendado || podeLiberarRecebidoHoje) && !ehStatusCancelado(statusAny) && (
                  <span className="ml-auto shrink-0 font-medium text-amber">
                    Agendado já recebido no CD
                  </span>
                )}
              </h3>
              <div className="space-y-1.5 rounded-b-md border border-border-soft p-1.5">
                {itens
                  ?.filter((i) => i.seller === seller)
                  .map((item) => {
                    const isFeito =
                      item.status === regras.sheets_status_feito ||
                      item.status === "FEITO" ||
                      soConsulta ||
                      ((liberarHojeEraAgendado || podeLiberarRecebidoHoje) &&
                        (item.quantidade_conferida ?? 0) >= (item.quantity ?? 0) &&
                        (item.quantity ?? 0) > 0);
                    const isFaltando =
                      !soConsulta &&
                      (item.status === regras.sheets_status_parcial ||
                        item.status === "FALTANDO ITEM");
                    const maxAllowed = (item.quantity ?? 0) - (item.quantidade_conferida ?? 0);
                    const loading = processando !== null;
                    const loadingEstaLinha = processando === item.line_key;

                    return (
                      <div
                        key={item.line_key}
                        className={`rounded-md border ${
                          isFeito ? "border-border-soft bg-elevated/40 opacity-70" : "border-border-soft"
                        }`}
                      >
                        <div className="flex items-start gap-2 p-1.5">
                        <img
                          src={item.imageUrl || "https://dummyimage.com/96x96/1a2029/5b6472.png&text=+"}
                          alt=""
                          className="h-24 w-24 shrink-0 self-start rounded-md border border-border bg-elevated object-contain"
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                          <div className="flex min-h-24 flex-col gap-1.5">
                          {(() => {
                            const nomeAm =
                              item.description || item.product?.title || "Produto sem nome";
                            const nomeTabela =
                              (item.nome_tabela || "").trim() ||
                              (pedidoComposto ? "" : (pedido.Item || "").trim());
                            const iguais =
                              nomeTabela &&
                              nomeTabela.toLocaleLowerCase("pt-BR") ===
                                nomeAm.toLocaleLowerCase("pt-BR");
                            if (nomeTabela && !iguais) {
                              return (
                                <div className="min-w-0 space-y-1">
                                  <AutoFitText
                                    text={nomeTabela}
                                    className="font-medium leading-snug text-text"
                                    maxPx={14}
                                    minPx={9}
                                    maxLines={3}
                                    destacarCodigo
                                  />
                                  <AutoFitText
                                    text={nomeAm}
                                    className="leading-snug text-text-muted"
                                    maxPx={11}
                                    minPx={8}
                                    maxLines={3}
                                    destacarCodigo
                                  />
                                </div>
                              );
                            }
                            return (
                              <AutoFitText
                                text={nomeTabela || nomeAm}
                                className="font-medium leading-snug text-text"
                                maxPx={14}
                                minPx={9}
                                maxLines={3}
                                destacarCodigo
                              />
                            );
                          })()}

                          <div className="mt-auto flex flex-wrap items-center gap-1">
                            <span className="rounded border border-border-soft bg-elevated/80 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                              Recebido: {item.quantidade_conferida ?? 0}
                            </span>
                            {maxAllowed !== 0 && (
                              <span className="rounded border border-border-soft bg-elevated/80 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                                Pendente: {maxAllowed}
                              </span>
                            )}
                            <span
                              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                                cancelado
                                  ? "border-red/30 bg-red/10 text-red"
                                  : isFeito
                                    ? "border-green/30 bg-green/10 text-green"
                                    : isFaltando
                                      ? "border-amber/30 bg-amber/10 text-amber"
                                      : "border-border-soft bg-elevated/80 text-text-muted"
                              }`}
                            >
                              <Package size={10} />
                              {(() => {
                                if (cancelado) return "Cancelado";
                                const st = item.status || "Pendente";
                                const feito =
                                  st === regras.sheets_status_feito || st === "FEITO";
                                if (feito) {
                                  // FEITO na planilha → rótulo operacional Recebido;
                                  // no dia da coleta (consulta) permanece Conferido.
                                  if (soConsulta && !statusRecebidoAntecipado) {
                                    return regras.status_coleta_hoje;
                                  }
                                  return regras.status_agendado;
                                }
                                return st;
                              })()}
                            </span>

                            {!soConsulta && !podeLiberarRecebidoHoje && (
                              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                <div className="flex h-7 overflow-hidden rounded-md border border-border-soft bg-elevated focus-within:border-amber">
                                  <input
                                    type="number"
                                    disabled={isFeito || loading}
                                    value={quantidades[item.line_key] ?? ""}
                                    onChange={(e) =>
                                      handleQtdChange(item.line_key, parseInt(e.target.value) || 0, maxAllowed)
                                    }
                                    className="w-10 bg-transparent px-1 text-center text-xs outline-none [appearance:textfield] disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                    min="0"
                                    max={maxAllowed}
                                  />
                                  <div className="flex w-4 flex-col border-l border-border-soft">
                                    <button
                                      type="button"
                                      tabIndex={-1}
                                      disabled={isFeito || loading || (quantidades[item.line_key] ?? 0) >= maxAllowed}
                                      onClick={() =>
                                        handleQtdChange(
                                          item.line_key,
                                          (quantidades[item.line_key] ?? 0) + 1,
                                          maxAllowed
                                        )
                                      }
                                      className="flex flex-1 items-center justify-center text-text-faint transition hover:bg-white/5 hover:text-text disabled:opacity-30"
                                      aria-label="Aumentar quantidade"
                                    >
                                      <ChevronUp size={10} strokeWidth={2.5} />
                                    </button>
                                    <button
                                      type="button"
                                      tabIndex={-1}
                                      disabled={isFeito || loading || (quantidades[item.line_key] ?? 0) <= 0}
                                      onClick={() =>
                                        handleQtdChange(
                                          item.line_key,
                                          Math.max(0, (quantidades[item.line_key] ?? 0) - 1),
                                          maxAllowed
                                        )
                                      }
                                      className="flex flex-1 items-center justify-center border-t border-border-soft text-text-faint transition hover:bg-white/5 hover:text-text disabled:opacity-30"
                                      aria-label="Diminuir quantidade"
                                    >
                                      <ChevronDown size={10} strokeWidth={2.5} />
                                    </button>
                                  </div>
                                </div>
                                <button
                                  onClick={() => confirmarItem(item.line_key)}
                                  disabled={isFeito || loading || !quantidades[item.line_key]}
                                  className="flex h-7 items-center gap-1.5 rounded-md bg-amber px-2.5 text-[11px] font-medium text-void transition hover:brightness-110 disabled:opacity-50"
                                >
                                  {loadingEstaLinha ? <Loader2 size={12} className="animate-spin" /> : "Conferir"}
                                </button>
                              </div>
                            )}
                          </div>
                          </div>

                          {isFaltando && (
                            <p className="text-[11px] font-semibold text-amber">
                              {item.quantidade_conferida} de {item.quantity} conferidos
                            </p>
                          )}

                          {((item.status === regras.sheets_status_feito ||
                            item.status === "FEITO") ||
                            ((item.quantidade_conferida ?? 0) >= (item.quantity ?? 0) &&
                              (item.historico?.length ||
                                item.conferido_por ||
                                item.ultimo_operador))) && (
                            <p className="text-xs text-green">
                              {(() => {
                                const hist = [...(item.historico ?? [])].sort(
                                  (a, b) =>
                                    new Date(a.recebido_em).getTime() -
                                    new Date(b.recebido_em).getTime()
                                );
                                const ultimoEv = hist.length ? hist[hist.length - 1] : undefined;
                                const ultimo =
                                  ultimoEv?.operador ||
                                  item.ultimo_operador ||
                                  item.conferido_por ||
                                  item.operadores?.[item.operadores.length - 1];
                                const quando = ultimoEv?.recebido_em
                                  ? new Date(ultimoEv.recebido_em).toLocaleString("pt-BR", {
                                      day: "2-digit",
                                      month: "2-digit",
                                      year: "numeric",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : item.data_conferencia;
                                if (!ultimo) {
                                  return (
                                    <>
                                      {statusRecebidoAntecipado ? "Recebido" : "Finalizado"}
                                      {quando ? ` · ${quando}` : ""}
                                    </>
                                  );
                                }
                                return (
                                  <>
                                    {statusRecebidoAntecipado
                                      ? `Recebido por ${ultimo}`
                                      : `Finalizado por ${ultimo}`}
                                    {quando ? ` · ${quando}` : ""}
                                  </>
                                );
                              })()}
                            </p>
                          )}

                          {!!item.historico?.length && (item.quantity ?? 0) > 1 && (
                            <div className="space-y-1 border-t border-border-soft pt-2 text-[11px] leading-relaxed text-text-faint">
                              {[...(item.historico ?? [])]
                                .sort(
                                  (a, b) =>
                                    new Date(a.recebido_em).getTime() -
                                    new Date(b.recebido_em).getTime()
                                )
                                .map((evento, index) => (
                                <p key={`${evento.recebido_em}-${index}`}>
                                  +{evento.quantidade} por {evento.operador} em{" "}
                                  {new Date(evento.recebido_em).toLocaleString("pt-BR")}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                        </div>
                        {timeline?.lineKey === item.line_key && (
                          <EtapasTimeline etapas={timeline.etapas} />
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>

        {resultado && (
          <div
            className={`mx-3.5 mb-2 flex shrink-0 flex-col gap-1 rounded-md px-2.5 py-1.5 text-xs ${
              resultado.tipo === "success"
                ? "border border-green/30 bg-green/10 text-green"
                : resultado.tipo === "warning"
                  ? "border border-amber/30 bg-amber/10 text-amber"
                  : "border border-red/30 bg-red/10 text-red"
            }`}
          >
            <div className="flex items-center gap-2">
              {resultado.tipo === "success" ? (
                <CircleCheck size={14} />
              ) : resultado.tipo === "warning" ? (
                <TriangleAlert size={14} />
              ) : (
                <CircleX size={14} />
              )}
              {resultado.mensagem}
            </div>
          </div>
        )}

        {(
          ((soConsulta || statusAny === "AG AJUSTE" || avisoImpressao) && onImprimir) ||
          precisaFinalizar ||
          podeDesmarcar
        ) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 bg-surface px-3.5 pb-2.5 pt-1">
          {(soConsulta || statusAny === "AG AJUSTE" || avisoImpressao) && onImprimir && (
              <button
                type="button"
                onClick={() =>
                  onImprimir(
                    avisoImpressao || statusAny === "AG AJUSTE" ? "faltantes" : "todos"
                  )
                }
                disabled={desmarcando || retomando}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-amber px-3 text-xs font-medium text-void transition hover:brightness-110 disabled:opacity-50"
                title={
                  avisoImpressao || statusAny === "AG AJUSTE"
                    ? "Reimprime só o que falhou"
                    : undefined
                }
              >
                <Printer size={14} />
                {avisoImpressao || statusAny === "AG AJUSTE"
                  ? "Reimprimir faltantes"
                  : "Imprimir"}
              </button>
            )}
            {precisaFinalizar && (
              <button
                type="button"
                onClick={() => void retomarFinalizacao()}
                disabled={retomando || desmarcando}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-amber px-3 text-xs font-medium text-void transition hover:brightness-110 disabled:opacity-50"
                title={
                  podeLiberarRecebidoHoje
                    ? "Confere na AnyMarket, baixa/imprime etiqueta e grava Conferido (Sheets já marcado)"
                    : liberarHojeEraAgendado
                      ? "Confere na AnyMarket, baixa/imprime etiqueta e grava Conferido (Sheets já marcado)"
                      : "Itens já conferidos; conclui etiqueta/AnyMarket/status"
                }
              >
                {retomando ? <Loader2 size={14} className="animate-spin" /> : <CircleCheck size={14} />}
                {podeLiberarRecebidoHoje
                  ? "Liberar / Emitir Hoje"
                  : liberarHojeEraAgendado
                    ? "Conferir"
                    : "Concluir finalização"}
              </button>
            )}
            {podeDesmarcar && (
              <button
                type="button"
                onClick={() => void desmarcarConferencia()}
                disabled={desmarcando || retomando}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated/50 px-3 text-xs text-text transition hover:border-text-faint hover:bg-elevated disabled:opacity-50"
                title="Desmarca os itens na AnyMarket (admin)"
              >
                {desmarcando ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
                Desmarcar conferência
              </button>
            )}
        </div>
        )}
      </div>
    </div>
  );
}
