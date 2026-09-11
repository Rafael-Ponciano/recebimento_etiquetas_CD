import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnOrderState,
  type ColumnSizingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  ClipboardCheck,
  Printer,
  Loader2,
  CircleCheck,
  CircleX,
  PackageSearch,
  AlertTriangle,
  Truck,
  Hourglass,
  PackageMinus,
  Search,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  X,
  Droplets,
  SprayCan,
  FileWarning,
  EyeOff,
  GripVertical,
  Check,
  Columns3,
  Timer,
  CalendarCheck,
  Download,
} from "lucide-react";
import { api } from "../lib/api";
import { prefetchPedidoItens } from "../lib/pedidoItens";
import type { Pedido } from "../types/pedido";
import { formatarData, formatarFilial, normalizarParaBusca, termosBuscaUniversal } from "../lib/format";
import { exportarPedidosXlsx } from "../lib/exportarPedidosXlsx";
import ImpressaoLoteDialog, {
  type PedidoLoteItem,
} from "../components/ImpressaoLoteDialog";
import { ehStatusCancelado, statusLiberamImpressao, useRegras } from "../lib/regras";
import StatusCdComNf from "../components/StatusCdComNf";
import MultiSelect from "../components/MultiSelect";
import {
  indexarClassesProduto,
  nfPedidoPreenchida,
  passaFiltroRapido as passaFiltroRapidoLib,
  statusPermiteLoteConferir,
  type FiltroRapido,
} from "../lib/filtrosPedidos";
import DateRangeFilter from "../components/DateRangeFilter";
import NumberRangeFilter from "../components/NumberRangeFilter";
import QuickFilterCard from "../components/QuickFilterCard";
import ConferirDialog, { type ConferirToast } from "../components/ConferirDialog";
import ReimprimirDialog from "../components/ReimprimirDialog";
import { useAuthStore } from "../store/auth";
import PageSizeSelect from "../components/PageSizeSelect";
import { useUiStore } from "../store/ui";

type ConfigurableColumn = {
  id: string;
  label: string;
  defaultSize: number;
};

function moverColuna(order: string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return order;
  const from = order.indexOf(fromId);
  const to = order.indexOf(toId);
  if (from < 0 || to < 0) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return next;
}

const colHelper = createColumnHelper<Pedido>();

type LoteResultado = { sucessos: string[]; erros: { order_id: string; mensagem: string }[] };

const CONFIGURABLE_COLUMNS: ConfigurableColumn[] = [
  { id: "Pedido", label: "Pedido", defaultSize: 107 },
  { id: "Status CD", label: "Status CD", defaultSize: 120 },
  { id: "id_any", label: "ID Any", defaultSize: 100 },
  { id: "Data", label: "Data", defaultSize: 150 },
  { id: "tempo_integracao", label: "Tempo integração", defaultSize: 120 },
  { id: "Data Coleta", label: "Data da coleta", defaultSize: 120 },
  { id: "Mkp", label: "Marketplace", defaultSize: 87 },
  { id: "Cliente", label: "Cliente", defaultSize: 237 },
  { id: "Status Any", label: "STATUS", defaultSize: 125 },
  { id: "Item", label: "Item", defaultSize: 394 },
  { id: "QTND", label: "Quantidade", defaultSize: 74 },
  { id: "filial_seller", label: "Filial", defaultSize: 170 },
  { id: "ean", label: "EAN", defaultSize: 150 },
  { id: "Pedido Seller", label: "Pedido Seller", defaultSize: 140 },
  { id: "NF Venda", label: "NF Pedido", defaultSize: 120 },
  { id: "NF Seller", label: "NF Seller", defaultSize: 120 },
];

/** Layout padrão (base: preferências do rafael.silva). Usuário pode personalizar depois. */
const DEFAULT_COLUMN_ORDER = [
  "select",
  "Pedido",
  "Status CD",
  "id_any",
  "Data",
  "tempo_integracao",
  "Data Coleta",
  "Mkp",
  "Cliente",
  "Status Any",
  "Item",
  "QTND",
  "filial_seller",
  "ean",
  "Pedido Seller",
  "NF Venda",
  "NF Seller",
];
const DEFAULT_COLUMN_SIZING: ColumnSizingState = Object.fromEntries(
  CONFIGURABLE_COLUMNS.map((column) => [column.id, column.defaultSize])
);
const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
  Data: false,
  id_any: false,
  "Data Coleta": false,
};
const PAGE_SIZES = [10, 15, 25, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 100;

const FILTROS_RAPIDOS_IDS: FiltroRapido[] = [
  "atrasados",
  "coletaHoje",
  "coletaHojePendentes",
  "coletaHojePendentesSemCd",
  "agendadosRecebidosCd",
  "recebidosParcialmente",
  "cancelados",
  "soWd",
  "soH7",
  "soWdH7",
  "wdParaConferir",
  "vonixxParaConferir",
  "erroNf",
  "nfComErro",
  "erroIntegracao",
];

type TablePreferences = {
  columnOrder?: string[];
  columnVisibility?: VisibilityState;
  columnSizing?: ColumnSizingState;
  pageSize?: number;
};

function paraNumero(v: string): number | null {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

function mensagemErroApi(error: unknown, fallback: string): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data
    ?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function paddingColuna(id: string) {
  if (id === "select") return "pl-3 pr-1";
  if (id === "Status CD" || id === "Pedido") return "pl-1.5 pr-3";
  return "px-4";
}

function medirLarguraTexto(ctx: CanvasRenderingContext2D, texto: string): number {
  const t = texto.replace(/\s+/g, " ").trim();
  if (!t) return 0;
  return ctx.measureText(t).width;
}

export default function PedidosPage() {
  const queryClient = useQueryClient();
  const regras = useRegras();
  const user = useAuthStore((state) => state.user);
  const colunasAbertas = useUiStore((state) => state.columnEditMode);
  const setColunasAbertas = useUiStore((state) => state.setColumnEditMode);

  const forcarRefreshRef = useRef(false);
  const { data, isFetching, isError, error } = useQuery({
    queryKey: ["pedidos", "lista"],
    queryFn: async () => {
      const refresh = forcarRefreshRef.current;
      forcarRefreshRef.current = false;
      const { data } = await api.get<{ items: Pedido[]; total: number }>("/pedidos", {
        params: refresh ? { refresh: true } : undefined,
      });
      return data.items;
    },
    // Sem isto o React Query refaz o GET a cada foco de janela, e cada refresh
    // do backend reconsulta o Supabase. Atualizacao manual continua pelo botao.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  async function atualizarDoBanco() {
    forcarRefreshRef.current = true;
    try {
      await queryClient.fetchQuery({
        queryKey: ["pedidos", "lista"],
        queryFn: async () => {
          forcarRefreshRef.current = false;
          const { data } = await api.get<{ items: Pedido[]; total: number }>("/pedidos", {
            params: { refresh: true },
          });
          return data.items;
        },
        staleTime: 0,
      });
    } catch (e) {
      forcarRefreshRef.current = false;
      setToast({
        tipo: "error",
        mensagem: mensagemErroApi(e, "Falha ao atualizar os pedidos."),
      });
    }
  }

  const [busca, setBusca] = useState("");
  const [statusSelecionado, setStatusSelecionado] = useState<string[]>([]);
  const [filialSelecionada, setFilialSelecionada] = useState<string[]>([]);
  const [marketplaceSelecionado, setMarketplaceSelecionado] = useState<string[]>([]);
  const [statusCdSelecionado, setStatusCdSelecionado] = useState<string[]>([]);

  const [dataPedidoDe, setDataPedidoDe] = useState("");
  const [dataPedidoAte, setDataPedidoAte] = useState("");
  const [dataColetaDe, setDataColetaDe] = useState("");
  const [dataColetaAte, setDataColetaAte] = useState("");
  const [qtdMin, setQtdMin] = useState("");
  const [qtdMax, setQtdMax] = useState("");
  const [filtroRapido, setFiltroRapido] = useState<Set<FiltroRapido>>(() => new Set());

  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [sorting, setSorting] = useState<SortingState>([{ id: "Data", desc: true }]);
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(DEFAULT_COLUMN_ORDER);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(DEFAULT_COLUMN_VISIBILITY);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(DEFAULT_COLUMN_SIZING);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE });
  const [preferencesOwner, setPreferencesOwner] = useState<string | null>(null);
  const prefsHydratedRef = useRef(false);
  const skipProximoSaveRef = useRef(false);
  const tabelaRef = useRef<HTMLDivElement>(null);
  const [larguraTabela, setLarguraTabela] = useState(0);
  const arrastoScrollRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    arrastando: boolean;
  } | null>(null);

  const [dialogPedido, setDialogPedido] = useState<Pedido | null>(null);
  const [reimprimirPedido, setReimprimirPedido] = useState<Pedido | null>(null);
  const [reimprimirModo, setReimprimirModo] = useState<"todos" | "faltantes">("todos");
  const [loteEmAndamento, setLoteEmAndamento] = useState<"conferir" | "imprimir" | null>(null);
  const [loteResultado, setLoteResultado] = useState<LoteResultado | null>(null);
  const [loteModalPedidos, setLoteModalPedidos] = useState<PedidoLoteItem[] | null>(null);
  const [toast, setToast] = useState<ConferirToast | null>(null);
  const prefetchItensTimerRef = useRef<number | null>(null);
  const [arrastandoColId, setArrastandoColId] = useState<string | null>(null);
  const [arrastandoColLabel, setArrastandoColLabel] = useState("");
  const [dragPointer, setDragPointer] = useState<{ x: number; y: number } | null>(null);
  const [overColId, setOverColId] = useState<string | null>(null);
  const arrastandoColRef = useRef<string | null>(null);
  const columnOrderRef = useRef(columnOrder);
  columnOrderRef.current = columnOrder;

  const colunasOcultas = useMemo(
    () => CONFIGURABLE_COLUMNS.filter((c) => columnVisibility[c.id] === false),
    [columnVisibility]
  );

  const cancelarPrefetchItens = useCallback(() => {
    if (prefetchItensTimerRef.current != null) {
      window.clearTimeout(prefetchItensTimerRef.current);
      prefetchItensTimerRef.current = null;
    }
  }, []);

  const agendarPrefetchItens = useCallback(
    (orderId: string | number | null | undefined) => {
      cancelarPrefetchItens();
      const id = String(orderId ?? "").trim();
      if (!id) return;
      prefetchItensTimerRef.current = window.setTimeout(() => {
        prefetchItensTimerRef.current = null;
        void prefetchPedidoItens(queryClient, id);
      }, 400);
    },
    [cancelarPrefetchItens, queryClient]
  );

  useEffect(() => () => cancelarPrefetchItens(), [cancelarPrefetchItens]);

  useEffect(() => {
    if (!arrastandoColId || !colunasAbertas) return;

    document.body.style.cursor = "grabbing";
    document.body.classList.add("select-none");

    function alvoEm(x: number, y: number): string | null {
      const el = document.elementFromPoint(x, y);
      const th = el?.closest<HTMLElement>("th[data-col-drag]");
      return th?.dataset.colDrag ?? null;
    }

    function onMove(event: globalThis.PointerEvent) {
      setDragPointer({ x: event.clientX, y: event.clientY });
      const id = alvoEm(event.clientX, event.clientY);
      if (id && id !== arrastandoColRef.current) setOverColId(id);
      else setOverColId(null);
    }

    function onUp(event: globalThis.PointerEvent) {
      const fromId = arrastandoColRef.current;
      const toId = alvoEm(event.clientX, event.clientY);
      if (fromId && toId && fromId !== toId && fromId !== "select" && toId !== "select") {
        setColumnOrder(moverColuna(columnOrderRef.current, fromId, toId));
      }
      arrastandoColRef.current = null;
      setArrastandoColId(null);
      setArrastandoColLabel("");
      setDragPointer(null);
      setOverColId(null);
      document.body.style.cursor = "";
      document.body.classList.remove("select-none");
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.classList.remove("select-none");
    };
  }, [arrastandoColId, colunasAbertas]);

  function ocultarColuna(id: string) {
    if (id === "select") return;
    setColumnVisibility((prev) => ({ ...prev, [id]: false }));
  }

  function mostrarColuna(id: string) {
    setColumnVisibility((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function restaurarColunasPadrao() {
    setColumnOrder(DEFAULT_COLUMN_ORDER);
    setColumnVisibility({ ...DEFAULT_COLUMN_VISIBILITY });
    setColumnSizing(DEFAULT_COLUMN_SIZING);
  }

  const { data: preferenciasSalvas, isSuccess: preferenciasCarregadas, isFetching: preferenciasBuscando } =
    useQuery({
      queryKey: ["preferencias", "pedidos-tabela", user?.usuario],
      queryFn: async () => {
        const { data } = await api.get<{ preferencias: TablePreferences }>(
          "/preferencias/pedidos-tabela"
        );
        return data.preferencias ?? {};
      },
      enabled: Boolean(user?.usuario),
      retry: false,
      staleTime: 0,
      gcTime: 0,
    });

  // Troca de usuário: zera layout local até carregar a conta nova (não misturar PCs/sessões).
  useEffect(() => {
    prefsHydratedRef.current = false;
    skipProximoSaveRef.current = false;
    setPreferencesOwner(null);
    setColumnOrder(DEFAULT_COLUMN_ORDER);
    setColumnVisibility({ ...DEFAULT_COLUMN_VISIBILITY });
    setColumnSizing(DEFAULT_COLUMN_SIZING);
    setPagination({ pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE });
  }, [user?.usuario]);

  useEffect(() => {
    if (!user?.usuario || !preferenciasCarregadas || preferenciasBuscando) return;
    if (preferencesOwner === user.usuario && prefsHydratedRef.current) return;

    const idsValidos = new Set(DEFAULT_COLUMN_ORDER);
    const ordemSalva = preferenciasSalvas?.columnOrder?.filter((id) => idsValidos.has(id)) ?? [];
    const faltantes = DEFAULT_COLUMN_ORDER.filter((id) => !ordemSalva.includes(id));

    skipProximoSaveRef.current = true;
    prefsHydratedRef.current = true;
    setColumnOrder(ordemSalva.length ? [...ordemSalva, ...faltantes] : DEFAULT_COLUMN_ORDER);
    // Sempre parte do padrão (colunas ocultas por default); o salvo só sobrescreve.
    setColumnVisibility({
      ...DEFAULT_COLUMN_VISIBILITY,
      ...(preferenciasSalvas?.columnVisibility ?? {}),
    });
    setColumnSizing({ ...DEFAULT_COLUMN_SIZING, ...(preferenciasSalvas?.columnSizing ?? {}) });
    const tamanhoSalvo = preferenciasSalvas?.pageSize;
    const pageSize =
      tamanhoSalvo && (PAGE_SIZES as readonly number[]).includes(tamanhoSalvo)
        ? tamanhoSalvo
        : DEFAULT_PAGE_SIZE;
    setPagination({ pageIndex: 0, pageSize });
    setPreferencesOwner(user.usuario);
  }, [
    preferenciasCarregadas,
    preferenciasBuscando,
    preferenciasSalvas,
    preferencesOwner,
    user?.usuario,
  ]);

  useEffect(() => {
    if (!user?.usuario || preferencesOwner !== user.usuario || !prefsHydratedRef.current) {
      return;
    }
    if (skipProximoSaveRef.current) {
      skipProximoSaveRef.current = false;
      return;
    }
    const dono = user.usuario;
    const timer = window.setTimeout(() => {
      // Só grava se a sessão ainda for do mesmo usuário.
      if (useAuthStore.getState().user?.usuario !== dono) return;
      void api.put("/preferencias/pedidos-tabela", {
        preferencias: {
          columnOrder,
          columnVisibility,
          columnSizing,
          pageSize: pagination.pageSize,
        },
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    columnOrder,
    columnSizing,
    columnVisibility,
    pagination.pageSize,
    preferencesOwner,
    user?.usuario,
  ]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!loteResultado) return;
    const timer = window.setTimeout(() => setLoteResultado(null), 5000);
    return () => window.clearTimeout(timer);
  }, [loteResultado]);

  const pedidos = useMemo(() => data ?? [], [data]);

  const { idsPedidoSoWd, idsPedidoSoH7, idsPedidoSoWdH7, idsPedidoSoVonixx } = useMemo(
    () => indexarClassesProduto(pedidos),
    [pedidos]
  );

  const contextoFiltros = useMemo(
    () => ({
      regras,
      idsPedidoSoWd,
      idsPedidoSoH7,
      idsPedidoSoWdH7,
      idsPedidoSoVonixx,
    }),
    [regras, idsPedidoSoWd, idsPedidoSoH7, idsPedidoSoWdH7, idsPedidoSoVonixx]
  );

  const buscaAdiada = useDeferredValue(busca);
  const termosBusca = useMemo(() => termosBuscaUniversal(buscaAdiada), [buscaAdiada]);
  const textosBusca = useMemo(
    () =>
      new Map(
        pedidos.map((pedido) => [
          pedido,
          normalizarParaBusca(Object.values(pedido).join(" ")),
        ])
      ),
    [pedidos]
  );

  const opcoesStatus = useMemo(() => [...new Set(pedidos.map((p) => p["Status Any"]).filter(Boolean))].sort(), [pedidos]);
  const opcoesFilial = useMemo(
    () => [...new Set(pedidos.map((p) => formatarFilial(p.filial_seller)))].sort(),
    [pedidos]
  );
  const opcoesMarketplace = useMemo(
    () =>
      [...new Set(pedidos.map((p) => String(p.Mkp ?? "").trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "pt-BR")
      ),
    [pedidos]
  );
  const opcoesStatusCd = useMemo(() => [...new Set(pedidos.map((p) => p["Status CD"]).filter(Boolean))].sort(), [pedidos]);

  const passaFiltroRapido = useCallback(
    (pedido: Pedido, f: FiltroRapido) => passaFiltroRapidoLib(pedido, f, contextoFiltros),
    [contextoFiltros]
  );

  function dataNoPeriodo(valor: string | null | undefined, de: string, ate: string) {
    if (!de && !ate) return true;
    const dia = valor?.slice(0, 10) ?? "";
    if (!dia) return false;
    if (de && dia < de) return false;
    if (ate && dia > ate) return false;
    return true;
  }

  // Filtros avançados (data, busca, status…) — base comum da tabela e dos cards.
  const pedidosBaseAvancado = useMemo(() => {
    const min = qtdMin.trim() ? Number(qtdMin) : null;
    const max = qtdMax.trim() ? Number(qtdMax) : null;

    return pedidos.filter((pedido) => {
      if (pedido["Status Any"] === "Entregue") return false;
      if (!dataNoPeriodo(pedido.Data, dataPedidoDe, dataPedidoAte)) return false;
      if (!dataNoPeriodo(pedido["Data Coleta"], dataColetaDe, dataColetaAte)) return false;
      if (termosBusca.length && !termosBusca.every((termo) => textosBusca.get(pedido)?.includes(termo))) return false;
      if (statusSelecionado.length && !statusSelecionado.includes(pedido["Status Any"])) return false;
      if (filialSelecionada.length && !filialSelecionada.includes(formatarFilial(pedido.filial_seller))) return false;
      if (
        marketplaceSelecionado.length &&
        !marketplaceSelecionado.includes(String(pedido.Mkp ?? "").trim())
      ) {
        return false;
      }
      if (statusCdSelecionado.length && !statusCdSelecionado.includes(pedido["Status CD"])) return false;

      if (min !== null || max !== null) {
        const quantidade = paraNumero(pedido.QTND);
        if (quantidade === null) return false;
        if (min !== null && quantidade < min) return false;
        if (max !== null && quantidade > max) return false;
      }

      return true;
    });
  }, [
    pedidos,
    termosBusca,
    textosBusca,
    statusSelecionado,
    filialSelecionada,
    marketplaceSelecionado,
    statusCdSelecionado,
    dataPedidoDe,
    dataPedidoAte,
    dataColetaDe,
    dataColetaAte,
    qtdMin,
    qtdMax,
  ]);

  // Pré-computa quem casa com cada filtro (1× por mudança da base, não a cada clique).
  const membershipFiltrosRapidos = useMemo(() => {
    const mapa = Object.fromEntries(
      FILTROS_RAPIDOS_IDS.map((id) => [id, new Set<string>()])
    ) as Record<FiltroRapido, Set<string>>;
    for (const pedido of pedidosBaseAvancado) {
      const chave = String(pedido.id_any ?? "").trim();
      if (!chave) continue;
      for (const id of FILTROS_RAPIDOS_IDS) {
        if (passaFiltroRapido(pedido, id)) mapa[id].add(chave);
      }
    }
    return mapa;
  }, [pedidosBaseAvancado, passaFiltroRapido]);

  const contagensRapidas = useMemo(() => {
    const intersecao = (sets: Set<string>[]) => {
      if (sets.length === 0) return 0;
      let menor = sets[0]!;
      for (let i = 1; i < sets.length; i++) {
        if (sets[i]!.size < menor.size) menor = sets[i]!;
      }
      let n = 0;
      for (const chave of menor) {
        let ok = true;
        for (const s of sets) {
          if (s === menor) continue;
          if (!s.has(chave)) {
            ok = false;
            break;
          }
        }
        if (ok) n += 1;
      }
      return n;
    };

    const out = {} as Record<FiltroRapido, number>;
    for (const id of FILTROS_RAPIDOS_IDS) {
      const sets: Set<string>[] = [membershipFiltrosRapidos[id]];
      for (const ativo of filtroRapido) {
        if (ativo === id) continue;
        sets.push(membershipFiltrosRapidos[ativo]);
      }
      out[id] = intersecao(sets);
    }
    return {
      atrasados: out.atrasados,
      coletaHoje: out.coletaHoje,
      coletaHojePendentes: out.coletaHojePendentes,
      coletaHojePendentesSemCd: out.coletaHojePendentesSemCd,
      agendadosRecebidosCd: out.agendadosRecebidosCd,
      recebidosParcialmente: out.recebidosParcialmente,
      cancelados: out.cancelados,
      soWd: out.soWd,
      soH7: out.soH7,
      soWdH7: out.soWdH7,
      wdParaConferir: out.wdParaConferir,
      vonixxParaConferir: out.vonixxParaConferir,
      erroNf: out.erroNf,
      nfComErro: out.nfComErro,
      erroIntegracao: out.erroIntegracao,
    };
  }, [membershipFiltrosRapidos, filtroRapido]);

  function alternarFiltroRapido(f: FiltroRapido) {
    const ligando = !filtroRapido.has(f);
    const proximoSize = ligando ? filtroRapido.size + 1 : filtroRapido.size - 1;
    if (proximoSize > 0) setStatusCdSelecionado([]);
    setFiltroRapido((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(f)) proximo.delete(f);
      else proximo.add(f);
      return proximo;
    });
  }

  const filtrosAtivos =
    (busca.trim() ? 1 : 0) +
    (dataPedidoDe || dataPedidoAte ? 1 : 0) +
    (dataColetaDe || dataColetaAte ? 1 : 0) +
    (qtdMin || qtdMax ? 1 : 0) +
    statusSelecionado.length +
    filialSelecionada.length +
    marketplaceSelecionado.length +
    statusCdSelecionado.length +
    filtroRapido.size;

  function limparFiltros() {
    setBusca("");
    setDataPedidoDe("");
    setDataPedidoAte("");
    setDataColetaDe("");
    setDataColetaAte("");
    setQtdMin("");
    setQtdMax("");
    setStatusSelecionado([]);
    setFilialSelecionada([]);
    setMarketplaceSelecionado([]);
    setStatusCdSelecionado([]);
    setFiltroRapido(new Set());
  }

  const dataFiltrada = useMemo(() => {
    if (filtroRapido.size === 0) return pedidosBaseAvancado;
    const ativos = [...filtroRapido];
    return pedidosBaseAvancado.filter((pedido) => {
      const chave = String(pedido.id_any ?? "").trim();
      if (!chave) return false;
      for (const f of ativos) {
        if (!membershipFiltrosRapidos[f].has(chave)) return false;
      }
      return true;
    });
  }, [pedidosBaseAvancado, filtroRapido, membershipFiltrosRapidos]);

  useEffect(() => {
    setRowSelection({});
    setPagination((atual) =>
      atual.pageIndex === 0 ? atual : { ...atual, pageIndex: 0 }
    );
  }, [
    buscaAdiada,
    statusSelecionado,
    filialSelecionada,
    marketplaceSelecionado,
    statusCdSelecionado,
    dataPedidoDe,
    dataPedidoAte,
    dataColetaDe,
    dataColetaAte,
    qtdMin,
    qtdMax,
    filtroRapido,
  ]);

  const columns = useMemo(
    () => [
      colHelper.display({
        id: "select",
        header: ({ table }) => (
          <input
            type="checkbox"
            checked={table.getIsAllPageRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected();
            }}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            onClick={(e) => e.stopPropagation()}
          />
        ),
        size: 40,
        enableResizing: false,
      }),
      colHelper.accessor("Status CD", {
        header: "Status CD",
        cell: (info) => (
          <StatusCdComNf
            statusCd={info.getValue()}
            statusNf={info.row.original.status_nf}
          />
        ),
        size: 150,
      }),
      colHelper.accessor("Pedido", { header: "Pedido", size: 140 }),
      colHelper.accessor("id_any", {
        header: "ID Any",
        cell: (info) => (
          <span className="font-mono tabular-nums">{info.getValue() || "—"}</span>
        ),
        size: 120,
      }),
      colHelper.accessor("Pedido Seller", {
        header: "Pedido Seller",
        cell: (info) => info.getValue() || "—",
        size: 140,
      }),
      colHelper.accessor("NF Venda", {
        header: "NF Pedido",
        cell: (info) => info.getValue() || "—",
        size: 120,
      }),
      colHelper.accessor("NF Seller", {
        header: "NF Seller",
        cell: (info) => info.getValue() || "—",
        size: 120,
      }),
      colHelper.accessor("Data", {
        header: "Data",
        cell: (info) => formatarData(info.getValue(), true),
        size: 145,
      }),
      colHelper.accessor("tempo_integracao", {
        header: "Tempo integração",
        cell: (info) => (
          <span className="font-mono tabular-nums">
            {info.getValue() || "—"}
          </span>
        ),
        size: 120,
      }),
      colHelper.accessor("Data Coleta", {
        header: "Data Coleta",
        cell: (info) => formatarData(info.getValue()),
        size: 130,
      }),
      colHelper.accessor("Cliente", { header: "Cliente", size: 190 }),
      colHelper.accessor("Status Any", { header: "STATUS", size: 145 }),
      colHelper.accessor("Item", {
        header: "Item",
        cell: (info) => (
          <span className="block whitespace-normal break-words leading-snug">
            {info.getValue()}
          </span>
        ),
        size: 260,
      }),
      colHelper.accessor("QTND", { header: "Qtd", size: 80 }),
      colHelper.accessor("filial_seller", {
        header: "Filial",
        cell: (info) => formatarFilial(info.getValue()),
        size: 150,
      }),
      colHelper.accessor("Mkp", { header: "Mkp", size: 110 }),
      colHelper.accessor("ean", {
        header: "EAN",
        cell: (info) => info.getValue() || "—",
        size: 145,
        minSize: 100,
      }),
    ],
    []
  );

  const table = useReactTable({
    data: dataFiltrada,
    columns,
    state: {
      sorting,
      rowSelection,
      columnOrder,
      columnVisibility,
      columnSizing,
      pagination,
    },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    onColumnOrderChange: setColumnOrder,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) =>
      [row.id_any, row.ean, row.filial_seller, row["Pedido Seller"], row.Item].join("|"),
    enableRowSelection: true,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    autoResetPageIndex: false,
  });

  function autoAjustarLarguraColuna(columnId: string) {
    const root = tabelaRef.current;
    if (!root) return;
    const th = root.querySelector(
      `th[data-col-id="${CSS.escape(columnId)}"]`
    ) as HTMLElement | null;
    if (!th) return;

    const amostra =
      (root.querySelector(
        `td[data-col-id="${CSS.escape(columnId)}"]`
      ) as HTMLElement | null) || th;
    const estilo = window.getComputedStyle(amostra);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.font = `${estilo.fontWeight} ${estilo.fontSize} ${estilo.fontFamily}`;

    const padL = Number.parseFloat(estilo.paddingLeft) || 0;
    const padR = Number.parseFloat(estilo.paddingRight) || 0;
    let maxPx = medirLarguraTexto(ctx, th.innerText);
    root.querySelectorAll(`td[data-col-id="${CSS.escape(columnId)}"]`).forEach((node) => {
      maxPx = Math.max(maxPx, medirLarguraTexto(ctx, (node as HTMLElement).innerText));
    });

    const col = table.getColumn(columnId);
    const minSize = col?.columnDef.minSize ?? 48;
    const maxSize = col?.columnDef.maxSize ?? 520;
    const next = Math.min(
      maxSize,
      Math.max(minSize, Math.ceil(maxPx + padL + padR + 12))
    );
    setColumnSizing((atual) => ({ ...atual, [columnId]: next }));
  }

  useEffect(() => {
    const el = tabelaRef.current;
    if (!el) return;
    const atualizar = () => setLarguraTabela(el.clientWidth);
    atualizar();
    const ro = new ResizeObserver(atualizar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function iniciarArrastoScroll(e: PointerEvent<HTMLDivElement>) {

    const panComMeio = e.button === 1;
    const panComAlt = e.button === 0 && e.altKey;
    if (!panComMeio && !panComAlt) return;
    const alvo = e.target as HTMLElement;
    if (alvo.closest("input, button, a, label, [data-col-resize]")) return;
    const el = tabelaRef.current;
    if (!el) return;
    e.preventDefault();
    arrastoScrollRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      arrastando: false,
    };
  }

  function moverArrastoScroll(e: PointerEvent<HTMLDivElement>) {
    const estado = arrastoScrollRef.current;
    const el = tabelaRef.current;
    if (!estado || !el || estado.pointerId !== e.pointerId) return;
    const dx = e.clientX - estado.startX;
    const dy = e.clientY - estado.startY;
    if (!estado.arrastando) {
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      estado.arrastando = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add("cursor-grabbing", "select-none");
    }
    e.preventDefault();
    el.scrollLeft = estado.scrollLeft - dx;
    el.scrollTop = estado.scrollTop - dy;
  }

  function encerrarArrastoScroll(e: PointerEvent<HTMLDivElement>) {
    const estado = arrastoScrollRef.current;
    const el = tabelaRef.current;
    if (!estado || estado.pointerId !== e.pointerId) return;
    if (estado.arrastando && el) {
      el.releasePointerCapture(e.pointerId);
      el.classList.remove("cursor-grabbing", "select-none");
    }
    arrastoScrollRef.current = null;
  }

  const { idUltimaColuna, precisaScrollHorizontal, larguraMinimaTabela } = useMemo(() => {
    const visiveis = table.getVisibleLeafColumns();
    const ultima = visiveis[visiveis.length - 1];
    if (!ultima) {
      return {
        idUltimaColuna: null as string | null,
        precisaScrollHorizontal: false,
        larguraMinimaTabela: 0,
      };
    }
    const outras = visiveis.slice(0, -1).reduce((soma, col) => soma + col.getSize(), 0);
    const minima = ultima.columnDef.minSize ?? 100;
    const preferida = Math.max(minima, ultima.getSize());
    const minimaTabela = outras + preferida;
    const precisaScroll = larguraTabela > 0 && minimaTabela > larguraTabela;
    return {
      idUltimaColuna: ultima.id,
      precisaScrollHorizontal: precisaScroll,
      larguraMinimaTabela: minimaTabela,
    };
  }, [table, columnSizing, columnVisibility, columnOrder, larguraTabela]);

  const selecionados = table.getSelectedRowModel().rows.map((r) => r.original);
  const pedidosUnicosSelecionados = useMemo(() => {
    const mapa = new Map<string, Pedido>();
    for (const p of selecionados) {
      if (!mapa.has(p.id_any)) mapa.set(p.id_any, p);
    }
    return [...mapa.values()];
  }, [selecionados]);

  const filtroLoteSelecionado: FiltroRapido | null = filtroRapido.has("wdParaConferir")
    ? "wdParaConferir"
    : filtroRapido.has("vonixxParaConferir")
      ? "vonixxParaConferir"
      : filtroRapido.has("soWd")
        ? "soWd"
        : filtroRapido.has("soH7")
          ? "soH7"
          : filtroRapido.has("soWdH7")
            ? "soWdH7"
            : null;

  const filtroLoteAtivo = filtroLoteSelecionado !== null;

  const conferenciaLoteLiberada =
    filtroLoteAtivo &&
    pedidosUnicosSelecionados.length >= 2 &&
    pedidosUnicosSelecionados.every((p) => statusPermiteLoteConferir(p["Status Any"])) &&
    pedidosUnicosSelecionados.every((p) => {
      if (!filtroLoteSelecionado) return false;
      return passaFiltroRapido(p, filtroLoteSelecionado);
    });

  const conferenciaLiberada =
    (pedidosUnicosSelecionados.length === 1 &&
      !ehStatusCancelado(pedidosUnicosSelecionados[0]?.["Status Any"])) ||
    conferenciaLoteLiberada;

  const impressaoLiberada =
    selecionados.length > 0 &&
    selecionados.every((p) => statusLiberamImpressao(regras).includes(p["Status Any"]));

  async function handleConferir() {
    if (pedidosUnicosSelecionados.length === 1) {
      setDialogPedido(pedidosUnicosSelecionados[0]);
      return;
    }
    if (!conferenciaLoteLiberada) return;

    setLoteModalPedidos(
      pedidosUnicosSelecionados.map((p) => {
        const pm = String(p.Pedido ?? "").trim();
        const anyRef = String(p["Pedido Any"] ?? "").trim();
        return {
          id_any: p.id_any,
          // Preferência: PM- (coluna Pedido); senão Any / id.
          pedido: pm || anyRef || String(p.id_any),
          cliente: String(p.Cliente || "—"),
          mkp: String(p.Mkp || "—"),
          agendado: String(p["Status CD"] ?? "")
            .trim()
            .startsWith("Agendado"),
        };
      })
    );
  }

  async function handleImprimir() {
    if (selecionados.length === 0) return;
    if (selecionados.length === 1) {
      setReimprimirPedido(selecionados[0]);
      return;
    }
    setLoteEmAndamento("imprimir");
    setLoteResultado(null);
    try {
      const { data } = await api.post<LoteResultado>("/pedidos/lote/imprimir", {
        order_ids: selecionados.map((p) => p.id_any),
      });
      setLoteResultado(data);
      setRowSelection({});
    } catch (e) {
      setToast({
        tipo: "error",
        mensagem: mensagemErroApi(e, "Falha ao imprimir os pedidos selecionados."),
      });
    } finally {
      setLoteEmAndamento(null);
    }
  }

  function handleExportar() {
    const colunas = table
      .getVisibleLeafColumns()
      .filter((coluna) => coluna.id !== "select")
      .map((coluna) => ({
        id: coluna.id,
        label:
          CONFIGURABLE_COLUMNS.find((c) => c.id === coluna.id)?.label ??
          (typeof coluna.columnDef.header === "string"
            ? coluna.columnDef.header
            : coluna.id),
      }));
    const linhas = table.getPrePaginationRowModel().rows.map((row) => row.original);
    if (linhas.length === 0) {
      setToast({ tipo: "error", mensagem: "Nada para exportar com os filtros atuais." });
      return;
    }
    void (async () => {
      const resultado = await exportarPedidosXlsx(linhas, colunas, "pedidos");
      if (resultado.ok) {
        setToast({
          tipo: "success",
          mensagem: `Exportados ${resultado.registros} registro(s) em XLSX.`,
        });
        return;
      }
      if ("cancelado" in resultado && resultado.cancelado) return;
      setToast({
        tipo: "error",
        mensagem: "erro" in resultado ? resultado.erro : "Falha ao gerar o arquivo XLSX.",
      });
    })();
  }

  const eAgendadoDialog = useMemo(() => {
    if (!dialogPedido) return false;

    return (dialogPedido["Status CD"] ?? "").trim().startsWith("Agendado");
  }, [dialogPedido]);

  return (
    <div className="flex h-full min-h-0 flex-col px-6 pt-3 pb-2">
      <section className="relative z-40 mb-3 flex shrink-0 flex-wrap items-end gap-2 rounded-xl border border-border-soft bg-surface/70 p-2">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
          <DateRangeFilter
            label="Data do pedido"
            de={dataPedidoDe}
            ate={dataPedidoAte}
            onChangeDe={setDataPedidoDe}
            onChangeAte={setDataPedidoAte}
          />
          <DateRangeFilter
            label="Data da coleta"
            de={dataColetaDe}
            ate={dataColetaAte}
            onChangeDe={setDataColetaDe}
            onChangeAte={setDataColetaAte}
          />
          <NumberRangeFilter
            label="Quantidade"
            min={qtdMin}
            max={qtdMax}
            onChangeMin={setQtdMin}
            onChangeMax={setQtdMax}
          />
          <MultiSelect
            label="STATUS"
            options={opcoesStatus}
            selected={statusSelecionado}
            onChange={setStatusSelecionado}
          />
          <MultiSelect
            label="Filial"
            options={opcoesFilial}
            selected={filialSelecionada}
            onChange={setFilialSelecionada}
          />
          <MultiSelect
            label="Marketplace"
            options={opcoesMarketplace}
            selected={marketplaceSelecionado}
            onChange={setMarketplaceSelecionado}
          />
          <MultiSelect
            label="Status CD"
            options={opcoesStatusCd}
            selected={statusCdSelecionado}
            onChange={setStatusCdSelecionado}
          />
        </div>
        <button
          type="button"
          onClick={limparFiltros}
          disabled={filtrosAtivos === 0}
          title={filtrosAtivos > 0 ? `${filtrosAtivos} filtro(s) ativo(s)` : undefined}
          className="flex h-8 w-[6.25rem] shrink-0 flex-col items-center justify-center rounded-lg border border-red/35 bg-red/10 px-1 text-center text-[10px] font-medium leading-tight text-red transition hover:border-red/55 hover:bg-red/15 disabled:opacity-30"
        >
          <span>Limpar</span>
          <span>Filtros</span>
        </button>
      </section>

      <section className="mb-3 flex min-w-0 shrink-0 items-center gap-2 rounded-xl border border-border-soft bg-surface/70 p-2">
        <div className="group flex h-9 min-w-[7rem] flex-1 items-center gap-2 rounded-lg border border-border bg-elevated/80 px-2.5 focus-within:border-amber/70">
          <Search size={14} className="shrink-0 text-text-faint group-focus-within:text-amber" />
          <input
            value={busca}
            onChange={(event) => setBusca(event.target.value)}
            placeholder="Buscar..."
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-faint"
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-stretch gap-1">
          <div className="flex flex-col gap-0.5">
            <QuickFilterCard
              label="Pendentes Hoje"
              count={contagensRapidas.coletaHojePendentes}
              icon={<Hourglass size={13} />}
              cor="amber"
              hint="Coleta hoje e Status Any ainda aberto (não Conferido/Recebido/FEITO)"
              active={filtroRapido.has("coletaHojePendentes")}
              onClick={() => alternarFiltroRapido("coletaHojePendentes")}
              className="h-7 w-full justify-between"
            />
            <QuickFilterCard
              label="Pendentes Hoje S/ CD"
              count={contagensRapidas.coletaHojePendentesSemCd}
              icon={<Hourglass size={13} />}
              cor="amber"
              hint="Pendentes hoje excluindo filial Peça Ai - CD SP"
              active={filtroRapido.has("coletaHojePendentesSemCd")}
              onClick={() => alternarFiltroRapido("coletaHojePendentesSemCd")}
              className="h-7 w-full justify-between"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <QuickFilterCard
              label="Agendados Recebidos no CD"
              count={contagensRapidas.agendadosRecebidosCd}
              icon={<CalendarCheck size={13} />}
              cor="amber"
              hint="Status CD Agendado e Status Any Recebido/FEITO"
              active={filtroRapido.has("agendadosRecebidosCd")}
              onClick={() => alternarFiltroRapido("agendadosRecebidosCd")}
              className="h-7 w-full justify-between"
            />
            <QuickFilterCard
              label="Recebidos parcial"
              count={contagensRapidas.recebidosParcialmente}
              icon={<PackageMinus size={13} />}
              cor="amber"
              hint="Status Any = Recebido Parcial"
              active={filtroRapido.has("recebidosParcialmente")}
              onClick={() => alternarFiltroRapido("recebidosParcialmente")}
              className="h-7 w-full justify-between"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <QuickFilterCard
              label="Coleta Hoje"
              count={contagensRapidas.coletaHoje}
              icon={<Truck size={13} />}
              cor="green"
              hint="Status CD Coleta Hoje: coleta útil = hoje"
              active={filtroRapido.has("coletaHoje")}
              onClick={() => alternarFiltroRapido("coletaHoje")}
              className="h-7 w-full justify-between"
            />
            <QuickFilterCard
              label="WD para Conferir"
              count={contagensRapidas.wdParaConferir}
              icon={<ClipboardCheck size={13} />}
              cor="green"
              hint="Só WD + com NF + Em separação/A conferir + coleta ≤ hoje"
              active={filtroRapido.has("wdParaConferir")}
              onClick={() => alternarFiltroRapido("wdParaConferir")}
              className="h-7 w-full justify-between"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <QuickFilterCard
              label="Vonixx para Conferir"
              count={contagensRapidas.vonixxParaConferir}
              icon={<SprayCan size={13} />}
              cor="cyan"
              hint="Só Vonixx + com NF + Em separação/A conferir + coleta ≤ hoje"
              active={filtroRapido.has("vonixxParaConferir")}
              onClick={() => alternarFiltroRapido("vonixxParaConferir")}
              className="h-7 w-full justify-between"
            />
            <QuickFilterCard
              label="Só H7"
              count={contagensRapidas.soH7}
              icon={<Droplets size={13} />}
              cor="cyan"
              hint="Pedido só com itens H7 · sem cancelados/enviados"
              active={filtroRapido.has("soH7")}
              onClick={() => alternarFiltroRapido("soH7")}
              className="h-7 w-full justify-between"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <QuickFilterCard
              label="Sem NF"
              count={contagensRapidas.erroNf}
              icon={<FileWarning size={13} />}
              cor="red"
              hint="Sem NF Pedido, coleta ≤ hoje e não cancelado"
              active={filtroRapido.has("erroNf")}
              onClick={() => alternarFiltroRapido("erroNf")}
              className="h-7 w-full justify-between"
            />
            <QuickFilterCard
              label="Erro NF"
              count={contagensRapidas.nfComErro}
              icon={<FileWarning size={13} />}
              cor="red"
              hint="status_nf = FAILED · sem cancelados/enviados"
              active={filtroRapido.has("nfComErro")}
              onClick={() => alternarFiltroRapido("nfComErro")}
              className="h-7 w-full justify-between"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <QuickFilterCard
              label="Atrasados"
              count={contagensRapidas.atrasados}
              icon={<AlertTriangle size={13} />}
              cor="red"
              hint="Status CD Atrasado: em aberto com coleta útil antes de hoje"
              active={filtroRapido.has("atrasados")}
              onClick={() => alternarFiltroRapido("atrasados")}
              className="h-7 w-full justify-between"
            />
            <QuickFilterCard
              label="Erro Integração"
              count={contagensRapidas.erroIntegracao}
              icon={<Timer size={13} />}
              cor="red"
              hint="Pedido ainda vazio e tempo de integração > 20 min"
              active={filtroRapido.has("erroIntegracao")}
              onClick={() => alternarFiltroRapido("erroIntegracao")}
              className="h-7 w-full justify-between"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5 pl-2 self-center">
          <button
            type="button"
            onClick={() => void atualizarDoBanco()}
            disabled={isFetching}
            className="flex h-7 items-center justify-center gap-1 rounded-md border border-border bg-elevated/50 px-2 text-xs text-text-muted transition hover:border-text-faint hover:text-text disabled:opacity-50"
          >
            <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            Atualizar
          </button>
          <button
            onClick={handleImprimir}
            disabled={!impressaoLiberada || loteEmAndamento !== null || loteModalPedidos !== null}
            title={
              !impressaoLiberada && selecionados.length > 0
                ? "Impressão liberada para Conferido, Recebido, FEITO (legado) ou AG AJUSTE."
                : undefined
            }
            className="flex h-7 items-center justify-center gap-1 rounded-md border border-border bg-elevated/50 px-2.5 text-xs text-text transition hover:border-text-faint hover:bg-elevated disabled:opacity-40"
          >
            {loteEmAndamento === "imprimir" ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />}
            Imprimir {selecionados.length > 1 ? `(${selecionados.length})` : ""}
          </button>
          <button
            type="button"
            onClick={handleExportar}
            disabled={dataFiltrada.length === 0}
            title="Exporta a tabela com os filtros ativos em XLSX"
            className="flex h-7 items-center justify-center gap-1 rounded-md border border-border bg-elevated/50 px-2 text-xs text-text-muted transition hover:border-text-faint hover:text-text disabled:opacity-40"
          >
            <Download size={12} />
            Exportar
          </button>
          <button
            onClick={() => void handleConferir()}
            disabled={!conferenciaLiberada || loteEmAndamento !== null || loteModalPedidos !== null}
            title={
              selecionados.length === 0
                ? undefined
                : pedidosUnicosSelecionados.length >= 2 && !filtroLoteAtivo
                    ? "Conferência em lote só com WD/Vonixx para Conferir, Só WD, Só H7 ou WD + H7 ativo."
                    : pedidosUnicosSelecionados.length >= 2 && !conferenciaLoteLiberada
                      ? "Conferência em lote só para pedidos exclusivos WD/H7/Vonixx em Em separação ou A conferir."
                      : conferenciaLoteLiberada
                        ? "Abre o modal de lote: conferir → baixar → imprimir → planilha."
                        : undefined
            }
            className="flex h-7 items-center justify-center gap-1 rounded-md bg-amber px-2.5 text-xs font-medium text-void transition hover:brightness-110 disabled:opacity-40"
          >
            {loteEmAndamento === "conferir" ? <Loader2 size={13} className="animate-spin" /> : <ClipboardCheck size={13} />}
            Conferir {conferenciaLoteLiberada ? `(${pedidosUnicosSelecionados.length})` : ""}
          </button>
        </div>
      </section>

      {(toast || loteResultado) && (
        <div className="mb-4 space-y-1.5 shrink-0">
          {toast && (
            <div
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                toast.tipo === "success"
                  ? "border-green/30 bg-green/10 text-green"
                  : toast.tipo === "warning"
                    ? "border-amber/30 bg-amber/10 text-amber"
                    : "border-red/30 bg-red/10 text-red"
              }`}
            >
              {toast.tipo === "error" ? (
                <CircleX size={15} className="mt-0.5 shrink-0" />
              ) : (
                <CircleCheck size={15} className="mt-0.5 shrink-0" />
              )}
              <span className="flex-1">{toast.mensagem}</span>
              <button
                type="button"
                onClick={() => setToast(null)}
                className="shrink-0 opacity-70 transition hover:opacity-100"
                aria-label="Fechar notificação"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {loteResultado?.sucessos.length ? (
            <div className="flex items-start gap-2 rounded-lg border border-green/30 bg-green/10 px-3 py-2 text-sm text-green">
              <CircleCheck size={15} className="mt-0.5 shrink-0" />
              {loteResultado.sucessos.length} pedido(s) processado(s) com sucesso:{" "}
              {loteResultado.sucessos.join(", ")}
            </div>
          ) : null}
          {loteResultado?.erros.length ? (
            <div className="flex items-start gap-2 rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
              <CircleX size={15} className="mt-0.5 shrink-0" />
              <div>
                {loteResultado.erros.length} pedido(s) com erro:
                <ul className="mt-1 space-y-0.5">
                  {loteResultado.erros.map((e) => (
                    <li key={e.order_id} className="font-mono text-xs">
                      {e.order_id}: {e.mensagem}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {colunasAbertas && (
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-amber/35 bg-amber/10 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber">
            <Columns3 size={14} />
            Editando colunas — arraste, oculte ou redimensione
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={restaurarColunasPadrao}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-text-muted hover:bg-elevated hover:text-text"
          >
            <RotateCcw size={12} />
            Restaurar padrão
          </button>
          <button
            type="button"
            onClick={() => setColunasAbertas(false)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-amber px-3 text-xs font-medium text-void hover:brightness-110"
          >
            <Check size={13} />
            Concluir
          </button>
        </div>
      )}

      {colunasAbertas && colunasOcultas.length > 0 && (
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5 rounded-xl border border-border-soft bg-surface/70 px-3 py-2">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-text-faint">Ocultas</span>
          {colunasOcultas.map((col) => (
            <button
              key={col.id}
              type="button"
              onClick={() => mostrarColuna(col.id)}
              className="rounded-md border border-border-soft bg-elevated/80 px-2 py-1 text-[11px] text-text-muted transition hover:border-amber/40 hover:text-amber"
              title={`Mostrar ${col.label}`}
            >
              {col.label}
            </button>
          ))}
        </div>
      )}

      <div
        ref={tabelaRef}
        onPointerDown={iniciarArrastoScroll}
        onPointerMove={moverArrastoScroll}
        onPointerUp={encerrarArrastoScroll}
        onPointerCancel={encerrarArrastoScroll}
        className="min-h-0 w-full flex-1 overflow-auto rounded-xl border border-border-soft"
        onAuxClick={(e) => {

          if (e.button === 1) e.preventDefault();
        }}
      >
        <table
          className="data-table table-fixed border-collapse font-body text-[11px]"
          style={
            precisaScrollHorizontal
              ? { width: larguraMinimaTabela, minWidth: larguraMinimaTabela }
              : { width: "100%" }
          }
        >
          <thead className="sticky top-0 z-10 bg-surface shadow-[0_1px_0_0_var(--color-border-soft)]">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const ehUltima = header.column.id === idUltimaColuna;
                  const ehSelect = header.column.id === "select";
                  const editavel = colunasAbertas && !ehSelect;
                  const largura =
                    ehUltima && !precisaScrollHorizontal ? undefined : header.getSize();
                  return (
                  <th
                    key={header.id}
                    data-col-id={header.column.id}
                    data-col-drag={editavel ? header.column.id : undefined}
                    onClick={
                      colunasAbertas
                        ? undefined
                        : header.column.getToggleSortingHandler()
                    }
                    style={largura != null ? { width: largura } : undefined}
                    className={`relative truncate text-left text-[11px] font-medium uppercase tracking-wide text-text-muted py-1.5 transition-[background-color,box-shadow,opacity,transform] duration-150 ${paddingColuna(header.column.id)} ${
                      colunasAbertas ? "select-none" : "cursor-pointer select-none"
                    } ${
                      overColId === header.column.id && arrastandoColId
                        ? "bg-amber/20 ring-2 ring-inset ring-amber/55"
                        : arrastandoColId === header.column.id
                          ? "scale-[0.98] border border-dashed border-amber/50 bg-amber/5 opacity-40"
                          : ""
                    } ${colunasAbertas && !arrastandoColId ? "bg-elevated/40" : ""} ${
                      colunasAbertas && arrastandoColId && arrastandoColId !== header.column.id
                        ? "bg-elevated/25"
                        : ""
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-1">
                      {editavel && (
                        <button
                          type="button"
                          title="Arrastar para reordenar"
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const label =
                              CONFIGURABLE_COLUMNS.find((c) => c.id === header.column.id)?.label ??
                              String(header.column.columnDef.header ?? header.column.id);
                            arrastandoColRef.current = header.column.id;
                            setArrastandoColId(header.column.id);
                            setArrastandoColLabel(label);
                            setDragPointer({ x: event.clientX, y: event.clientY });
                          }}
                          className="shrink-0 cursor-grab rounded p-0.5 text-text-faint hover:bg-elevated hover:text-text active:cursor-grabbing"
                        >
                          <GripVertical size={12} />
                        </button>
                      )}
                      <span className="min-w-0 truncate">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {!colunasAbertas &&
                          ({ asc: " ↑", desc: " ↓" }[header.column.getIsSorted() as string] ?? "")}
                      </span>
                      {editavel && (
                        <button
                          type="button"
                          title="Ocultar coluna"
                          onClick={(event) => {
                            event.stopPropagation();
                            ocultarColuna(header.column.id);
                          }}
                          className="ml-auto shrink-0 rounded p-0.5 text-text-faint hover:bg-elevated hover:text-amber"
                        >
                          <EyeOff size={12} />
                        </button>
                      )}
                    </div>
                    {header.column.getCanResize() && !ehUltima && !ehSelect && (
                      <span
                        title="Arraste para redimensionar · Duplo clique: ajustar ao conteúdo"
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          if (event.detail >= 2) {
                            event.preventDefault();
                            autoAjustarLarguraColuna(header.column.id);
                            return;
                          }
                          header.getResizeHandler()(event);
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          autoAjustarLarguraColuna(header.column.id);
                        }}
                        onTouchStart={header.getResizeHandler()}
                        data-col-resize
                        className={`absolute top-1/4 right-0 z-10 h-1/2 cursor-col-resize rounded-full ${
                          colunasAbertas ? "w-1.5" : "w-1"
                        } ${
                          header.column.getIsResizing()
                            ? "bg-amber"
                            : colunasAbertas
                              ? "bg-amber/50 hover:bg-amber"
                              : "bg-border hover:bg-text-faint"
                        }`}
                      />
                    )}
                  </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {isFetching && pedidos.length === 0 ? (
              <tr>
                <td colSpan={table.getVisibleLeafColumns().length} className="px-4 py-16 text-center text-text-faint">
                  <Loader2 size={18} className="animate-spin inline mr-2" /> Carregando pedidos...
                </td>
              </tr>
            ) : isError && pedidos.length === 0 ? (
              <tr>
                <td colSpan={table.getVisibleLeafColumns().length} className="px-4 py-16 text-center text-red">
                  <CircleX size={22} className="mx-auto mb-2 opacity-80" />
                  <p>Não foi possível carregar os pedidos.</p>
                  <p className="mt-1 text-xs text-text-muted">
                    {mensagemErroApi(error, "Verifique a conexão e tente novamente.")}
                  </p>
                  <button
                    type="button"
                    onClick={() => void atualizarDoBanco()}
                    className="mt-3 rounded-md border border-red/35 px-3 py-1.5 text-xs transition hover:bg-red/10"
                  >
                    Tentar novamente
                  </button>
                </td>
              </tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={table.getVisibleLeafColumns().length} className="px-4 py-16 text-center text-text-faint">
                  <PackageSearch size={22} className="inline mb-2 opacity-60 block mx-auto" />
                  Nenhum pedido encontrado para os filtros selecionados.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  title={colunasAbertas ? "Modo edição de colunas" : "Duplo clique para conferir"}
                  onMouseEnter={() => {
                    if (!colunasAbertas) agendarPrefetchItens(row.original.id_any);
                  }}
                  onMouseLeave={cancelarPrefetchItens}
                  onDoubleClick={(e) => {
                    if (colunasAbertas) return;
                    const alvo = e.target as HTMLElement;
                    if (alvo.closest("input, button, a, label, [data-col-resize]")) return;
                    cancelarPrefetchItens();
                    setDialogPedido(row.original);
                  }}
                  className={`cursor-pointer border-t border-border-soft transition hover:bg-elevated/50 ${
                    row.getIsSelected() ? "bg-elevated/70" : ""
                  }`}
                >
                  {row.getVisibleCells().map((cell) => {
                    const ehUltima = cell.column.id === idUltimaColuna;
                    const largura =
                      ehUltima && !precisaScrollHorizontal ? undefined : cell.column.getSize();
                    return (
                    <td
                      key={cell.id}
                      data-col-id={cell.column.id}
                      style={largura != null ? { width: largura } : undefined}
                      className={`overflow-hidden py-2 ${paddingColuna(cell.column.id)} ${
                        cell.column.id === "Item"
                          ? "align-top whitespace-normal"
                          : "truncate whitespace-nowrap"
                      }`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-1.5 flex shrink-0 items-center justify-between gap-3 text-xs text-text-faint">
        <span className="font-mono tabular-nums">
          {dataFiltrada.length} linhas · {selecionados.length} selecionadas
        </span>
        <div className="flex items-center gap-1.5">
          <span className="mr-1 font-mono tabular-nums">
            {dataFiltrada.length === 0
              ? "0 de 0"
              : `${table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1}–${Math.min(
                  (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
                  dataFiltrada.length
                )} de ${dataFiltrada.length}`}
          </span>
          <PageSizeSelect
            value={table.getState().pagination.pageSize}
            options={PAGE_SIZES}
            onChange={(tamanho) => table.setPageSize(tamanho)}
          />
          <button
            type="button"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-elevated text-text-muted transition hover:text-text disabled:opacity-30"
            aria-label="Página anterior"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="min-w-8 px-0.5 text-center font-mono tabular-nums">
            {table.getState().pagination.pageIndex + 1}/{Math.max(table.getPageCount(), 1)}
          </span>
          <button
            type="button"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-elevated text-text-muted transition hover:text-text disabled:opacity-30"
            aria-label="Próxima página"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {arrastandoColId && dragPointer && (
        <div
          className="pointer-events-none fixed z-[80] flex items-center gap-1.5 rounded-lg border border-amber/50 bg-surface px-3 py-2 text-xs font-medium uppercase tracking-wide text-amber shadow-xl shadow-black/40"
          style={{
            left: dragPointer.x + 12,
            top: dragPointer.y + 12,
            transform: "rotate(-2deg)",
          }}
        >
          <GripVertical size={12} className="opacity-70" />
          {arrastandoColLabel || arrastandoColId}
        </div>
      )}

      {dialogPedido && (
        <ConferirDialog
          pedido={dialogPedido}
          eAgendado={eAgendadoDialog}
          forcarConferenciaPadrao={
            filtroRapido.has("wdParaConferir") ||
            (contextoFiltros.idsPedidoSoWd.has(String(dialogPedido.id_any ?? "").trim()) &&
              nfPedidoPreenchida(dialogPedido))
          }
          usuarioLogado={user?.nome || user?.usuario || "operador"}
          ehAdmin={user?.role === "admin"}
          onClose={() => setDialogPedido(null)}
          onNotificar={setToast}
          onImprimir={(modo) => {
            setReimprimirModo(modo ?? "todos");
            setReimprimirPedido(dialogPedido);
            setDialogPedido(null);
          }}
          onConfirmado={(opts) => {
            if (opts?.refresh) {
              void atualizarDoBanco();
            } else {
              void queryClient.invalidateQueries({ queryKey: ["pedidos"] });
            }
            void queryClient.invalidateQueries({ queryKey: ["historico"] });
          }}
        />
      )}

      {reimprimirPedido && (
        <ReimprimirDialog
          pedido={reimprimirPedido}
          modo={
            reimprimirModo === "faltantes" ||
            reimprimirPedido["Status Any"] === "AG AJUSTE"
              ? "faltantes"
              : "todos"
          }
          onClose={() => {
            setReimprimirPedido(null);
            setReimprimirModo("todos");
          }}
          onConcluido={() => {
            void atualizarDoBanco();
            void queryClient.invalidateQueries({ queryKey: ["historico"] });
          }}
        />
      )}

      {loteModalPedidos && (
        <ImpressaoLoteDialog
          pedidos={loteModalPedidos}
          forcarConferenciaPadrao={filtroLoteSelecionado === "wdParaConferir"}
          onClose={() => setLoteModalPedidos(null)}
          onConcluido={() => {
            setRowSelection({});
            void atualizarDoBanco();
            void queryClient.invalidateQueries({ queryKey: ["historico"] });
          }}
        />
      )}
    </div>
  );
}
