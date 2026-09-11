import { useState, useRef, useEffect, useMemo, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import type { Pedido } from "../types/pedido";
import { classificarMkp } from "../lib/marketplace";
import { ehStatusCancelado } from "../lib/regras";
import {
  Truck,
  ScanBarcode,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RotateCcw,
  Volume2,
  VolumeX,
  Sparkles,
  ArrowRight,
  Printer,
  X,
  FileSpreadsheet,
  ChevronDown,
  Trash2,
  ArrowLeft,
  Search,
  Clock,
  AlertCircle,
  CalendarCheck,
  Route,
} from "lucide-react";

// Definição dos 4 Marketplaces / Canais de Expedição oficiais
type MarketplaceId = "meli" | "shopee" | "magalu" | "total_express";

interface MarketplaceInfo {
  nome: string;
  nomeTransportadora: string;
  logoSrc: string;
  accent: string;
  accentRgb: string;
  accentForeground: string;
}

const MARKETPLACES: Record<MarketplaceId, MarketplaceInfo> = {
  meli: {
    nome: "Mercado Livre",
    nomeTransportadora: "Mercado Envios / Coleta Meli",
    logoSrc: "/mkp/meli.png",
    accent: "#ffe600",
    accentRgb: "255, 230, 0",
    accentForeground: "#111318",
  },
  shopee: {
    nome: "Shopee",
    nomeTransportadora: "Shopee Xpress (SPX)",
    logoSrc: "/mkp/shopee.png",
    accent: "#ee4d2d",
    accentRgb: "238, 77, 45",
    accentForeground: "#ffffff",
  },
  magalu: {
    nome: "Magalu",
    nomeTransportadora: "Magalu Entregas / Coleta",
    logoSrc: "/mkp/magalu.png",
    accent: "#36a9e1",
    accentRgb: "54, 169, 225",
    accentForeground: "#07131a",
  },
  total_express: {
    nome: "Tray / Total & Correios",
    nomeTransportadora: "Total Express, Correios & Sedex",
    logoSrc: "/mkp/tray.png",
    accent: "#26c6da",
    accentRgb: "38, 198, 218",
    accentForeground: "#061416",
  },
};

type TipoColeta = "coleta_hoje" | "atrasado" | "agendado_com_nf" | "agendado_sem_conferencia";

interface PedidoDespacho {
  id: string;
  pedido: string;
  cliente: string;
  marketplace: MarketplaceId;
  nf: string;
  barcode: string;
  status: "Conferido" | "Ag. Embarque" | "Pendente" | "Cancelado";
  tipoColeta: TipoColeta;
  horarioConferencia: string;
  horarioDespacho?: string;
  operadorDespacho?: string;
}

// Dados simulados com cenários reais (Coleta Hoje, Atrasados e Agendados com NF liberados)
const PEDIDOS_INICIAIS: PedidoDespacho[] = [
  // Mercado Livre (6 pedidos elegíveis para expedição hoje)
  {
    id: "801",
    pedido: "MLB-45910221",
    cliente: "Carlos Eduardo Souza",
    marketplace: "meli",
    nf: "001.992.101",
    barcode: "ETQ-801-MELI",
    status: "Ag. Embarque",
    tipoColeta: "coleta_hoje",
    horarioConferencia: "08:40",
    horarioDespacho: "09:05",
    operadorDespacho: "Rafael Silva",
  },
  {
    id: "802",
    pedido: "MLB-45910222",
    cliente: "Mariana Alcantara",
    marketplace: "meli",
    nf: "001.992.102",
    barcode: "ETQ-802-MELI",
    status: "Ag. Embarque",
    tipoColeta: "atrasado",
    horarioConferencia: "08:45",
    horarioDespacho: "09:07",
    operadorDespacho: "Rafael Silva",
  },
  {
    id: "803",
    pedido: "MLB-45910223",
    cliente: "Bruno Henrique Lima",
    marketplace: "meli",
    nf: "001.992.103",
    barcode: "ETQ-803-MELI",
    status: "Conferido",
    tipoColeta: "coleta_hoje",
    horarioConferencia: "09:15",
  },
  {
    id: "804",
    pedido: "MLB-45910224",
    cliente: "Fernanda Ribeiro",
    marketplace: "meli",
    nf: "001.992.104",
    barcode: "ETQ-804-MELI",
    status: "Conferido",
    tipoColeta: "agendado_com_nf",
    horarioConferencia: "09:20",
  },
  {
    id: "805",
    pedido: "MLB-45910225",
    cliente: "João Pedro Matos",
    marketplace: "meli",
    nf: "001.992.105",
    barcode: "ETQ-805-MELI",
    status: "Conferido",
    tipoColeta: "atrasado",
    horarioConferencia: "09:25",
  },
  {
    id: "806",
    pedido: "MLB-45910226",
    cliente: "Guilherme Siqueira",
    marketplace: "meli",
    nf: "001.992.106",
    barcode: "ETQ-806-MELI",
    status: "Ag. Embarque",
    tipoColeta: "agendado_com_nf",
    horarioConferencia: "09:00",
    horarioDespacho: "09:18",
    operadorDespacho: "Rafael Silva",
  },

  // Shopee (4 pedidos elegíveis)
  {
    id: "810",
    pedido: "SPX-77182901",
    cliente: "Lucas de Morais",
    marketplace: "shopee",
    nf: "001.992.110",
    barcode: "ETQ-810-SPX",
    status: "Ag. Embarque",
    tipoColeta: "coleta_hoje",
    horarioConferencia: "08:50",
    horarioDespacho: "09:12",
    operadorDespacho: "marcelo.ops",
  },
  {
    id: "811",
    pedido: "SPX-77182902",
    cliente: "Camila Santos Duarte",
    marketplace: "shopee",
    nf: "001.992.111",
    barcode: "ETQ-811-SPX",
    status: "Conferido",
    tipoColeta: "coleta_hoje",
    horarioConferencia: "09:30",
  },
  {
    id: "812",
    pedido: "SPX-77182903",
    cliente: "Juliana Mendes",
    marketplace: "shopee",
    nf: "001.992.112",
    barcode: "ETQ-812-SPX",
    status: "Conferido",
    tipoColeta: "atrasado",
    horarioConferencia: "09:35",
  },
  {
    id: "813",
    pedido: "SPX-77182904",
    cliente: "Roberto Farias",
    marketplace: "shopee",
    nf: "001.992.113",
    barcode: "ETQ-813-SPX",
    status: "Ag. Embarque",
    tipoColeta: "agendado_com_nf",
    horarioConferencia: "08:30",
    horarioDespacho: "09:00",
    operadorDespacho: "marcelo.ops",
  },

  // Magalu (3 pedidos elegíveis)
  {
    id: "820",
    pedido: "MGL-99381021",
    cliente: "Oficina Mecânica Brasil",
    marketplace: "magalu",
    nf: "001.992.120",
    barcode: "ETQ-820-MGL",
    status: "Ag. Embarque",
    tipoColeta: "coleta_hoje",
    horarioConferencia: "08:35",
    horarioDespacho: "09:02",
    operadorDespacho: "Rafael Silva",
  },
  {
    id: "821",
    pedido: "MGL-99381022",
    cliente: "Renata Vasconcelos",
    marketplace: "magalu",
    nf: "001.992.121",
    barcode: "ETQ-821-MGL",
    status: "Conferido",
    tipoColeta: "atrasado",
    horarioConferencia: "09:40",
  },
  {
    id: "822",
    pedido: "MGL-99381023",
    cliente: "Diego Rocha",
    marketplace: "magalu",
    nf: "001.992.122",
    barcode: "ETQ-822-MGL",
    status: "Conferido",
    tipoColeta: "agendado_com_nf",
    horarioConferencia: "09:45",
  },

  // Tray / Total Express & Correios (3 pedidos elegíveis)
  {
    id: "830",
    pedido: "TRY-33291881",
    cliente: "Agropecuária Vale Verde",
    marketplace: "total_express",
    nf: "001.992.130",
    barcode: "ETQ-830-TOT",
    status: "Ag. Embarque",
    tipoColeta: "coleta_hoje",
    horarioConferencia: "08:20",
    horarioDespacho: "08:55",
    operadorDespacho: "Rafael Silva",
  },
  {
    id: "831",
    pedido: "TRY-33291882",
    cliente: "Auto Peças Central",
    marketplace: "total_express",
    nf: "001.992.131",
    barcode: "ETQ-831-TOT",
    status: "Conferido",
    tipoColeta: "coleta_hoje",
    horarioConferencia: "09:50",
  },
  {
    id: "832",
    pedido: "TRY-33291883",
    cliente: "Transportadora Leste",
    marketplace: "total_express",
    nf: "001.992.132",
    barcode: "ETQ-832-TOT",
    status: "Conferido",
    tipoColeta: "atrasado",
    horarioConferencia: "09:55",
  },

  // Casos de auditoria e teste de bip
  {
    id: "890",
    pedido: "MLB-45910290",
    cliente: "Marcos Paulo Silva",
    marketplace: "meli",
    nf: "001.992.190",
    barcode: "ETQ-890-PEND",
    status: "Pendente",
    tipoColeta: "agendado_sem_conferencia",
    horarioConferencia: "—",
  },
  {
    id: "891",
    pedido: "MLB-45910291",
    cliente: "Distribuidora Sol Nascente",
    marketplace: "meli",
    nf: "001.992.191",
    barcode: "ETQ-891-CANC",
    status: "Cancelado",
    tipoColeta: "coleta_hoje",
    horarioConferencia: "08:10",
  },
];

// Gerador de bips sonoros sintéticos via Web Audio
function tocarBeep(tipo: "sucesso" | "erro" | "aviso") {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    if (tipo === "sucesso") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1250, ctx.currentTime);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } else if (tipo === "aviso") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(650, ctx.currentTime);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } else {
      [0, 0.12].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(230, ctx.currentTime + offset);
        gain.gain.setValueAtTime(0.25, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.09);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.09);
      });
    }
  } catch {
    // Silenciado
  }
}

export default function DespachoDemoPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);

  const [somHabilitado, setSomHabilitado] = useState(true);
  const [pedidos, setPedidos] = useState<PedidoDespacho[]>(PEDIDOS_INICIAIS);

  // Carrega pedidos da API
  const { data: pedidosData, isLoading: carregandoPedidos, refetch: recarregarPedidos } = useQuery({
    queryKey: ["pedidos"],
    queryFn: async () => {
      const res = await api.get<{ items: Pedido[]; total: number }>("/pedidos");
      return res.data;
    },
    staleTime: 30_000,
  });

  // Carrega histórico de despachos recentes para marcar horários/operadores de pedidos já bipados
  const { data: despachosData } = useQuery({
    queryKey: ["despachos-recentes"],
    queryFn: async () => {
      const res = await api.get<{
        items: Array<{ id: number; usuario: string; tipo_acao: string; detalhes: string; pedido_id: string; created_at: string }>;
      }>("/pedidos/despachos/recentes?limite=1000");
      return res.data;
    },
    staleTime: 15_000,
  });

  // Transportadora selecionada para a tela de conferência dedicada
  // Se null -> exibe a tela principal com os 4 cards
  const [transportadoraAtivaId, setTransportadoraAtivaId] = useState<MarketplaceId | null>(null);

  // Aba interna do posto: "pendentes" (esperando bipar) | "bipados" (já enviados à prateleira)
  const [abaConferencia, setAbaConferencia] = useState<"pendentes" | "bipados">("pendentes");
  const [filtroTexto, setFiltroTexto] = useState("");

  // Input do scanner
  const [codigoInput, setCodigoInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Banner/Toast do último bip
  const [ultimoResultado, setUltimoResultado] = useState<{
    tipo: "sucesso" | "erro" | "aviso";
    mensagem: string;
    detalhe?: string;
    pedido?: PedidoDespacho;
  } | null>(null);

  // Modal de Romaneio
  const [romaneioMkp, setRomaneioMkp] = useState<MarketplaceId | null>(null);

  // Drawer de simulação rápida
  const [mostrarSimulador, setMostrarSimulador] = useState(false);

  // Foco permanente no input de bipagem sempre que estiver dentro de uma transportadora
  useEffect(() => {
    if (transportadoraAtivaId) {
      inputRef.current?.focus();
    }
  }, [transportadoraAtivaId, ultimoResultado]);

  // Sincroniza dados do backend com a lista de pedidos da expedição
  useEffect(() => {
    if (!pedidosData?.items) return;

    const despachosMap = new Map<string, { horario: string; operador: string }>();
    if (despachosData?.items) {
      for (const item of despachosData.items) {
        if (item.tipo_acao === "DESPACHO" && item.pedido_id && !despachosMap.has(item.pedido_id)) {
          let horario = "";
          try {
            const d = new Date(item.created_at);
            horario = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
          } catch {
            horario = "—";
          }
          despachosMap.set(item.pedido_id, {
            horario,
            operador: item.usuario || "Operador",
          });
        }
      }
    }

    const convertidos = pedidosData.items.map((p) => {
      const mkp = classificarMkp(p.Mkp);
      let marketplace: MarketplaceId = "total_express";
      if (mkp === "meli") marketplace = "meli";
      else if (mkp === "shopee") marketplace = "shopee";
      else if (mkp === "magalu") marketplace = "magalu";
      else if (mkp === "tray") marketplace = "total_express";

      const stAny = (p["Status Any"] ?? "").trim();
      const stCd = (p["Status CD"] ?? "").trim();

      let status: "Conferido" | "Ag. Embarque" | "Pendente" | "Cancelado" = "Pendente";
      if (ehStatusCancelado(stAny)) {
        status = "Cancelado";
      } else if (stAny === "Ag. Coleta" || stAny === "Ag. Coleta CD") {
        status = "Ag. Embarque";
      } else if (stAny === "Conferido" || stAny === "Recebido" || stAny === "FEITO") {
        status = "Conferido";
      } else {
        status = "Pendente";
      }

      let tipoColeta: TipoColeta = "coleta_hoje";
      if (stCd.startsWith("Atrasado")) {
        tipoColeta = "atrasado";
      } else if (stCd.startsWith("Agendado")) {
        tipoColeta = p["NF Venda"] ? "agendado_com_nf" : "agendado_sem_conferencia";
      } else {
        tipoColeta = "coleta_hoje";
      }

      const idStr = String(p.id_any ?? "");
      const infoDespacho = despachosMap.get(idStr);

      return {
        id: idStr,
        pedido: p.Pedido || p["Pedido Any"] || idStr,
        cliente: p.Cliente || "Cliente não informado",
        marketplace,
        nf: p["NF Venda"] ? String(p["NF Venda"]).trim() : "—",
        barcode: p.ean || (p["NF Venda"] ? String(p["NF Venda"]).trim() : "") || idStr,
        status,
        tipoColeta,
        horarioConferencia: p.Data ? p.Data.substring(11, 16) : "—",
        horarioDespacho: infoDespacho?.horario,
        operadorDespacho: infoDespacho?.operador,
      };
    });

    setPedidos(convertidos);
  }, [pedidosData, despachosData]);

  // Métricas consolidadas de expedição por Marketplace
  const metricasPorMkp = useMemo(() => {
    const ids: MarketplaceId[] = ["meli", "shopee", "magalu", "total_express"];
    const resultado: Record<
      MarketplaceId,
      {
        totalAExpedir: number;
        jaBipados: number;
        faltandoBipar: number;
        coletaHoje: number;
        atrasados: number;
        agendadosComNf: number;
        percentual: number;
        pedidosBipados: PedidoDespacho[];
        pedidosPendentes: PedidoDespacho[];
      }
    > = {} as any;

    ids.forEach((id) => {
      const elegiveis = pedidos.filter(
        (p) =>
          p.marketplace === id &&
          p.status !== "Cancelado" &&
          (p.tipoColeta === "coleta_hoje" ||
            p.tipoColeta === "atrasado" ||
            p.tipoColeta === "agendado_com_nf")
      );

      const pedidosBipados = elegiveis.filter((p) => p.status === "Ag. Embarque");
      const pedidosPendentes = elegiveis.filter((p) => p.status !== "Ag. Embarque");

      const coletaHoje = elegiveis.filter((p) => p.tipoColeta === "coleta_hoje").length;
      const atrasados = elegiveis.filter((p) => p.tipoColeta === "atrasado").length;
      const agendadosComNf = elegiveis.filter((p) => p.tipoColeta === "agendado_com_nf").length;

      const totalAExpedir = elegiveis.length;
      const jaBipados = pedidosBipados.length;
      const faltandoBipar = pedidosPendentes.length;
      const percentual = totalAExpedir > 0 ? Math.round((jaBipados / totalAExpedir) * 100) : 100;

      resultado[id] = {
        totalAExpedir,
        jaBipados,
        faltandoBipar,
        coletaHoje,
        atrasados,
        agendadosComNf,
        percentual,
        pedidosBipados,
        pedidosPendentes,
      };
    });

    return resultado;
  }, [pedidos]);

  // Estatísticas gerais do topo
  const totaisGerais = useMemo(() => {
    let totalExpedir = 0;
    let totalBipados = 0;
    let totalFaltando = 0;

    Object.values(metricasPorMkp).forEach((m) => {
      totalExpedir += m.totalAExpedir;
      totalBipados += m.jaBipados;
      totalFaltando += m.faltandoBipar;
    });

    const percentualGeral = totalExpedir > 0 ? Math.round((totalBipados / totalExpedir) * 100) : 100;
    return { totalExpedir, totalBipados, totalFaltando, percentualGeral };
  }, [metricasPorMkp]);

  // Processamento do bip exclusivo da transportadora ativa
  const processarBip = async (codigoOriginal: string) => {
    const codigo = codigoOriginal.trim();
    if (!codigo) return;
    if (!transportadoraAtivaId) return;

    const transportadoraAtiva = MARKETPLACES[transportadoraAtivaId];

    // Extração inteligente de NF se for chave NF-e de 44 dígitos
    const apenasDigitos = codigo.replace(/\D/g, "");
    let chaveNfe = "";
    let nfExtraida = "";
    if (apenasDigitos.length === 44) {
      chaveNfe = apenasDigitos;
      const rawNf = apenasDigitos.substring(25, 34);
      nfExtraida = String(parseInt(rawNf, 10)); // remove zeros à esquerda
    }

    const codBusca = codigo.toLowerCase();

    const pedidoEncontrado = pedidos.find((p) => {
      const nfLimpa = String(p.nf || "").trim().replace(/\D/g, "");
      const nfRaw = String(p.nf || "").trim();
      const idStr = String(p.id || "").trim();
      const pedStr = String(p.pedido || "").trim().toLowerCase();

      // 1. Chave 44 dígitos da DANFE
      if (nfExtraida && (nfLimpa === nfExtraida || nfRaw === nfExtraida)) return true;
      // 2. Número da NF digitado ou bipado direto
      if (nfLimpa && nfLimpa === apenasDigitos) return true;
      // 3. ID AnyMarket
      if (idStr === codigo) return true;
      // 4. Número do pedido no Marketplace
      if (pedStr === codBusca) return true;
      // 5. Código de barras / EAN
      if (p.barcode && p.barcode.toLowerCase() === codBusca) return true;

      return false;
    });

    if (!pedidoEncontrado) {
      if (somHabilitado) tocarBeep("erro");
      setUltimoResultado({
        tipo: "erro",
        mensagem: "CÓDIGO NÃO LOCALIZADO",
        detalhe: nfExtraida
          ? `Chave NF-e lida (NF ${nfExtraida}), mas nenhum pedido com essa NF foi encontrado.`
          : `Nenhum pedido encontrado para "${codigo}".`,
      });
      return;
    }

    // Validação estrita: O pacote pertence a esta transportadora?
    if (pedidoEncontrado.marketplace !== transportadoraAtivaId) {
      if (somHabilitado) tocarBeep("erro");
      const mkpPedido = MARKETPLACES[pedidoEncontrado.marketplace];
      setUltimoResultado({
        tipo: "erro",
        mensagem: `PACOTE DE OUTRA TRANSPORTADORA! (${mkpPedido.nome.toUpperCase()})`,
        detalhe: `Este pacote pertence ao ${mkpPedido.nome}. Você está conferindo exclusivamente ${transportadoraAtiva.nome}.`,
        pedido: pedidoEncontrado,
      });
      return;
    }

    if (pedidoEncontrado.status === "Cancelado") {
      if (somHabilitado) tocarBeep("erro");
      setUltimoResultado({
        tipo: "erro",
        mensagem: "PEDIDO CANCELADO — NÃO LEVE À PRATELEIRA!",
        detalhe: `O pedido ${pedidoEncontrado.pedido} foi cancelado. Separe o pacote para devolução imediata.`,
        pedido: pedidoEncontrado,
      });
      return;
    }

    if (pedidoEncontrado.status === "Pendente") {
      if (somHabilitado) tocarBeep("erro");
      setUltimoResultado({
        tipo: "erro",
        mensagem: "PEDIDO NÃO CONFERIDO!",
        detalhe: `O pedido ${pedidoEncontrado.pedido} ainda não teve conferência física na bancada.`,
        pedido: pedidoEncontrado,
      });
      return;
    }

    if (pedidoEncontrado.status === "Ag. Embarque") {
      if (somHabilitado) tocarBeep("aviso");
      setUltimoResultado({
        tipo: "aviso",
        mensagem: "PACOTE JÁ BIPADO!",
        detalhe: `Bipado às ${pedidoEncontrado.horarioDespacho || "—"} por ${pedidoEncontrado.operadorDespacho || "operador"} e enviado à prateleira.`,
        pedido: pedidoEncontrado,
      });
      return;
    }

    // Sucesso na bipagem: persiste no backend e atualiza status para Ag. Coleta
    try {
      await api.post(`/pedidos/${pedidoEncontrado.id}/registrar-despacho`, {
        marketplace: transportadoraAtivaId,
        chave_nfe: chaveNfe,
        nf_venda: pedidoEncontrado.nf,
      });

      const agora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const opNome = user?.nome || user?.usuario || "Operador";

      setPedidos((prev) =>
        prev.map((p) =>
          p.id === pedidoEncontrado.id
            ? {
                ...p,
                status: "Ag. Embarque",
                horarioDespacho: agora,
                operadorDespacho: opNome,
              }
            : p
        )
      );

      queryClient.invalidateQueries({ queryKey: ["pedidos"] });

      if (somHabilitado) tocarBeep("sucesso");
      setUltimoResultado(null);
    } catch (err: any) {
      if (somHabilitado) tocarBeep("erro");
      setUltimoResultado({
        tipo: "erro",
        mensagem: "ERRO AO REGISTRAR DESPACHO",
        detalhe: err?.response?.data?.detail || err?.message || "Falha na comunicação com o servidor.",
        pedido: pedidoEncontrado,
      });
    }
  };

  const handleInputSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!codigoInput.trim()) return;
    processarBip(codigoInput);
    setCodigoInput("");
  };

  // Estornar bipagem (retira da prateleira e volta para Conferido)
  const estornarPedido = async (pedidoId: string) => {
    try {
      await api.post(`/pedidos/${pedidoId}/estornar-despacho`, {
        motivo: "Estorno solicitado pelo operador na tela de despacho",
      });
      setPedidos((prev) =>
        prev.map((p) =>
          p.id === pedidoId
            ? {
                ...p,
                status: "Conferido",
                horarioDespacho: undefined,
                operadorDespacho: undefined,
              }
            : p
        )
      );
      queryClient.invalidateQueries({ queryKey: ["pedidos"] });
      if (somHabilitado) tocarBeep("aviso");
    } catch (err: any) {
      if (somHabilitado) tocarBeep("erro");
      setUltimoResultado({
        tipo: "erro",
        mensagem: "ERRO AO ESTORNAR DESPACHO",
        detalhe: err?.response?.data?.detail || err?.message || "Falha na comunicação com o servidor.",
      });
    }
  };

  const resetarDemo = () => {
    recarregarPedidos();
    setUltimoResultado(null);
    setCodigoInput("");
    setFiltroTexto("");
  };

  // Pedidos para o Romaneio de Coleta oficial
  const pedidosDoRomaneio = useMemo(() => {
    if (!romaneioMkp) return [];
    return metricasPorMkp[romaneioMkp]?.pedidosBipados || [];
  }, [romaneioMkp, metricasPorMkp]);

  // Lista de pedidos filtrados na tela de conferência da transportadora ativa
  const pedidosConferenciaFiltrados = useMemo(() => {
    if (!transportadoraAtivaId) return [];
    const m = metricasPorMkp[transportadoraAtivaId];
    const listaBase = abaConferencia === "pendentes" ? m.pedidosPendentes : m.pedidosBipados;

    if (!filtroTexto.trim()) return listaBase;
    const busca = filtroTexto.toLowerCase();
    return listaBase.filter(
      (p) =>
        p.pedido.toLowerCase().includes(busca) ||
        p.nf.toLowerCase().includes(busca) ||
        p.cliente.toLowerCase().includes(busca)
    );
  }, [transportadoraAtivaId, metricasPorMkp, abaConferencia, filtroTexto]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-void text-text">
      {/* Header Superior Principal */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-6 py-2.5">
        <div className="flex items-center gap-3">
          {transportadoraAtivaId ? (
            <button
              type="button"
              onClick={() => {
                setTransportadoraAtivaId(null);
                setUltimoResultado(null);
                setCodigoInput("");
                setFiltroTexto("");
              }}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-elevated px-3 text-xs font-semibold text-text hover:border-amber hover:text-amber transition"
            >
              <ArrowLeft size={16} />
              Voltar às Transportadoras
            </button>
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber/30 bg-amber/15 text-amber shadow-inner">
              <Truck size={20} />
            </div>
          )}

          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-sm font-bold tracking-tight text-text">
                {transportadoraAtivaId
                  ? `Posto de Bipagem — ${MARKETPLACES[transportadoraAtivaId].nome}`
                  : "Despacho — Prateleiras de Coleta"}
              </h1>
              <span className="inline-flex items-center gap-1 rounded bg-amber/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber">
                <Sparkles size={11} />
                MODO TESTE (MOCK)
              </span>
            </div>
            <p className="text-[11px] text-text-faint">
              {transportadoraAtivaId
                ? `Bipe o pacote embalado e leve-o para a prateleira de coleta de ${MARKETPLACES[transportadoraAtivaId].nome}.`
                : "Selecione o marketplace para bipar os pacotes já embalados antes de levá-los à prateleira."}
            </p>
          </div>
        </div>

        {/* Controles de Apoio */}
        <div className="flex items-center gap-2">
          {transportadoraAtivaId && (
            <button
              type="button"
              onClick={() => setMostrarSimulador(!mostrarSimulador)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition ${
                mostrarSimulador
                  ? "border-amber/60 bg-amber/15 text-amber shadow-sm"
                  : "border-border bg-elevated text-text-muted hover:text-text"
              }`}
            >
              <Sparkles size={13} />
              Simular Leitura
              <ChevronDown size={13} className={`transition-transform ${mostrarSimulador ? "rotate-180" : ""}`} />
            </button>
          )}

          <button
            type="button"
            onClick={() => setSomHabilitado(!somHabilitado)}
            className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${
              somHabilitado
                ? "border-green/40 bg-green/10 text-green"
                : "border-border bg-elevated text-text-faint"
            }`}
            title={somHabilitado ? "Som do leitor ótico ligado" : "Som mutado"}
          >
            {somHabilitado ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </button>

          <button
            type="button"
            onClick={resetarDemo}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-elevated px-2.5 text-xs text-text-muted hover:border-text-faint hover:text-text"
            title="Atualizar pedidos da expedição"
          >
            <RotateCcw size={13} className={carregandoPedidos ? "animate-spin" : ""} />
            Atualizar
          </button>
        </div>
      </header>

      {/* ========================================================================= */}
      {/* CENÁRIO 1: TELA PRINCIPAL COM OS CARDS DAS TRANSPORTADORAS               */}
      {/* ========================================================================= */}
      {!transportadoraAtivaId && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Resumo das prateleiras de coleta */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-surface/30 px-4 py-2.5 sm:px-6">
            <div className="grid w-full grid-cols-2 gap-x-5 gap-y-2 lg:flex lg:w-auto lg:items-center lg:gap-6">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-text-faint">Pedidos do Dia:</span>
                <span className="font-mono font-bold text-text">{totaisGerais.totalExpedir} pedidos</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="inline-block h-2 w-2 rounded-full bg-green" />
                <span className="text-text-faint">Ag. Embarque:</span>
                <span className="font-mono font-bold text-green">{totaisGerais.totalBipados} pedidos</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="inline-block h-2 w-2 rounded-full bg-amber" />
                <span className="text-text-faint">Aguardando Bipagem:</span>
                <span className="font-mono font-bold text-amber">
                  {totaisGerais.totalFaltando} pedidos
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-text-faint">Progresso Geral:</span>
                <span className="font-mono font-bold text-cyan-400">{totaisGerais.percentualGeral}%</span>
              </div>
            </div>

            <span className="hidden text-xs font-medium text-amber xl:inline-flex">
              💡 Clique no card da transportadora para conferir
            </span>
          </div>

          {/* Cards das transportadoras */}
          <main
            className="flex-1 overflow-y-auto p-4 sm:p-6"
            style={{
              backgroundImage:
                "radial-gradient(circle at 14% 0%, rgba(79,184,216,.07), transparent 28%), linear-gradient(rgba(255,255,255,.012) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.012) 1px, transparent 1px)",
              backgroundSize: "auto, 32px 32px, 32px 32px",
            }}
          >
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
              {(["meli", "shopee", "magalu", "total_express"] as MarketplaceId[]).map((mkpId) => {
                const mkp = MARKETPLACES[mkpId];
                const m = metricasPorMkp[mkpId];
                const abrirConferencia = () => {
                  setTransportadoraAtivaId(mkpId);
                  setUltimoResultado(null);
                  setCodigoInput("");
                  setAbaConferencia("pendentes");
                };
                const progressColor = m.percentual === 100 ? "#3ecf8e" : mkp.accent;
                const logoScale =
                  mkpId === "meli"
                    ? "scale-[1.7] group-hover/card:scale-[1.74]"
                    : mkpId === "shopee"
                    ? "scale-[1.65] group-hover/card:scale-[1.69]"
                    : "scale-[0.95] group-hover/card:scale-[0.99]";

                return (
                  <div
                    key={mkpId}
                    onClick={abrirConferencia}
                    style={{
                      backgroundImage: `linear-gradient(132deg, rgba(${mkp.accentRgb}, .19) 0%, rgba(${mkp.accentRgb}, .055) 30%, transparent 52%), linear-gradient(160deg, #151a22 0%, #0c1016 76%)`,
                    }}
                    className="group/card relative flex min-h-[372px] cursor-pointer flex-col overflow-hidden rounded-[24px] border border-white/[.09] p-5 shadow-[0_18px_55px_rgba(0,0,0,.34)] transition-[transform,border-color,box-shadow] duration-300 hover:-translate-y-1 hover:border-white/[.18] hover:shadow-[0_26px_72px_rgba(0,0,0,.48)]"
                  >
                    <div
                      className="pointer-events-none absolute inset-x-8 top-0 h-px opacity-90"
                      style={{ backgroundImage: `linear-gradient(90deg, transparent, ${mkp.accent}, transparent)` }}
                    />
                    <div
                      className="pointer-events-none absolute -left-16 -top-20 h-52 w-52 rounded-full opacity-35 blur-3xl transition-opacity duration-500 group-hover/card:opacity-50"
                      style={{ backgroundColor: mkp.accent }}
                    />

                    <div className="relative flex min-h-14 items-start gap-3">
                      <div className="flex h-12 w-28 shrink-0 items-center justify-start">
                        <img
                          src={mkp.logoSrc}
                          alt={mkp.nome}
                          className={`h-10 max-w-[104px] object-contain drop-shadow-lg transition-transform duration-300 ${logoScale}`}
                        />
                      </div>
                      <div className="ml-auto text-right">
                        <div className="font-mono text-xl font-semibold leading-none text-white">
                          {m.jaBipados}
                          <span className="text-sm font-normal text-white/35">/{m.totalAExpedir}</span>
                        </div>
                        <span className="mt-1 block text-[9px] font-medium uppercase tracking-[0.16em] text-white/35">
                          pedidos bipados
                        </span>
                      </div>
                    </div>

                    <div className="relative mt-3 flex items-center gap-2 text-[10px] text-white/45">
                      <Route size={13} style={{ color: mkp.accent }} />
                      <span className="truncate">{mkp.nomeTransportadora}</span>
                    </div>

                    <div className="relative mt-7 flex items-end justify-between gap-4">
                      <div>
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
                          Aguardando bipagem
                        </span>
                        <div className="mt-1 flex items-baseline gap-2">
                          <span className="font-display text-[4.25rem] font-bold leading-[.9] tracking-[-0.085em] text-white">
                            {String(m.faltandoBipar).padStart(2, "0")}
                          </span>
                          <span className="text-[10px] font-medium uppercase tracking-wider text-white/35">pedidos</span>
                        </div>
                      </div>
                      <div className="pb-1 text-right">
                        <span className="block font-display text-3xl font-semibold tracking-[-0.05em]" style={{ color: progressColor }}>
                          {m.percentual}%
                        </span>
                        <span className="text-[9px] uppercase tracking-[0.14em] text-white/35">
                          {m.faltandoBipar === 0 ? "rota concluída" : "da rota concluída"}
                        </span>
                      </div>
                    </div>

                    <div className="relative mt-5">
                      <div className="h-1.5 overflow-hidden rounded-full bg-white/[.075]">
                        <div
                          className="h-full rounded-full transition-[width] duration-700"
                          style={{
                            width: `${m.percentual}%`,
                            backgroundColor: progressColor,
                            boxShadow: `0 0 18px rgba(${mkp.accentRgb}, .45)`,
                          }}
                        />
                      </div>
                      <div className="mt-2 flex justify-between font-mono text-[8px] uppercase tracking-[0.13em] text-white/25">
                        <span>Início</span>
                        <span>{m.totalAExpedir} pedidos</span>
                      </div>
                    </div>

                    <div className="relative mt-5 grid grid-cols-3 divide-x divide-white/[.08] border-y border-white/[.08] py-3">
                      <div className="px-2 first:pl-0">
                        <div className="flex items-center gap-1.5 text-white/35"><Clock size={12} /><span className="text-[9px]">Hoje</span></div>
                        <strong className="mt-1 block font-mono text-lg font-medium text-white">{m.coletaHoje}</strong>
                      </div>
                      <div className="px-3">
                        <div className={`flex items-center gap-1.5 ${m.atrasados > 0 ? "text-red-300/80" : "text-white/35"}`}>
                          <AlertCircle size={12} /><span className="text-[9px]">Atrasados</span>
                        </div>
                        <strong className={`mt-1 block font-mono text-lg font-medium ${m.atrasados > 0 ? "text-red-200" : "text-white"}`}>{m.atrasados}</strong>
                      </div>
                      <div className="px-3 pr-0">
                        <div className="flex items-center gap-1.5 text-cyan-200/65"><CalendarCheck size={12} /><span className="text-[9px]">Agendados</span></div>
                        <strong className="mt-1 block font-mono text-lg font-medium text-white">{m.agendadosComNf}</strong>
                      </div>
                    </div>

                    <div className="relative mt-auto grid grid-cols-[1.15fr_.85fr] gap-2 pt-4">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          abrirConferencia();
                        }}
                        className="inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-bold shadow-[0_8px_24px_rgba(0,0,0,.22)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        style={{ backgroundColor: mkp.accent, color: mkp.accentForeground }}
                      >
                        <ScanBarcode size={14} /> Abrir posto
                      </button>
                      <button
                        type="button"
                        disabled={m.jaBipados === 0}
                        onClick={(event) => {
                          event.stopPropagation();
                          setRomaneioMkp(mkpId);
                        }}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/[.1] bg-white/[.035] px-2.5 py-2.5 text-[11px] font-semibold text-white/55 transition hover:border-white/20 hover:bg-white/[.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
                      >
                        <FileSpreadsheet size={13} /> Romaneio {m.jaBipados > 0 ? `(${m.jaBipados})` : ""}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </main>
        </div>
      )}

      {/* ========================================================================= */}
      {/* CENÁRIO 2: TELA DEDICADA DE CONFERÊNCIA DA TRANSPORTADORA SELECIONADA     */}
      {/* ========================================================================= */}
      {transportadoraAtivaId && (() => {
        const mkp = MARKETPLACES[transportadoraAtivaId];
        const m = metricasPorMkp[transportadoraAtivaId];

        return (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Contexto e progresso do posto */}
            <section
              className="relative overflow-hidden border-b border-white/[.08] bg-[#10151c] px-4 py-4 sm:px-6"
              style={{
                backgroundImage: `linear-gradient(110deg, rgba(${mkp.accentRgb}, .14), transparent 34%), linear-gradient(180deg, rgba(255,255,255,.025), transparent)`,
              }}
            >
              <div className="absolute inset-x-0 top-0 h-px" style={{ backgroundImage: `linear-gradient(90deg, ${mkp.accent}, transparent 55%)` }} />
              <div className="flex flex-wrap items-center gap-x-7 gap-y-4">
                <div className="flex min-w-[250px] items-center gap-4">
                  <div className="flex h-14 w-28 shrink-0 items-center justify-center">
                    <img
                      src={mkp.logoSrc}
                      alt={mkp.nome}
                      className={`h-11 max-w-[112px] object-contain drop-shadow-lg ${
                        transportadoraAtivaId === "meli"
                          ? "scale-[1.42]"
                          : transportadoraAtivaId === "shopee"
                          ? "scale-[1.32]"
                          : "scale-[1.0]"
                      }`}
                    />
                  </div>
                  <div className="h-9 w-px bg-white/[.09]" />
                  <div>
                    <span className="block text-[9px] font-semibold uppercase tracking-[0.2em] text-white/35">Prateleira de coleta</span>
                    <strong className="mt-1 block max-w-[220px] truncate text-xs font-semibold text-white/85">{mkp.nomeTransportadora}</strong>
                  </div>
                </div>

                <div className="min-w-[260px] flex-1">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/35">Progresso da bipagem</span>
                      <div className="mt-1 font-mono text-sm font-semibold text-white">
                        {m.jaBipados} <span className="font-normal text-white/30">de</span> {m.totalAExpedir}
                      </div>
                    </div>
                    <span className="font-display text-3xl font-semibold tracking-[-0.06em]" style={{ color: m.percentual === 100 ? "#3ecf8e" : mkp.accent }}>
                      {m.percentual}%
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[.07]">
                    <div
                      className="h-full rounded-full transition-[width] duration-700"
                      style={{
                        width: `${m.percentual}%`,
                        backgroundColor: m.percentual === 100 ? "#3ecf8e" : mkp.accent,
                        boxShadow: `0 0 16px rgba(${mkp.accentRgb}, .38)`,
                      }}
                    />
                  </div>
                </div>

                <div className="flex items-center divide-x divide-white/[.08]">
                  <div className="px-4 text-center">
                    <strong className="block font-mono text-lg font-semibold text-white">{m.faltandoBipar}</strong>
                    <span className="text-[9px] text-white/35">A bipar</span>
                  </div>
                  <div className="px-4 text-center">
                    <strong className={`block font-mono text-lg font-semibold ${m.atrasados ? "text-red-200" : "text-white"}`}>{m.atrasados}</strong>
                    <span className="text-[9px] text-white/35">Atrasados</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setRomaneioMkp(transportadoraAtivaId)}
                  disabled={m.jaBipados === 0}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/[.1] bg-white/[.04] px-3 text-[11px] font-semibold text-white/60 transition hover:border-white/20 hover:bg-white/[.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <FileSpreadsheet size={14} />
                  Romaneio ({m.jaBipados})
                </button>
              </div>
            </section>

            {/* Posto de leitura */}
            <section className="border-b border-white/[.07] bg-[#0b0f14] px-4 py-5 sm:px-6">
              <div className="mx-auto max-w-5xl">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-9 w-9 items-center justify-center rounded-xl"
                      style={{ backgroundColor: `rgba(${mkp.accentRgb}, .14)`, color: mkp.accent }}
                    >
                      <ScanBarcode size={19} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-xs font-semibold text-white">Leitor pronto</h2>
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green shadow-[0_0_8px_rgba(62,207,142,.7)]" />
                      </div>
                      <p className="mt-0.5 text-[10px] text-white/35">Leia a etiqueta do pacote já conferido e embalado.</p>
                    </div>
                  </div>
                  <div className="hidden items-center gap-2 font-mono text-[9px] uppercase tracking-[0.13em] text-white/25 md:flex">
                    <span>Embalado</span><ArrowRight size={11} /><span style={{ color: mkp.accent }}>Bipado</span><ArrowRight size={11} /><span>Prateleira</span>
                  </div>
                </div>

                <form onSubmit={handleInputSubmit}>
                  <div
                    className="group/input relative flex items-center overflow-hidden rounded-2xl border bg-[#141a22] shadow-[0_14px_42px_rgba(0,0,0,.3)] transition focus-within:shadow-[0_16px_48px_rgba(0,0,0,.42)]"
                    style={{ borderColor: `rgba(${mkp.accentRgb}, .5)` }}
                  >
                    <ScanBarcode
                      size={21}
                      className="pointer-events-none absolute left-4 text-white/30 transition-colors group-focus-within/input:text-white/65"
                    />
                    <input
                      ref={inputRef}
                      type="text"
                      value={codigoInput}
                      onChange={(e) => setCodigoInput(e.target.value)}
                      placeholder={`Bipe a etiqueta do pacote para ${mkp.nome}`}
                      className="h-14 min-w-0 flex-1 bg-transparent pl-12 pr-3 font-mono text-sm text-white outline-none placeholder:text-white/25"
                    />
                    <button
                      type="submit"
                      className="mr-1.5 inline-flex h-11 shrink-0 items-center gap-2 rounded-xl px-5 text-xs font-bold shadow-lg transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                      style={{ backgroundColor: mkp.accent, color: mkp.accentForeground }}
                    >
                      Confirmar bip
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </form>

                {/* Feedback visual imediato do bip */}
                {ultimoResultado && (
                  <div
                    className={`mt-3 flex items-center justify-between rounded-xl border px-4 py-3 text-xs shadow-lg ${
                      ultimoResultado.tipo === "sucesso"
                        ? "border-green/30 bg-green/[.08]"
                        : ultimoResultado.tipo === "aviso"
                        ? "border-amber/30 bg-amber/[.08]"
                        : "border-red/30 bg-red/[.08]"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {ultimoResultado.tipo === "sucesso" && <CheckCircle2 size={18} className="shrink-0 text-green" />}
                      {ultimoResultado.tipo === "aviso" && <AlertTriangle size={18} className="shrink-0 text-amber" />}
                      {ultimoResultado.tipo === "erro" && <XCircle size={18} className="shrink-0 text-red" />}
                      <div className="min-w-0">
                        <span className="block font-bold tracking-wide text-white">{ultimoResultado.mensagem}</span>
                        {ultimoResultado.detalhe && (
                          <span className="mt-0.5 block truncate text-[10px] text-white/45">{ultimoResultado.detalhe}</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setUltimoResultado(null)}
                      className="ml-3 rounded-lg p-1.5 text-white/30 transition hover:bg-white/[.06] hover:text-white"
                      aria-label="Fechar aviso"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
              </div>
            </section>

            {/* Drawer de Simulação Rápida (Cenários Práticos) */}
            {mostrarSimulador && (
              <div className="border-b border-border bg-elevated/40 px-6 py-2.5">
                <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-faint">
                    Simular Bip para {mkp.nome}:
                  </span>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {transportadoraAtivaId === "meli" && (
                      <>
                        <button
                          type="button"
                          onClick={() => processarBip("ETQ-803-MELI")}
                          className="rounded border border-amber-400/50 bg-amber-400/15 px-2.5 py-1 font-medium text-amber-300 hover:bg-amber-400/25"
                        >
                          + Bipar Coleta Hoje
                        </button>
                        <button
                          type="button"
                          onClick={() => processarBip("ETQ-804-MELI")}
                          className="rounded border border-amber-400/50 bg-amber-400/15 px-2.5 py-1 font-medium text-amber-300 hover:bg-amber-400/25"
                        >
                          + Bipar Agendado c/ NF
                        </button>
                        <button
                          type="button"
                          onClick={() => processarBip("ETQ-805-MELI")}
                          className="rounded border border-amber-400/50 bg-amber-400/15 px-2.5 py-1 font-medium text-amber-300 hover:bg-amber-400/25"
                        >
                          + Bipar Atrasado
                        </button>
                      </>
                    )}

                    {transportadoraAtivaId === "shopee" && (
                      <>
                        <button
                          type="button"
                          onClick={() => processarBip("ETQ-811-SPX")}
                          className="rounded border border-orange-500/50 bg-orange-500/15 px-2.5 py-1 font-medium text-orange-400 hover:bg-orange-500/25"
                        >
                          + Bipar Coleta Hoje
                        </button>
                        <button
                          type="button"
                          onClick={() => processarBip("ETQ-812-SPX")}
                          className="rounded border border-orange-500/50 bg-orange-500/15 px-2.5 py-1 font-medium text-orange-400 hover:bg-orange-500/25"
                        >
                          + Bipar Atrasado
                        </button>
                      </>
                    )}

                    {transportadoraAtivaId === "magalu" && (
                      <>
                        <button
                          type="button"
                          onClick={() => processarBip("ETQ-821-MGL")}
                          className="rounded border border-blue-500/50 bg-blue-500/15 px-2.5 py-1 font-medium text-blue-400 hover:bg-blue-500/25"
                        >
                          + Bipar Atrasado
                        </button>
                        <button
                          type="button"
                          onClick={() => processarBip("ETQ-822-MGL")}
                          className="rounded border border-blue-500/50 bg-blue-500/15 px-2.5 py-1 font-medium text-blue-400 hover:bg-blue-500/25"
                        >
                          + Bipar Agendado c/ NF
                        </button>
                      </>
                    )}

                    {transportadoraAtivaId === "total_express" && (
                      <>
                        <button
                          type="button"
                          onClick={() => processarBip("ETQ-831-TOT")}
                          className="rounded border border-cyan-500/50 bg-cyan-500/15 px-2.5 py-1 font-medium text-cyan-400 hover:bg-cyan-500/25"
                        >
                          + Bipar Coleta Hoje
                        </button>
                        <button
                          type="button"
                          onClick={() => processarBip("ETQ-832-TOT")}
                          className="rounded border border-cyan-500/50 bg-cyan-500/15 px-2.5 py-1 font-medium text-cyan-400 hover:bg-cyan-500/25"
                        >
                          + Bipar Atrasado
                        </button>
                      </>
                    )}

                    {/* Teste de erro: pacote de OUTRA transportadora */}
                    <button
                      type="button"
                      onClick={() => {
                        // Dispara código da Shopee se estiver no Meli, ou do Meli se estiver na Shopee
                        const codigoErrado = transportadoraAtivaId === "meli" ? "ETQ-811-SPX" : "ETQ-803-MELI";
                        processarBip(codigoErrado);
                      }}
                      className="rounded border border-red/50 bg-red/15 px-2.5 py-1 font-medium text-red hover:bg-red/25"
                      title="Simula bipar pacote de outra transportadora por engano"
                    >
                      ⚠ Bipar Pacote de Outro Canal
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Pedidos do posto */}
            <div className="flex flex-1 flex-col overflow-hidden bg-[#0d1117] px-4 py-4 sm:px-6">
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/[.08] pb-3">
                <div>
                  <span className="block text-[9px] font-semibold uppercase tracking-[0.18em] text-white/30">Fila do posto</span>
                  <div className="mt-2 inline-flex rounded-xl border border-white/[.08] bg-black/20 p-1">
                    <button
                      type="button"
                      onClick={() => setAbaConferencia("pendentes")}
                      style={abaConferencia === "pendentes" ? { backgroundColor: mkp.accent, color: mkp.accentForeground } : undefined}
                      className={`rounded-lg px-4 py-2 text-[11px] font-semibold transition ${
                        abaConferencia === "pendentes"
                          ? "shadow-[0_5px_18px_rgba(0,0,0,.24)]"
                          : "text-white/40 hover:bg-white/[.05] hover:text-white/75"
                      }`}
                    >
                      Aguardando bipagem <span className="ml-1 font-mono">({m.faltandoBipar})</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setAbaConferencia("bipados")}
                      className={`rounded-lg px-4 py-2 text-[11px] font-semibold transition ${
                        abaConferencia === "bipados"
                          ? "bg-green text-[#07150f] shadow-[0_5px_18px_rgba(0,0,0,.24)]"
                          : "text-white/40 hover:bg-white/[.05] hover:text-white/75"
                      }`}
                    >
                      Ag. Embarque <span className="ml-1 font-mono">({m.jaBipados})</span>
                    </button>
                  </div>
                </div>

                <label className="group/search relative w-full sm:w-72">
                  <Search size={14} className="pointer-events-none absolute left-3 top-2.5 text-white/25 transition-colors group-focus-within/search:text-white/60" />
                  <input
                    type="text"
                    value={filtroTexto}
                    onChange={(e) => setFiltroTexto(e.target.value)}
                    placeholder="Pedido, NF ou cliente"
                    className="h-9 w-full rounded-xl border border-white/[.08] bg-white/[.035] pl-9 pr-8 text-xs text-white outline-none transition placeholder:text-white/25 focus:border-white/20 focus:bg-white/[.055]"
                  />
                  {filtroTexto && (
                    <button
                      type="button"
                      onClick={() => setFiltroTexto("")}
                      className="absolute right-2 top-1.5 rounded-md p-1 text-white/25 hover:bg-white/[.06] hover:text-white"
                      aria-label="Limpar filtro"
                    >
                      <X size={12} />
                    </button>
                  )}
                </label>
              </div>

              <div className="flex-1 overflow-auto pt-3">
                {pedidosConferenciaFiltrados.length === 0 ? (
                  <div className="flex h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-white/[.1] bg-white/[.018] text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[.045] text-white/30">
                      {abaConferencia === "pendentes" ? <ScanBarcode size={19} /> : <CheckCircle2 size={19} />}
                    </div>
                    <strong className="mt-3 text-xs font-semibold text-white/60">
                      {abaConferencia === "pendentes" ? "Fila de bipagem concluída" : "Nenhum pedido aguardando embarque"}
                    </strong>
                    <span className="mt-1 text-[10px] text-white/30">
                      {abaConferencia === "pendentes"
                        ? "Todos os pedidos deste marketplace já foram bipados."
                        : "Os pedidos bipados aparecerão aqui."}
                    </span>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-white/[.08] bg-[#11161d] shadow-[0_16px_42px_rgba(0,0,0,.2)]">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[920px] border-collapse text-left text-xs">
                        <thead>
                          <tr className="border-b border-white/[.08] bg-white/[.025] font-mono text-[9px] uppercase tracking-[0.12em] text-white/30">
                            <th className="px-4 py-3.5">Pedido</th>
                            <th className="px-4 py-3.5">Coleta</th>
                            <th className="px-4 py-3.5">NF Venda</th>
                            <th className="px-4 py-3.5">Cliente</th>
                            <th className="px-4 py-3.5">Status do pedido</th>
                            <th className="px-4 py-3.5">Conferido às</th>
                            <th className="px-4 py-3.5 text-right">
                              {abaConferencia === "bipados" ? "Bipado às" : "Ação"}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[.055] font-mono">
                          {pedidosConferenciaFiltrados.map((p) => (
                            <tr key={p.id} className="transition-colors hover:bg-white/[.035]">
                              <td className="px-4 py-3.5 font-semibold text-white">{p.pedido}</td>
                              <td className="px-4 py-3.5">
                                <span
                                  className={`inline-flex rounded-md border px-2 py-1 text-[8px] font-semibold uppercase tracking-wider ${
                                    p.tipoColeta === "atrasado"
                                      ? "border-red/25 bg-red/10 text-red-200"
                                      : p.tipoColeta === "agendado_com_nf"
                                      ? "border-cyan-400/20 bg-cyan-400/[.08] text-cyan-200"
                                      : "border-white/[.08] bg-white/[.03] text-white/40"
                                  }`}
                                >
                                  {p.tipoColeta === "atrasado"
                                    ? "Atrasado"
                                    : p.tipoColeta === "agendado_com_nf"
                                    ? "Agendado c/ NF"
                                    : "Coleta hoje"}
                                </span>
                              </td>
                              <td className="px-4 py-3.5 text-white/45">{p.nf}</td>
                              <td className="max-w-[220px] truncate px-4 py-3.5 font-body text-white/55">{p.cliente}</td>
                              <td className="px-4 py-3.5">
                                <span
                                  className={`inline-flex items-center gap-1.5 text-[10px] font-medium ${
                                    p.status === "Ag. Embarque" ? "text-green" : "text-white/50"
                                  }`}
                                >
                                  <span className={`h-1.5 w-1.5 rounded-full ${p.status === "Ag. Embarque" ? "bg-green" : "bg-amber"}`} />
                                  {p.status}
                                </span>
                              </td>
                              <td className="px-4 py-3.5 text-white/35">{p.horarioConferencia}</td>
                              <td className="px-4 py-3.5 text-right">
                                {p.status === "Ag. Embarque" ? (
                                  <div className="flex items-center justify-end gap-2">
                                    <div>
                                      <span className="block font-semibold text-green">{p.horarioDespacho}</span>
                                      <span className="mt-0.5 block font-body text-[8px] text-white/25">{p.operadorDespacho}</span>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => estornarPedido(p.id)}
                                      className="rounded-lg p-1.5 text-white/25 transition hover:bg-red/10 hover:text-red"
                                      title="Estornar bipagem e retirar da prateleira"
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => processarBip(p.barcode)}
                                    className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold transition hover:brightness-110"
                                    style={{
                                      borderColor: `rgba(${mkp.accentRgb}, .35)`,
                                      backgroundColor: `rgba(${mkp.accentRgb}, .1)`,
                                      color: mkp.accent,
                                    }}
                                  >
                                    <ScanBarcode size={12} />
                                    Bipar pedido
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ========================================================================= */}
      {/* MODAL DE ROMANEIO DE COLETA                                               */}
      {/* ========================================================================= */}
      {romaneioMkp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
            {/* Topo do Romaneio */}
            <div className="flex items-center justify-between border-b border-border bg-elevated px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-28 items-center justify-center">
                  <img
                    src={MARKETPLACES[romaneioMkp].logoSrc}
                    alt={MARKETPLACES[romaneioMkp].nome}
                    className="max-h-full max-w-full object-contain filter drop-shadow"
                  />
                </div>
                <div>
                  <h3 className="font-display text-base font-bold text-text">
                    Romaneio da Prateleira de Coleta
                  </h3>
                  <span className="font-mono text-xs text-text-faint">
                    Transportadora: <strong>{MARKETPLACES[romaneioMkp].nomeTransportadora}</strong>
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRomaneioMkp(null)}
                className="rounded-lg p-1.5 text-text-faint hover:bg-surface hover:text-text"
              >
                <X size={18} />
              </button>
            </div>

            {/* Conteúdo do Romaneio */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4 text-xs">
              {/* Cards de Resumo */}
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-elevated/40 p-3.5">
                <div>
                  <span className="text-[10px] uppercase text-text-faint font-semibold">
                    Emissão / Coleta:
                  </span>
                  <p className="mt-0.5 font-mono font-medium text-text">
                    {new Date().toLocaleDateString("pt-BR")} às {new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                <div>
                  <span className="text-[10px] uppercase text-text-faint font-semibold">
                    Pedidos em Ag. Embarque:
                  </span>
                  <p className="mt-0.5 font-mono text-base font-bold text-green">
                    {pedidosDoRomaneio.length} pedidos
                  </p>
                </div>
              </div>

              {/* Tabela detalhada dos pedidos bipados */}
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-border bg-elevated/80 font-mono text-[10px] uppercase text-text-faint">
                      <th className="p-2.5">Pedido</th>
                      <th className="p-2.5">Tipo</th>
                      <th className="p-2.5">NF Venda</th>
                      <th className="p-2.5">Cliente</th>
                      <th className="p-2.5 text-right">Bipado às</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50 font-mono">
                    {pedidosDoRomaneio.map((p) => (
                      <tr key={p.id} className="hover:bg-elevated/30">
                        <td className="p-2.5 font-bold text-text">{p.pedido}</td>
                        <td className="p-2.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                              p.tipoColeta === "atrasado"
                                ? "bg-red/20 text-red"
                                : p.tipoColeta === "agendado_com_nf"
                                ? "bg-cyan-500/20 text-cyan-300"
                                : "bg-elevated text-text-faint"
                            }`}
                          >
                            {p.tipoColeta === "atrasado"
                              ? "Atrasado"
                              : p.tipoColeta === "agendado_com_nf"
                              ? "Agend. c/ NF"
                              : "Coleta Hoje"}
                          </span>
                        </td>
                        <td className="p-2.5 text-text-faint">{p.nf}</td>
                        <td className="p-2.5 font-body text-text-muted truncate max-w-[160px]">
                          {p.cliente}
                        </td>
                        <td className="p-2.5 text-right text-text-faint">{p.horarioDespacho}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Assinatura do responsável pela bipagem */}
              <div className="pt-4 border-t border-border">
                <div className="max-w-md mx-auto rounded-xl border border-dashed border-border p-3.5 bg-elevated/20">
                  <span className="block text-[10px] uppercase font-semibold text-text-faint text-center">
                    Responsável pela Bipagem (CD):
                  </span>
                  <div className="h-12 border-b border-text-faint/40 mt-4 flex items-end justify-center pb-1 font-display text-sm font-bold text-text">
                    Rafael Silva
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[10px] text-text-faint px-2">
                    <span>Prateleira de Coleta B2C</span>
                    <span>Visto / Confirmação CD</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Rodapé do Modal */}
            <div className="flex items-center justify-end gap-2.5 border-t border-border bg-elevated px-6 py-3.5">
              <button
                type="button"
                onClick={() => setRomaneioMkp(null)}
                className="rounded-lg border border-border bg-surface px-4 py-2 text-xs font-medium text-text hover:bg-surface/80"
              >
                Voltar
              </button>
              <button
                type="button"
                onClick={() => {
                  window.print();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber px-4 py-2 font-display text-xs font-bold text-void hover:brightness-110 shadow"
              >
                <Printer size={14} />
                Imprimir Romaneio
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
