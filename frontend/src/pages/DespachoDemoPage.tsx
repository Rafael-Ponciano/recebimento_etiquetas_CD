import { useState, useRef, useEffect, useMemo, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import type { Pedido } from "../types/pedido";
import { classificarMkp } from "../lib/marketplace";
import { ehStatusCancelado } from "../lib/regras";
import { diaLocalHoje } from "../lib/filtrosPedidos";
import {
  Truck,
  ScanBarcode,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RotateCcw,
  Volume2,
  VolumeX,
  Printer,
  X,
  FileSpreadsheet,
  Undo2,
  Loader2,
  ArrowLeft,
  Search,
} from "lucide-react";
import RomaneiosExpedidosTab from "../components/RomaneiosExpedidosTab";

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
  status: "Conferido" | "Ag. Embarque" | "Pendente" | "Cancelado";
  tipoColeta: TipoColeta;
  horarioDespacho?: string;
  operadorDespacho?: string;
}

interface BloqueioBip {
  tipo: "duplicado" | "nao_localizado" | "outro_mkp" | "cancelado" | "pendente" | "agendado_sem_nf" | "erro_servidor";
  titulo: string;
  mensagem: string;
  orientacao: string;
  codigoLido?: string;
  pedido?: PedidoDespacho;
  mkpEsperado?: string;
  mkpPacote?: string;
}

function normalizarNumeroNf(valor: string): string {
  const digitos = valor.replace(/\D/g, "");
  return digitos.replace(/^0+/, "") || (digitos ? "0" : "");
}

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
  const [pedidos, setPedidos] = useState<PedidoDespacho[]>([]);
  const bipEmAndamentoRef = useRef(false);

  // Carrega pedidos da API
  const {
    data: pedidosData,
    isLoading: carregandoPedidos,
    isError: erroAoCarregarPedidos,
    refetch: recarregarPedidos,
  } = useQuery({
    queryKey: ["pedidos", "lista"],
    queryFn: async () => {
      const res = await api.get<{ items: Pedido[]; total: number }>("/pedidos");
      return res.data.items;
    },
    // Este cache é compartilhado com PedidosPage e DashboardPage: o valor
    // precisa ser sempre Pedido[], independentemente de qual tela abriu primeiro.
    staleTime: 60_000,
  });

  // Carrega histórico de despachos recentes para marcar horários/operadores de pedidos já bipados
  const {
    data: despachosData,
    isError: erroAoCarregarDespachos,
    refetch: recarregarDespachos,
  } = useQuery({
    queryKey: ["despachos-recentes"],
    queryFn: async () => {
      const res = await api.get<{
        items: Array<{ id: number; usuario: string; tipo_acao: string; detalhes: string; pedido_id: string; created_at: string }>;
      }>("/pedidos/despachos/recentes?limite=1000");
      return res.data;
    },
    staleTime: 15_000,
  });

  // Sub-aba ativa na visualização principal ("postos" = postos de bipagem, "romaneios" = histórico expedido)
  const [abaAtiva, setAbaAtiva] = useState<"postos" | "romaneios">("postos");

  // Transportadora selecionada para a tela de conferência dedicada
  // Se null -> exibe a tela principal com os 4 cards
  const [transportadoraAtivaId, setTransportadoraAtivaId] = useState<MarketplaceId | null>(null);
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
  const [processandoEstorno, setProcessandoEstorno] = useState<string | null>(null);
  const [confirmandoDespacho, setConfirmandoDespacho] = useState(false);
  const [confirmarRomaneioAberto, setConfirmarRomaneioAberto] = useState(false);

  // Trava / Modal de Bloqueio Impeditivo da Bipagem
  const [bloqueioAtivo, setBloqueioAtivo] = useState<BloqueioBip | null>(null);

  const fecharBloqueio = () => {
    setBloqueioAtivo(null);
    setCodigoInput("");
    window.setTimeout(() => inputRef.current?.focus(), 50);
  };

  // Trava teclado: enquanto o modal de bloqueio estiver aberto, Enter/Espaço/Esc fecha o modal;
  // qualquer outro caractere disparado pelo leitor ótico é bloqueado.
  useEffect(() => {
    if (!bloqueioAtivo) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        fecharBloqueio();
      } else {
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [bloqueioAtivo]);

  // Registros locais de bipagem e estorno para evitar que refetches em segundo plano
  // revertam o estado da linha e causem efeito de "piscada" na tabela
  const despachadosLocalRef = useRef<Map<string, { horario: string; operador: string }>>(new Map());
  const estornadosLocalRef = useRef<Set<string>>(new Set());

  // Foco permanente no input de bipagem sempre que estiver dentro de uma transportadora (se nenhum modal estiver aberto)
  useEffect(() => {
    if (transportadoraAtivaId && !bloqueioAtivo && !confirmarRomaneioAberto && !romaneioMkp) {
      inputRef.current?.focus();
    }
  }, [transportadoraAtivaId, ultimoResultado, bloqueioAtivo, confirmarRomaneioAberto, romaneioMkp]);

  // Sincroniza dados do backend com a lista de pedidos da expedição
  useEffect(() => {
    if (!pedidosData) return;

    const despachosMap = new Map<string, { horario: string; operador: string }>();
    const pedidosComEventoProcessado = new Set<string>();
    if (despachosData?.items) {
      for (const item of despachosData.items) {
        if (!item.pedido_id || pedidosComEventoProcessado.has(item.pedido_id)) continue;
        pedidosComEventoProcessado.add(item.pedido_id);
        if (item.tipo_acao === "DESPACHO") {
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

    const convertidos = new Map<string, PedidoDespacho>();
    for (const p of pedidosData) {
      const idStr = String(p.id_any ?? "").trim();
      if (!idStr || convertidos.has(idStr)) continue;

      const mkp = classificarMkp(p.Mkp);
      let marketplace: MarketplaceId | null = null;
      if (mkp === "meli") marketplace = "meli";
      else if (mkp === "shopee") marketplace = "shopee";
      else if (mkp === "magalu") marketplace = "magalu";
      else if (mkp === "tray") marketplace = "total_express";
      if (!marketplace) continue;

      const stAny = (p["Status Any"] ?? "").trim();
      const stAnyNormalizado = stAny.toLocaleLowerCase("pt-BR");
      const stCd = (p["Status CD"] ?? "").trim();

      // Enviado/Entregue já saíram da operação do CD. Continuam disponíveis
      // na tela geral de Pedidos, mas não pertencem à fila de despacho.
      if (stAnyNormalizado === "enviado" || stAnyNormalizado === "entregue") continue;

      const foiDespachadoLocal = despachadosLocalRef.current.get(idStr);
      const foiEstornadoLocal = estornadosLocalRef.current.has(idStr);

      let status: "Conferido" | "Ag. Embarque" | "Pendente" | "Cancelado" = "Pendente";
      if (ehStatusCancelado(stAny)) {
        status = "Cancelado";
      } else if (foiDespachadoLocal) {
        status = "Ag. Embarque";
      } else if (foiEstornadoLocal) {
        status = ["conferido", "recebido", "feito"].includes(stAnyNormalizado) ? "Conferido" : "Pendente";
      } else if (stAnyNormalizado === "ag. coleta" || stAnyNormalizado === "ag. coleta cd" || despachosMap.has(idStr)) {
        status = "Ag. Embarque";
      } else if (["conferido", "recebido", "feito"].includes(stAnyNormalizado)) {
        status = "Conferido";
      } else {
        status = "Pendente";
      }

      let tipoColeta: TipoColeta = "coleta_hoje";
      if (stCd.startsWith("Atrasado")) {
        tipoColeta = "atrasado";
      } else if (stCd.startsWith("Agendado")) {
        const temNfVenda = Boolean(String(p["NF Venda"] ?? "").trim());
        const statusLiberaAgendado = ["conferido", "recebido"].includes(stAnyNormalizado);
        const jaFoiBipado = status === "Ag. Embarque";
        tipoColeta = temNfVenda && (statusLiberaAgendado || jaFoiBipado)
          ? "agendado_com_nf"
          : "agendado_sem_conferencia";
      } else {
        tipoColeta = "coleta_hoje";
      }

      const infoDespacho = foiDespachadoLocal || (foiEstornadoLocal ? undefined : despachosMap.get(idStr));

      convertidos.set(idStr, {
        id: idStr,
        pedido: p.Pedido || p["Pedido Any"] || idStr,
        cliente: p.Cliente || "Cliente não informado",
        marketplace,
        nf: p["NF Venda"] ? String(p["NF Venda"]).trim() : "—",
        status,
        tipoColeta,
        horarioDespacho: infoDespacho?.horario,
        operadorDespacho: infoDespacho?.operador,
      });
    }

    setPedidos([...convertidos.values()]);
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
        enviados: number;
        percentual: number;
        pedidosBipados: PedidoDespacho[];
        pedidosPendentes: PedidoDespacho[];
      }
    > = {} as any;

    const hojeStr = diaLocalHoje();

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

      let enviados = 0;
      if (pedidosData) {
        for (const p of pedidosData) {
          const mkp = classificarMkp(p.Mkp);
          const mkpValido = id === "total_express" ? mkp === "tray" : mkp === id;
          if (!mkpValido) continue;
          const st = (p["Status Any"] ?? "").trim().toLowerCase();
          if (st === "enviado" || st === "entregue") {
            const diaColeta = (p["Data Coleta"] ?? "").slice(0, 10);
            if (diaColeta === hojeStr) {
              enviados++;
            }
          }
        }
      }

      const totalAExpedir = elegiveis.length;
      const jaBipados = pedidosBipados.length;
      const faltandoBipar = pedidosPendentes.length;
      const percentual = totalAExpedir > 0 ? Math.round((jaBipados / totalAExpedir) * 100) : 100;

      resultado[id] = {
        totalAExpedir,
        jaBipados,
        faltandoBipar,
        enviados,
        percentual,
        pedidosBipados,
        pedidosPendentes,
      };
    });

    return resultado;
  }, [pedidos, pedidosData]);

  // Estatísticas gerais do topo
  const totaisGerais = useMemo(() => {
    let totalExpedir = 0;
    let totalBipados = 0;
    let totalFaltando = 0;
    let totalEnviados = 0;

    Object.values(metricasPorMkp).forEach((m) => {
      totalExpedir += m.totalAExpedir;
      totalBipados += m.jaBipados;
      totalFaltando += m.faltandoBipar;
      totalEnviados += m.enviados;
    });

    const percentualGeral = totalExpedir > 0 ? Math.round((totalBipados / totalExpedir) * 100) : 100;
    return { totalExpedir, totalBipados, totalFaltando, totalEnviados, percentualGeral };
  }, [metricasPorMkp]);

  // Processamento do bip exclusivo da transportadora ativa
  const processarBip = async (codigoOriginal: string) => {
    const codigo = codigoOriginal.trim();
    if (!codigo) return;
    if (!transportadoraAtivaId) return;
    if (bloqueioAtivo) return;

    if (bipEmAndamentoRef.current) {
      if (somHabilitado) tocarBeep("aviso");
      setUltimoResultado({
        tipo: "aviso",
        mensagem: "AGUARDE O REGISTRO ATUAL",
        detalhe: "O último pacote ainda está sendo gravado. Bipe novamente quando o leitor estiver pronto.",
      });
      return;
    }

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

    const pedidoEncontrado = (() => {
      // Prioridade 1: Match dentro da transportadora ativa
      const matchAtiva = pedidos.find((p) => {
        if (p.marketplace !== transportadoraAtivaId) return false;
        const nfLimpa = normalizarNumeroNf(String(p.nf || ""));
        const idStr = String(p.id || "").trim();
        const pedStr = String(p.pedido || "").trim().toLowerCase();

        if (nfExtraida && nfLimpa === normalizarNumeroNf(nfExtraida)) return true;
        if (apenasDigitos && nfLimpa && nfLimpa === normalizarNumeroNf(apenasDigitos)) return true;
        if (idStr === codigo) return true;
        if (pedStr === codBusca) return true;
        return false;
      });
      if (matchAtiva) return matchAtiva;

      // Prioridade 2: Match global (para identificar e bloquear pacote de outro canal)
      return pedidos.find((p) => {
        const nfLimpa = normalizarNumeroNf(String(p.nf || ""));
        const idStr = String(p.id || "").trim();
        const pedStr = String(p.pedido || "").trim().toLowerCase();

        if (nfExtraida && nfLimpa === normalizarNumeroNf(nfExtraida)) return true;
        if (apenasDigitos && nfLimpa && nfLimpa === normalizarNumeroNf(apenasDigitos)) return true;
        if (idStr === codigo) return true;
        if (pedStr === codBusca) return true;
        return false;
      });
    })();

    if (!pedidoEncontrado) {
      if (somHabilitado) tocarBeep("erro");
      setBloqueioAtivo({
        tipo: "nao_localizado",
        titulo: "CÓDIGO NÃO LOCALIZADO NO SISTEMA",
        mensagem: nfExtraida
          ? `Chave NF-e lida com NF ${nfExtraida}, mas nenhum pedido correspondente foi encontrado para o dia de hoje.`
          : `Nenhum pedido foi encontrado para o código lido "${codigo}".`,
        orientacao: "Separe esta caixa física da bancada. Ela NÃO foi registrada na prateleira de coleta e deve ser verificada com a supervisão.",
        codigoLido: codigo,
      });
      return;
    }

    // Validação estrita: O pacote pertence a esta transportadora?
    if (pedidoEncontrado.marketplace !== transportadoraAtivaId) {
      if (somHabilitado) tocarBeep("erro");
      const mkpPedido = MARKETPLACES[pedidoEncontrado.marketplace];
      setBloqueioAtivo({
        tipo: "outro_mkp",
        titulo: `PACOTE DE OUTRA TRANSPORTADORA! (${mkpPedido.nome.toUpperCase()})`,
        mensagem: `Este pacote pertence ao canal ${mkpPedido.nome} (${mkpPedido.nomeTransportadora}). Você está conferindo exclusivamente ${transportadoraAtiva.nome}.`,
        orientacao: `NÃO COLOQUE NA PRATELEIRA! Separe esta caixa e leve-a para o posto de coleta correto de ${mkpPedido.nome}.`,
        codigoLido: codigo,
        pedido: pedidoEncontrado,
        mkpEsperado: transportadoraAtiva.nome,
        mkpPacote: mkpPedido.nome,
      });
      return;
    }

    if (pedidoEncontrado.status === "Cancelado") {
      if (somHabilitado) tocarBeep("erro");
      setBloqueioAtivo({
        tipo: "cancelado",
        titulo: "PEDIDO CANCELADO — RETENHA O PACOTE!",
        mensagem: `O pedido ${pedidoEncontrado.pedido} (NF ${pedidoEncontrado.nf}) foi cancelado pelo cliente ou marketplace.`,
        orientacao: "NÃO ENVIE À TRANSPORTADORA! Segure esta caixa física e encaminhe-a imediatamente para desmanche e devolução ao estoque.",
        codigoLido: codigo,
        pedido: pedidoEncontrado,
      });
      return;
    }

    if (pedidoEncontrado.status === "Ag. Embarque") {
      if (somHabilitado) tocarBeep("erro");
      setBloqueioAtivo({
        tipo: "duplicado",
        titulo: "ALERTA DE DUPLICIDADE — PACOTE JÁ REGISTRADO!",
        mensagem: `O pedido ${pedidoEncontrado.pedido} (NF ${pedidoEncontrado.nf}) já havia sido bipado às ${pedidoEncontrado.horarioDespacho || "—"} por ${pedidoEncontrado.operadorDespacho || "outro operador"}.`,
        orientacao: "RISCO DE ENVIO DUPLICADO! Verifique se já existe outra caixa física na prateleira com esta mesma etiqueta colada antes de liberar.",
        codigoLido: codigo,
        pedido: pedidoEncontrado,
      });
      return;
    }

    if (pedidoEncontrado.status === "Pendente") {
      if (somHabilitado) tocarBeep("erro");
      setBloqueioAtivo({
        tipo: "pendente",
        titulo: "PEDIDO NÃO CONFERIDO NA BANCADA!",
        mensagem: `O pedido ${pedidoEncontrado.pedido} (NF ${pedidoEncontrado.nf}) ainda não passou pela conferência física de itens.`,
        orientacao: "NÃO LEVE À PRATELEIRA! Esta caixa física foi embalada sem conferência. Encaminhe o pacote para a bancada de conferência.",
        codigoLido: codigo,
        pedido: pedidoEncontrado,
      });
      return;
    }

    if (pedidoEncontrado.tipoColeta === "agendado_sem_conferencia") {
      if (somHabilitado) tocarBeep("erro");
      setBloqueioAtivo({
        tipo: "agendado_sem_nf",
        titulo: "PEDIDO AGENDADO SEM NOTA FISCAL!",
        mensagem: `O pedido ${pedidoEncontrado.pedido} é agendado e ainda não possui emissão de NF de venda vinculada.`,
        orientacao: "NÃO LEVE À PRATELEIRA! Pedidos agendados sem emissão de NF não estão liberados para a coleta de hoje.",
        codigoLido: codigo,
        pedido: pedidoEncontrado,
      });
      return;
    }

    // Sucesso na bipagem: persiste no backend e atualiza status para Ag. Coleta
    bipEmAndamentoRef.current = true;
    try {
      await api.post(`/pedidos/${pedidoEncontrado.id}/registrar-despacho`, {
        marketplace: transportadoraAtivaId,
        chave_nfe: chaveNfe,
        nf_venda: pedidoEncontrado.nf,
      });

      const agora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const opNome = user?.nome || user?.usuario || "Operador";

      despachadosLocalRef.current.set(pedidoEncontrado.id, { horario: agora, operador: opNome });
      estornadosLocalRef.current.delete(pedidoEncontrado.id);

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

      void queryClient.invalidateQueries({ queryKey: ["pedidos"] });
      void queryClient.invalidateQueries({ queryKey: ["despachos-recentes"] });

      if (somHabilitado) tocarBeep("sucesso");
      setUltimoResultado({
        tipo: "sucesso",
        mensagem: "BIPADO COM SUCESSO!",
        detalhe: `Pedido ${pedidoEncontrado.pedido} despachado por ${opNome} às ${agora}.`,
        pedido: pedidoEncontrado,
      });
    } catch (err: any) {
      if (somHabilitado) tocarBeep("erro");
      const detalheErro = err?.response?.data?.detail || err?.message || "Falha na comunicação com o servidor.";
      setBloqueioAtivo({
        tipo: "erro_servidor",
        titulo: "ERRO AO REGISTRAR DESPACHO NO SERVIDOR",
        mensagem: `Não foi possível registrar o despacho do pedido ${pedidoEncontrado.pedido}.`,
        orientacao: `${detalheErro}. Verifique a conexão com o servidor e tente bipar novamente.`,
        codigoLido: codigo,
        pedido: pedidoEncontrado,
      });
    } finally {
      bipEmAndamentoRef.current = false;
      setCodigoInput("");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const handleInputSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!codigoInput.trim()) return;
    processarBip(codigoInput);
    setCodigoInput("");
  };

  // Desfazer conferência/despacho (retira da prateleira e volta para Conferido na bancada)
  const estornarPedido = async (pedido: PedidoDespacho) => {
    const pedidoId = pedido.id;
    const confirmou = window.confirm(
      `Deseja desfazer a conferência/despacho do pedido ${pedido.pedido}?\n\n` +
        `• O pedido sairá da prateleira de embarque\n` +
        `• O status voltará para Conferido\n` +
        `• Ficará disponível novamente para aguardar bipagem`
    );
    if (!confirmou) return;

    // Atualização otimista imediata (0ms de espera no feedback)
    setProcessandoEstorno(pedidoId);
    estornadosLocalRef.current.add(pedidoId);
    despachadosLocalRef.current.delete(pedidoId);

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

    if (somHabilitado) tocarBeep("aviso");
    setUltimoResultado({
      tipo: "aviso",
      mensagem: "CONFERÊNCIA DESFEITA",
      detalhe: `Pedido ${pedido.pedido} retirado da prateleira e retornado para pendentes.`,
      pedido,
    });

    try {
      await api.post(`/pedidos/${pedidoId}/estornar-despacho`, {
        motivo: "Desfazer conferência solicitado pelo operador na tela de despacho",
      });
      void queryClient.invalidateQueries({ queryKey: ["pedidos"] });
      void queryClient.invalidateQueries({ queryKey: ["despachos-recentes"] });
    } catch (err: any) {
      if (somHabilitado) tocarBeep("erro");
      // Rollback se a requisição falhar
      estornadosLocalRef.current.delete(pedidoId);
      despachadosLocalRef.current.set(pedidoId, {
        horario: pedido.horarioDespacho || "—",
        operador: pedido.operadorDespacho || "Operador",
      });
      setPedidos((prev) =>
        prev.map((p) => (p.id === pedidoId ? { ...p, status: "Ag. Embarque" } : p))
      );
      setUltimoResultado({
        tipo: "erro",
        mensagem: "ERRO AO DESFAZER DESPACHO",
        detalhe: err?.response?.data?.detail || err?.message || "Falha na comunicação com o servidor.",
        pedido,
      });
    } finally {
      setProcessandoEstorno(null);
    }
  };

  const atualizarPedidos = () => {
    void Promise.all([recarregarPedidos(), recarregarDespachos()]);
    setUltimoResultado(null);
    setCodigoInput("");
    setFiltroTexto("");
  };

  const imprimirRomaneio = () => {
    const limparModoImpressao = () => document.body.classList.remove("imprimindo-romaneio-despacho");
    document.body.classList.add("imprimindo-romaneio-despacho");
    window.addEventListener("afterprint", limparModoImpressao, { once: true });
    window.print();
    window.setTimeout(limparModoImpressao, 1_000);
  };

  const confirmarDespachoRomaneio = async () => {
    if (!romaneioMkp || pedidosDoRomaneio.length === 0 || confirmandoDespacho) return;
    const mkpInfo = MARKETPLACES[romaneioMkp];
    const orderIds = pedidosDoRomaneio.map((p) => p.id);

    try {
      setConfirmandoDespacho(true);
      const pedidosDetalhes = pedidosDoRomaneio.map((p) => ({
        id: p.id,
        pedido: p.pedido,
        nf: p.nf,
        cliente: p.cliente,
        tipo_coleta: p.tipoColeta,
        horario_bip: p.horarioDespacho || "",
        operador_bip: p.operadorDespacho || "",
      }));

      const resp = await api.post<{ ok: boolean; codigo_romaneio?: string; total_sucesso?: number }>(
        "/pedidos/despachos/confirmar-romaneio",
        {
          order_ids: orderIds,
          marketplace: romaneioMkp,
          transportadora: mkpInfo.nomeTransportadora,
          pedidos_detalhes: pedidosDetalhes,
        }
      );

      orderIds.forEach((id) => despachadosLocalRef.current.delete(id));

      void queryClient.invalidateQueries({ queryKey: ["pedidos"] });
      void queryClient.invalidateQueries({ queryKey: ["despachos-recentes"] });
      void queryClient.invalidateQueries({ queryKey: ["romaneios-expedidos"] });

      if (somHabilitado) tocarBeep("sucesso");
      const codRomaneio = resp.data?.codigo_romaneio ? ` [${resp.data.codigo_romaneio}]` : "";
      setUltimoResultado({
        tipo: "sucesso",
        mensagem: `DESPACHO COLETADO COM SUCESSO!${codRomaneio}`,
        detalhe: `${orderIds.length} pedidos confirmados como Enviados para ${mkpInfo.nomeTransportadora}. Romaneio registrado no histórico.`,
      });

      setConfirmarRomaneioAberto(false);
      setRomaneioMkp(null);
    } catch (err: any) {
      if (somHabilitado) tocarBeep("erro");
      setConfirmarRomaneioAberto(false);
      const msgErro = err?.response?.data?.detail || err?.message || "Falha ao persistir status Enviado dos pedidos.";
      const ehBloqueio = msgErro.toLowerCase().includes("bloqueio") || msgErro.toLowerCase().includes("cancelado");
      setUltimoResultado({
        tipo: "erro",
        mensagem: ehBloqueio ? "BLOQUEIO IMPEDITIVO — PACOTE CANCELADO" : "ERRO AO CONFIRMAR DESPACHO",
        detalhe: msgErro,
      });
      void queryClient.invalidateQueries({ queryKey: ["pedidos"] });
    } finally {
      setConfirmandoDespacho(false);
    }
  };

  // Pedidos para o Romaneio de Coleta oficial
  const pedidosDoRomaneio = useMemo(() => {
    if (!romaneioMkp) return [];
    return metricasPorMkp[romaneioMkp]?.pedidosBipados || [];
  }, [romaneioMkp, metricasPorMkp]);

  // Listas de pedidos filtrados na tela de conferência da transportadora ativa
  const pedidosPendentesFiltrados = useMemo(() => {
    if (!transportadoraAtivaId) return [];
    const listaBase = metricasPorMkp[transportadoraAtivaId]?.pedidosPendentes || [];
    if (!filtroTexto.trim()) return listaBase;
    const busca = filtroTexto.toLowerCase();
    return listaBase.filter(
      (p) =>
        p.pedido.toLowerCase().includes(busca) ||
        p.nf.toLowerCase().includes(busca) ||
        p.cliente.toLowerCase().includes(busca)
    );
  }, [transportadoraAtivaId, metricasPorMkp, filtroTexto]);

  const pedidosBipadosFiltrados = useMemo(() => {
    if (!transportadoraAtivaId) return [];
    const listaBase = metricasPorMkp[transportadoraAtivaId]?.pedidosBipados || [];
    if (!filtroTexto.trim()) return listaBase;
    const busca = filtroTexto.toLowerCase();
    return listaBase.filter(
      (p) =>
        p.pedido.toLowerCase().includes(busca) ||
        p.nf.toLowerCase().includes(busca) ||
        p.cliente.toLowerCase().includes(busca)
    );
  }, [transportadoraAtivaId, metricasPorMkp, filtroTexto]);

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
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green/15 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-green border border-green/30">
                <span className="h-1.5 w-1.5 rounded-full bg-green animate-pulse" />
                DOCA OPERACIONAL
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
          {!transportadoraAtivaId && (
            <div className="mr-2 flex items-center rounded-lg border border-border bg-elevated p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setAbaAtiva("postos")}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition ${
                  abaAtiva === "postos"
                    ? "bg-surface text-amber font-semibold shadow-xs"
                    : "text-text-muted hover:text-text"
                }`}
              >
                <Truck size={13} />
                Postos de Bipagem
              </button>
              <button
                type="button"
                onClick={() => setAbaAtiva("romaneios")}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition ${
                  abaAtiva === "romaneios"
                    ? "bg-surface text-amber font-semibold shadow-xs"
                    : "text-text-muted hover:text-text"
                }`}
              >
                <FileSpreadsheet size={13} />
                Romaneios Expedidos
              </button>
            </div>
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
            onClick={atualizarPedidos}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-elevated px-2.5 text-xs text-text-muted hover:border-text-faint hover:text-text"
            title="Atualizar pedidos da expedição"
          >
            <RotateCcw size={13} className={carregandoPedidos ? "animate-spin" : ""} />
            Atualizar
          </button>
        </div>
      </header>

      {erroAoCarregarPedidos && (
        <div role="alert" className="border-b border-red/30 bg-red/[.08] px-6 py-2 text-xs text-red-100">
          Não foi possível carregar os pedidos. Verifique a conexão e use <strong>Atualizar</strong> para tentar novamente.
        </div>
      )}
      {!erroAoCarregarPedidos && erroAoCarregarDespachos && (
        <div role="status" className="border-b border-amber/25 bg-amber/[.07] px-6 py-2 text-xs text-amber-100">
          Pedidos carregados, mas os horários e operadores dos despachos anteriores estão temporariamente indisponíveis.
        </div>
      )}
      {carregandoPedidos && !pedidosData && (
        <div role="status" className="border-b border-cyan-400/20 bg-cyan-400/[.06] px-6 py-2 text-xs text-cyan-100">
          Carregando a fila real de expedição…
        </div>
      )}

      {/* ========================================================================= */}
      {/* CENÁRIO 1: TELA PRINCIPAL (POSTOS OU HISTÓRICO DE ROMANEIOS)             */}
      {/* ========================================================================= */}
      {!transportadoraAtivaId && abaAtiva === "romaneios" && (
        <RomaneiosExpedidosTab />
      )}

      {!transportadoraAtivaId && abaAtiva === "postos" && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Resumo das prateleiras de coleta */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-surface/30 px-4 py-2.5 sm:px-6">
            <div className="grid w-full grid-cols-2 gap-x-5 gap-y-2 lg:flex lg:w-auto lg:items-center lg:gap-6">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-text-faint">Total a Expedir:</span>
                <span className="font-mono font-bold text-text">{totaisGerais.totalExpedir}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="inline-block h-2 w-2 rounded-full bg-amber" />
                <span className="text-text-faint">Pendentes:</span>
                <span className="font-mono font-bold text-amber">
                  {totaisGerais.totalFaltando}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="inline-block h-2 w-2 rounded-full bg-green" />
                <span className="text-text-faint">AG Embarque:</span>
                <span className="font-mono font-bold text-green">{totaisGerais.totalBipados}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
                <span className="text-text-faint">Enviados:</span>
                <span className="font-mono font-bold text-cyan-400">{totaisGerais.totalEnviados}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-text-faint">Progresso:</span>
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

                    <div className="relative mt-7 flex items-end justify-between gap-4">
                      <div>
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
                          Pendentes
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
                        <div className="flex items-center gap-1.5 text-white/40">
                          <ScanBarcode size={12} className="text-amber" />
                          <span className="text-[9px] font-medium">Pendentes</span>
                        </div>
                        <strong className="mt-1 block font-mono text-lg font-medium text-white">{m.faltandoBipar}</strong>
                      </div>
                      <div className="px-3">
                        <div className="flex items-center gap-1.5 text-white/40">
                          <CheckCircle2 size={12} className="text-green" />
                          <span className="text-[9px] font-medium">AG Embarque</span>
                        </div>
                        <strong className="mt-1 block font-mono text-lg font-medium text-green">{m.jaBipados}</strong>
                      </div>
                      <div className="px-3 pr-0">
                        <div className="flex items-center gap-1.5 text-white/40">
                          <Truck size={12} className="text-cyan-400" />
                          <span className="text-[9px] font-medium">Enviados</span>
                        </div>
                        <strong className="mt-1 block font-mono text-lg font-medium text-white">{m.enviados}</strong>
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
                        <ScanBarcode size={14} /> Expedição
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
          <div className="flex flex-1 flex-col overflow-hidden bg-[#090d12]">
            {/* Contexto e progresso do posto (Barra única, compacta e contínua) */}
            <section
              className="relative shrink-0 overflow-hidden border-b border-white/[.08] bg-[#10151c] px-4 py-2.5 sm:px-6"
              style={{
                backgroundImage: `linear-gradient(110deg, rgba(${mkp.accentRgb}, .12), transparent 30%), linear-gradient(180deg, rgba(255,255,255,.02), transparent)`,
              }}
            >
              <div className="absolute inset-x-0 top-0 h-px" style={{ backgroundImage: `linear-gradient(90deg, ${mkp.accent}, transparent 55%)` }} />
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-24 shrink-0 items-center justify-center">
                    <img
                      src={mkp.logoSrc}
                      alt={mkp.nome}
                      className={`max-h-full max-w-full object-contain filter drop-shadow ${
                        transportadoraAtivaId === "meli"
                          ? "scale-[1.35]"
                          : transportadoraAtivaId === "shopee"
                          ? "scale-[1.25]"
                          : "scale-[1.0]"
                      }`}
                    />
                  </div>
                  <div className="h-6 w-px bg-white/[.09]" />
                  <div>
                    <span className="block text-[8px] font-semibold uppercase tracking-[0.2em] text-white/35">Prateleira</span>
                    <strong className="block text-xs font-semibold text-white/85">{mkp.nome}</strong>
                  </div>
                </div>

                <div className="flex min-w-[180px] flex-1 max-w-xs items-center gap-3">
                  <div className="flex-1">
                    <div className="flex justify-between text-[10px] font-mono">
                      <span className="text-white/40">Progresso</span>
                      <span className="font-semibold text-white">
                        {m.jaBipados} <span className="font-normal text-white/30">de</span> {m.totalAExpedir}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[.07]">
                      <div
                        className="h-full rounded-full transition-[width] duration-700"
                        style={{
                          width: `${m.percentual}%`,
                          backgroundColor: m.percentual === 100 ? "#3ecf8e" : mkp.accent,
                          boxShadow: `0 0 12px rgba(${mkp.accentRgb}, .4)`,
                        }}
                      />
                    </div>
                  </div>
                  <span className="font-display text-xl font-bold tracking-tight" style={{ color: m.percentual === 100 ? "#3ecf8e" : mkp.accent }}>
                    {m.percentual}%
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber/25 bg-amber/10 px-2.5 py-1 text-[11px] font-medium text-amber">
                    Pendentes: <strong className="font-mono font-bold text-white">{m.faltandoBipar}</strong>
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-green/25 bg-green/10 px-2.5 py-1 text-[11px] font-medium text-green">
                    AG Embarque: <strong className="font-mono font-bold text-white">{m.jaBipados}</strong>
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-medium text-cyan-200">
                    Enviados: <strong className="font-mono font-bold text-white">{m.enviados}</strong>
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setRomaneioMkp(transportadoraAtivaId)}
                  disabled={m.jaBipados === 0}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/[.1] bg-white/[.04] px-3 text-xs font-semibold text-white/70 transition hover:border-white/20 hover:bg-white/[.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <FileSpreadsheet size={13} />
                  Romaneio ({m.jaBipados})
                </button>
              </div>
            </section>

            {/* 2. Área de Bipagem Centralizada (Elemento principal com máximo destaque) */}
            <div className="shrink-0 border-b border-white/[.07] bg-[#0c1016] px-4 py-3 sm:px-6">
              <div className="mx-auto flex max-w-4xl flex-col items-center gap-2.5 sm:flex-row">
                {/* Input de Bipagem com borda amarela suave e glow */}
                <form onSubmit={handleInputSubmit} className="relative w-full flex-1">
                  <div
                    className="group/input relative flex items-center overflow-hidden rounded-xl border-2 bg-[#131922] shadow-[0_4px_24px_rgba(0,0,0,.35)] transition focus-within:border-amber focus-within:ring-2 focus-within:ring-amber/25"
                    style={{ borderColor: `rgba(${mkp.accentRgb}, .6)` }}
                  >
                    <div
                      className="flex h-11 w-11 shrink-0 items-center justify-center border-r border-white/[.08]"
                      style={{ backgroundColor: `rgba(${mkp.accentRgb}, .15)`, color: mkp.accent }}
                    >
                      <ScanBarcode size={20} />
                    </div>
                    <input
                      ref={inputRef}
                      type="text"
                      value={codigoInput}
                      onChange={(e) => setCodigoInput(e.target.value)}
                      placeholder="Bipar etiqueta do pacote (Leitor óptico)..."
                      className="h-11 min-w-0 flex-1 bg-transparent px-3.5 font-mono text-sm text-white outline-none placeholder:text-white/35"
                    />
                    <span className="mr-3 hidden rounded border border-white/[.12] bg-white/[.05] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-white/50 sm:inline-block">
                      Auto Enter
                    </span>
                  </div>
                </form>

                {/* Filtro de pesquisa textual */}
                <label className="group/search relative w-full sm:w-64">
                  <Search size={13} className="pointer-events-none absolute left-3 top-3.5 text-white/25 transition-colors group-focus-within/search:text-white/60" />
                  <input
                    type="text"
                    value={filtroTexto}
                    onChange={(e) => setFiltroTexto(e.target.value)}
                    placeholder="Pesquisar pedido, NF..."
                    className="h-11 w-full rounded-xl border border-white/[.08] bg-white/[.035] pl-8 pr-7 text-xs text-white outline-none transition placeholder:text-white/25 focus:border-white/20 focus:bg-white/[.055]"
                  />
                  {filtroTexto && (
                    <button
                      type="button"
                      onClick={() => setFiltroTexto("")}
                      className="absolute right-2.5 top-2.5 rounded-md p-1 text-white/25 hover:bg-white/[.06] hover:text-white"
                      aria-label="Limpar pesquisa"
                    >
                      <X size={12} />
                    </button>
                  )}
                </label>
              </div>

              {/* Feedback visual imediato do bip */}
              {ultimoResultado && (
                <div
                  className={`mx-auto mt-2.5 flex max-w-4xl items-center justify-between rounded-xl border px-3.5 py-2 text-xs shadow-md ${
                    ultimoResultado.tipo === "sucesso"
                      ? "border-green/30 bg-green/[.08]"
                      : ultimoResultado.tipo === "aviso"
                      ? "border-amber/30 bg-amber/[.08]"
                      : "border-red/30 bg-red/[.08]"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    {ultimoResultado.tipo === "sucesso" && <CheckCircle2 size={16} className="shrink-0 text-green" />}
                    {ultimoResultado.tipo === "aviso" && <AlertTriangle size={16} className="shrink-0 text-amber" />}
                    {ultimoResultado.tipo === "erro" && <XCircle size={16} className="shrink-0 text-red" />}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-bold tracking-wide text-white">{ultimoResultado.mensagem}</span>
                      {ultimoResultado.detalhe && (
                        <span className="text-[11px] text-white/50">{ultimoResultado.detalhe}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setUltimoResultado(null)}
                    className="ml-3 rounded-lg p-1 text-white/30 transition hover:bg-white/[.06] hover:text-white"
                    aria-label="Fechar aviso"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
            </div>

            {/* 3. As Duas Listas Lado a Lado */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-5">
              <div className="mx-auto grid max-w-6xl grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
                {/* Coluna 1: Pendentes */}
                <div className="flex min-h-[280px] max-h-[500px] flex-col overflow-hidden rounded-xl border border-white/[.08] bg-[#10141b] shadow-lg">
                  <div className="flex shrink-0 items-center justify-between border-b border-white/[.08] bg-white/[.02] px-3.5 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="flex h-5 w-5 items-center justify-center rounded-md bg-amber/10 text-amber">
                        <ScanBarcode size={13} />
                      </div>
                      <span className="text-xs font-semibold text-white">Pendentes</span>
                      <span
                        className="rounded px-1.5 py-0.5 font-mono text-[10px] font-bold"
                        style={{ backgroundColor: `rgba(${mkp.accentRgb}, .15)`, color: mkp.accent }}
                      >
                        {pedidosPendentesFiltrados.length}
                      </span>
                    </div>
                    <span className="text-[10px] text-white/35">Na bancada</span>
                  </div>

                  <div className="flex flex-1 flex-col overflow-y-auto">
                    {pedidosPendentesFiltrados.length === 0 ? (
                      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[.04] text-white/30">
                          <ScanBarcode size={16} />
                        </div>
                        <strong className="mt-2 text-xs font-medium text-white/60">
                          Fila de bipagem concluída
                        </strong>
                        <span className="mt-0.5 text-[10px] text-white/30">
                          {filtroTexto ? "Nenhum pedido pendente com este filtro." : "Todos os pedidos deste canal já foram bipados."}
                        </span>
                      </div>
                    ) : (
                      <table className="w-full border-collapse text-left text-xs">
                        <thead className="sticky top-0 z-10 border-b border-white/[.08] bg-[#10141b] font-mono text-[9px] uppercase tracking-wider text-white/30">
                          <tr>
                            <th className="px-3 py-2">Pedido</th>
                            <th className="px-2.5 py-2">Coleta</th>
                            <th className="px-2.5 py-2">NF Venda</th>
                            <th className="px-2.5 py-2">Cliente</th>
                            <th className="px-3 py-2 text-right">Ação</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[.04] font-mono">
                          {pedidosPendentesFiltrados.map((p) => (
                            <tr key={p.id} className="hover:bg-white/[.03]">
                              <td className="px-3 py-2 font-bold tracking-tight text-white">{p.pedido}</td>
                              <td className="px-2.5 py-2">
                                <span
                                  className={`inline-flex rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${
                                    p.tipoColeta === "atrasado"
                                      ? "border-red/35 bg-red/10 text-red"
                                      : p.tipoColeta === "agendado_com_nf"
                                      ? "border-cyan-400/25 bg-cyan-400/10 text-cyan-200"
                                      : "border-white/[.08] bg-white/[.02] text-white/40"
                                  }`}
                                >
                                  {p.tipoColeta === "atrasado"
                                    ? "Atrasado"
                                    : p.tipoColeta === "agendado_com_nf"
                                    ? "Agend. c/ NF"
                                    : "Coleta hoje"}
                                </span>
                              </td>
                              <td className="px-2.5 py-2 text-white/45">{p.nf}</td>
                              <td className="max-w-[130px] truncate px-2.5 py-2 font-body text-white/55" title={p.cliente}>{p.cliente}</td>
                              <td className="px-3 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => processarBip(p.nf !== "—" ? p.nf : (p.pedido || p.id))}
                                  className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[10px] font-bold transition hover:brightness-110 shadow-sm"
                                  style={{
                                    backgroundColor: mkp.accent,
                                    color: mkp.accentForeground,
                                  }}
                                >
                                  <ScanBarcode size={11} />
                                  Bipar
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                {/* Coluna 2: Ag. Embarque */}
                <div className="flex min-h-[280px] max-h-[500px] flex-col overflow-hidden rounded-xl border border-white/[.08] bg-[#10141b] shadow-lg">
                  <div className="flex shrink-0 items-center justify-between border-b border-white/[.08] bg-white/[.02] px-3.5 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="flex h-5 w-5 items-center justify-center rounded-md bg-green/10 text-green">
                        <CheckCircle2 size={13} />
                      </div>
                      <span className="text-xs font-semibold text-white">Ag. Embarque</span>
                      <span className="rounded bg-green/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-green">
                        {pedidosBipadosFiltrados.length}
                      </span>
                    </div>
                    <span className="text-[10px] text-white/35">Na prateleira</span>
                  </div>

                  <div className="flex flex-1 flex-col overflow-y-auto">
                    {pedidosBipadosFiltrados.length === 0 ? (
                      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[.04] text-white/30">
                          <CheckCircle2 size={16} />
                        </div>
                        <strong className="mt-2 text-xs font-medium text-white/60">
                          Nenhum pedido na prateleira
                        </strong>
                        <span className="mt-0.5 text-[10px] text-white/30">
                          {filtroTexto ? "Nenhum pedido com este filtro." : "Os pacotes bipados aparecerão aqui."}
                        </span>
                      </div>
                    ) : (
                      <table className="w-full border-collapse text-left text-xs">
                        <thead className="sticky top-0 z-10 border-b border-white/[.08] bg-[#10141b] font-mono text-[9px] uppercase tracking-wider text-white/30">
                          <tr>
                            <th className="px-3 py-2">Pedido</th>
                            <th className="px-2.5 py-2">NF Venda</th>
                            <th className="px-2.5 py-2">Cliente</th>
                            <th className="px-2.5 py-2">Bipado às</th>
                            <th className="px-3 py-2 text-right">Ação</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[.04] font-mono">
                          {pedidosBipadosFiltrados.map((p) => (
                            <tr key={p.id} className="hover:bg-white/[.03]">
                              <td className="px-3 py-2 font-bold text-white tracking-tight">{p.pedido}</td>
                              <td className="px-2.5 py-2 text-white/45">{p.nf}</td>
                              <td className="max-w-[130px] truncate px-2.5 py-2 font-body text-white/55" title={p.cliente}>{p.cliente}</td>
                              <td className="px-2.5 py-2">
                                <span className="font-semibold text-green text-xs">{p.horarioDespacho}</span>
                                <span className="block font-body text-[8px] text-white/30">{p.operadorDespacho}</span>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => estornarPedido(p)}
                                  disabled={processandoEstorno === p.id}
                                  className="inline-flex items-center gap-1 rounded-md border border-amber/30 bg-amber/10 px-2 py-0.5 text-[10px] font-semibold text-amber transition hover:border-amber/50 hover:bg-amber/20 disabled:cursor-wait disabled:opacity-50"
                                  title="Desfazer conferência deste pedido e retirar da prateleira"
                                >
                                  {processandoEstorno === p.id ? (
                                    <Loader2 size={10} className="animate-spin" />
                                  ) : (
                                    <Undo2 size={10} />
                                  )}
                                  <span>Desfazer</span>
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ========================================================================= */}
      {/* MODAL DE ROMANEIO DE COLETA                                               */}
      {/* ========================================================================= */}
      {romaneioMkp && (
        <div className="despacho-fundo-romaneio fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-xs sm:p-4">
          <div className="despacho-romaneio flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-soft bg-surface shadow-2xl shadow-black/60">
            {/* Topo do Romaneio */}
            <div className="flex shrink-0 items-center justify-between border-b border-border-soft bg-elevated/70 px-5 py-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-32 shrink-0 items-center justify-center overflow-visible">
                  <img
                    src={MARKETPLACES[romaneioMkp].logoSrc}
                    alt={MARKETPLACES[romaneioMkp].nome}
                    className={`max-h-full max-w-full object-contain filter drop-shadow ${
                      romaneioMkp === "meli"
                        ? "scale-[1.45]"
                        : romaneioMkp === "shopee"
                        ? "scale-[1.35]"
                        : "scale-[1.1]"
                    }`}
                  />
                </div>
                <div className="h-7 w-px bg-border-soft" />
                <div>
                  <h3 className="font-display text-sm font-bold text-text">
                    Romaneio da Prateleira de Coleta
                  </h3>
                  <span className="font-mono text-[11px] text-text-faint">
                    Transportadora: <strong className="text-text-muted">{MARKETPLACES[romaneioMkp].nomeTransportadora}</strong>
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRomaneioMkp(null)}
                className="despacho-nao-imprimir rounded-lg p-1 text-text-faint transition hover:bg-surface hover:text-text"
                aria-label="Fechar romaneio"
              >
                <X size={16} />
              </button>
            </div>

            {/* Conteúdo do Romaneio */}
            <div className="flex flex-1 flex-col overflow-y-auto px-5 py-3.5 space-y-3 text-xs">
              {/* Barra de Resumo no Topo */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-soft bg-elevated/30 px-3.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
                    Data:
                  </span>
                  <span className="font-mono text-xs font-medium text-text">
                    {new Date().toLocaleDateString("pt-BR")}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
                    Total em Ag. Embarque:
                  </span>
                  <span className="rounded-md border border-green/30 bg-green/10 px-2 py-0.5 font-mono text-xs font-bold text-green">
                    {pedidosDoRomaneio.length} {pedidosDoRomaneio.length === 1 ? "pedido" : "pedidos"}
                  </span>
                </div>
              </div>

              {/* Tabela detalhada dos pedidos bipados */}
              <div className="flex-1 overflow-hidden rounded-xl border border-border-soft bg-[#0e1218]">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-border-soft bg-elevated/70 font-mono text-[10px] uppercase tracking-wider text-text-faint">
                      <th className="px-3.5 py-2.5">Pedido</th>
                      <th className="px-3 py-2.5">Tipo</th>
                      <th className="px-3 py-2.5">NF Venda</th>
                      <th className="px-3 py-2.5">Cliente</th>
                      <th className="px-3.5 py-2.5 text-right">Bipado às</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-soft/60 font-mono text-xs">
                    {pedidosDoRomaneio.map((p) => (
                      <tr key={p.id} className="hover:bg-white/[.025]">
                        <td className="px-3.5 py-2 font-bold tracking-tight text-white">{p.pedido}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded-md border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                              p.tipoColeta === "atrasado"
                                ? "border-red/40 bg-red/15 text-red shadow-[0_0_8px_rgba(229,88,107,0.15)]"
                                : p.tipoColeta === "agendado_com_nf"
                                ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
                                : "border-border-soft bg-elevated text-text-muted"
                            }`}
                          >
                            {p.tipoColeta === "atrasado"
                              ? "Atrasado"
                              : p.tipoColeta === "agendado_com_nf"
                              ? "Agend. c/ NF"
                              : "Coleta Hoje"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-text-faint">{p.nf}</td>
                        <td className="max-w-[200px] truncate px-3 py-2 font-body text-text-muted" title={p.cliente}>
                          {p.cliente}
                        </td>
                        <td className="px-3.5 py-2 text-right font-semibold text-green">{p.horarioDespacho}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border-soft bg-elevated/60 text-[11px]">
                      <td colSpan={5} className="px-3.5 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-3 font-sans">
                          <div className="flex items-center gap-1.5">
                            <span className="text-text-faint">👤 Bipagem:</span>
                            <strong className="font-semibold text-text">
                              {user?.nome || user?.usuario || "Rafael Ponciano"}
                            </strong>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-text-faint">Prateleira:</span>
                            <strong className="font-semibold text-text">B2C</strong>
                          </div>
                          <div className="flex items-center gap-1 font-medium text-green">
                            <span>✓ Visto / Confirmação CD</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Rodapé do Modal */}
            <div className="despacho-nao-imprimir flex shrink-0 items-center justify-between gap-2.5 border-t border-border-soft bg-elevated/60 px-5 py-2.5">
              <div className="text-[11px] text-text-faint">
                {pedidosDoRomaneio.length > 0 ? (
                  <span>
                    Pronto para coleta: <strong className="font-mono font-bold text-white">{pedidosDoRomaneio.length}</strong> {pedidosDoRomaneio.length === 1 ? "pedido" : "pedidos"}
                  </span>
                ) : (
                  <span>Nenhum pedido bipado neste romaneio</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmarRomaneioAberto(false);
                    setRomaneioMkp(null);
                  }}
                  className="rounded-lg border border-border-soft bg-surface px-3.5 py-1.5 text-xs font-medium text-text-muted transition hover:bg-elevated hover:text-text"
                >
                  Voltar
                </button>
                <button
                  type="button"
                  onClick={imprimirRomaneio}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border-soft bg-elevated px-3.5 py-1.5 font-display text-xs font-semibold text-text shadow transition hover:bg-surface hover:text-white"
                >
                  <Printer size={13} />
                  Imprimir Romaneio
                </button>
                <button
                  type="button"
                  disabled={pedidosDoRomaneio.length === 0 || confirmandoDespacho}
                  onClick={() => setConfirmarRomaneioAberto(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 font-display text-xs font-bold text-white shadow transition hover:bg-emerald-500 active:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Confirmar que a transportadora coletou todos os pacotes deste romaneio"
                >
                  <Truck size={13} />
                  Confirmar Despacho ({pedidosDoRomaneio.length})
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmação de Despacho do Romaneio */}
      {confirmarRomaneioAberto && romaneioMkp && (
        <div className="despacho-nao-imprimir fixed inset-0 z-60 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
          <div className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-emerald-500/30 bg-surface shadow-2xl shadow-black/80">
            <div className="flex items-center gap-3 border-b border-border-soft bg-emerald-500/10 px-5 py-3.5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/20 text-emerald-400">
                <Truck size={20} />
              </div>
              <div>
                <h4 className="font-display text-sm font-bold text-white">
                  Confirmar Coleta da Transportadora
                </h4>
                <p className="text-[11px] text-text-faint">
                  {MARKETPLACES[romaneioMkp].nome} — {MARKETPLACES[romaneioMkp].nomeTransportadora}
                </p>
              </div>
            </div>

            <div className="space-y-3 p-5 text-xs">
              <p className="leading-relaxed text-text-muted">
                A transportadora coletou todos os{" "}
                <strong className="font-mono font-bold text-emerald-400">
                  {pedidosDoRomaneio.length} {pedidosDoRomaneio.length === 1 ? "pacote" : "pacotes"}
                </strong>{" "}
                deste romaneio?
              </p>
              <div className="space-y-1 rounded-xl border border-border-soft bg-elevated/40 p-3 text-[11px] text-text-faint">
                <p>
                  ✓ O status de todos esses pedidos será alterado para <strong className="font-semibold text-cyan">Enviado</strong>.
                </p>
                <p>
                  ✓ Eles serão removidos da fila da prateleira e somados aos enviados do dia.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border-soft bg-elevated/60 px-5 py-3">
              <button
                type="button"
                disabled={confirmandoDespacho}
                onClick={() => setConfirmarRomaneioAberto(false)}
                className="rounded-lg border border-border-soft bg-surface px-3.5 py-1.5 text-xs font-medium text-text-muted transition hover:bg-elevated hover:text-text disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={confirmandoDespacho}
                onClick={confirmarDespachoRomaneio}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 font-display text-xs font-bold text-white shadow transition hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50"
              >
                {confirmandoDespacho ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Confirmando...
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={13} />
                    Sim, Confirmar Despacho
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL DE BLOQUEIO IMPEDITIVO DA BIPAGEM (TRAVA UNIVERSAL)                */}
      {/* ========================================================================= */}
      {bloqueioAtivo && (
        <div className="despacho-nao-imprimir fixed inset-0 z-70 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md">
          <div
            className={`flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-[#0d1117] shadow-2xl shadow-black/90 ${
              bloqueioAtivo.tipo === "duplicado"
                ? "border-amber-500/80 shadow-amber-500/20"
                : bloqueioAtivo.tipo === "outro_mkp"
                ? "border-purple-500/80 shadow-purple-500/20"
                : bloqueioAtivo.tipo === "agendado_sem_nf"
                ? "border-cyan-500/80 shadow-cyan-500/20"
                : "border-red-500/80 shadow-red-500/25"
            }`}
          >
            {/* Topo do Modal */}
            <div
              className={`flex items-center gap-3.5 border-b px-5 py-4 ${
                bloqueioAtivo.tipo === "duplicado"
                  ? "border-amber-500/30 bg-amber-500/15 text-amber-300"
                  : bloqueioAtivo.tipo === "outro_mkp"
                  ? "border-purple-500/30 bg-purple-500/15 text-purple-300"
                  : bloqueioAtivo.tipo === "agendado_sem_nf"
                  ? "border-cyan-500/30 bg-cyan-500/15 text-cyan-300"
                  : "border-red-500/30 bg-red-500/20 text-red-300"
              }`}
            >
              <div
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border ${
                  bloqueioAtivo.tipo === "duplicado"
                    ? "border-amber-500/50 bg-amber-500/20 text-amber-400"
                    : bloqueioAtivo.tipo === "outro_mkp"
                    ? "border-purple-500/50 bg-purple-500/20 text-purple-300"
                    : bloqueioAtivo.tipo === "agendado_sem_nf"
                    ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-300"
                    : "border-red-500/50 bg-red-500/30 text-red-400"
                }`}
              >
                {bloqueioAtivo.tipo === "duplicado" ? (
                  <AlertTriangle size={26} />
                ) : bloqueioAtivo.tipo === "outro_mkp" ? (
                  <Truck size={26} />
                ) : bloqueioAtivo.tipo === "agendado_sem_nf" ? (
                  <FileSpreadsheet size={26} />
                ) : (
                  <XCircle size={26} />
                )}
              </div>
              <div className="min-w-0">
                <span className="inline-block font-mono text-[10px] font-bold uppercase tracking-wider opacity-80">
                  TRAVA DE SEGURANÇA — EXPEDIÇÃO
                </span>
                <h3 className="font-display text-base font-extrabold leading-tight text-white">
                  {bloqueioAtivo.titulo}
                </h3>
              </div>
            </div>

            {/* Conteúdo */}
            <div className="space-y-4 p-5 text-xs">
              <p className="text-sm font-medium leading-relaxed text-white/90">
                {bloqueioAtivo.mensagem}
              </p>

              {/* Box de Orientação Operacional Destacada */}
              <div
                className={`rounded-xl border p-3.5 text-xs font-semibold leading-relaxed ${
                  bloqueioAtivo.tipo === "duplicado"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : bloqueioAtivo.tipo === "outro_mkp"
                    ? "border-purple-500/40 bg-purple-500/10 text-purple-200"
                    : bloqueioAtivo.tipo === "agendado_sem_nf"
                    ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200"
                    : "border-red-500/40 bg-red-500/15 text-red-200"
                }`}
              >
                {bloqueioAtivo.orientacao}
              </div>

              {/* Informações detalhadas do pacote lido */}
              <div className="space-y-1.5 rounded-xl border border-white/[.08] bg-white/[.03] p-3 font-mono text-[11px] text-white/70">
                {bloqueioAtivo.codigoLido && (
                  <div className="flex justify-between gap-2">
                    <span className="text-white/40">Código / Chave lida:</span>
                    <strong className="break-all text-white select-all">{bloqueioAtivo.codigoLido}</strong>
                  </div>
                )}
                {bloqueioAtivo.pedido && (
                  <>
                    <div className="flex justify-between gap-2">
                      <span className="text-white/40">Pedido:</span>
                      <strong className="text-white">{bloqueioAtivo.pedido.pedido}</strong>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-white/40">NF Venda:</span>
                      <strong className="text-white">{bloqueioAtivo.pedido.nf}</strong>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-white/40">Cliente:</span>
                      <strong className="max-w-[220px] truncate text-white">{bloqueioAtivo.pedido.cliente}</strong>
                    </div>
                    {bloqueioAtivo.pedido.horarioDespacho && (
                      <div className="flex justify-between gap-2 border-t border-white/[.06] pt-1.5 text-amber-300">
                        <span>Bipado anteriormente às:</span>
                        <strong>{bloqueioAtivo.pedido.horarioDespacho} por {bloqueioAtivo.pedido.operadorDespacho || "operador"}</strong>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Rodapé com botão gigante de liberação */}
            <div className="border-t border-white/[.08] bg-white/[.02] p-4">
              <button
                type="button"
                autoFocus
                onClick={fecharBloqueio}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-white font-display text-sm font-bold text-black shadow-lg transition hover:bg-neutral-200 active:bg-neutral-300"
              >
                <CheckCircle2 size={18} />
                ENTENDIDO — LIBERAR LEITOR (Enter ou Espaço)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
