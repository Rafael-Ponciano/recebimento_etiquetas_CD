import type { Pedido } from "../types/pedido";
import { formatarFilial, normalizarParaBusca, textoUtil } from "./format";
import { classificarMkp, type MkpFixoId } from "./marketplace";
import {
  ehStatusCancelado,
  ehStatusFechadoCd,
  ehStatusParcial,
  type RegrasNegocio,
} from "./regras";

export type FiltroRapido =
  | "atrasados"
  | "coletaHoje"
  | "coletaHojePendentes"
  | "coletaHojePendentesSemCd"
  | "agendadosRecebidosCd"
  | "recebidosParcialmente"
  | "cancelados"
  | "soWd"
  | "soH7"
  | "soWdH7"
  | "wdParaConferir"
  | "vonixxParaConferir"
  | "erroNf"
  | "nfComErro"
  | "erroIntegracao";

export type FiltroOperacionalId =
  | "atrasados"
  | "coletaHoje"
  | "coletaHojePendentes"
  | "agendados"
  | "recebidosParcialmente"
  | "erroNf"
  | "nfComErro"
  | "emSeparacao"
  | "aConferir"
  | "conferidos"
  | "wdParaConferir"
  | "enviados"
  | "agColetaNoSeller"
  | "total";

export type CorFiltro = "red" | "amber" | "cyan" | "green" | "faint";

export type ContextoFiltrosPedidos = {
  regras: RegrasNegocio;
  idsPedidoSoWd: Set<string>;
  idsPedidoSoH7: Set<string>;
  idsPedidoSoWdH7: Set<string>;
  idsPedidoSoVonixx: Set<string>;
};

const STATUS_LOTE_CONFERIR = new Set(["em separação", "a conferir"]);
const NF_VAZIA = new Set(["", "nan", "none", "null", "-", "0", "0.0"]);

export function statusPermiteLoteConferir(status?: string | null) {
  return STATUS_LOTE_CONFERIR.has((status ?? "").trim().toLocaleLowerCase("pt-BR"));
}

export function nfPedidoPreenchida(p: Pedido): boolean {
  const texto = String(p["NF Venda"] ?? "").trim();
  if (!texto) return false;
  return !NF_VAZIA.has(texto.toLocaleLowerCase("pt-BR"));
}

let _offsetHorasTeste = 0;

/** Alinha filtros do front com OFFSET_HORAS_TESTE do backend. */
export function setOffsetHorasTeste(horas: number) {
  _offsetHorasTeste = Number.isFinite(horas) ? horas : 0;
}

export function diaLocalHoje(): string {
  const agora = new Date(Date.now() + _offsetHorasTeste * 3_600_000);
  const y = agora.getFullYear();
  const m = String(agora.getMonth() + 1).padStart(2, "0");
  const d = String(agora.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function classificarProdutoFiltro(
  item?: string | null
): "wd" | "h7" | "vonixx" | "outro" {
  const n = normalizarParaBusca(item ?? "");
  if (!n) return "outro";
  if (n.includes("vonixx")) {
    return "vonixx";
  }
  if (
    n.includes("wd40") ||
    n.includes("wd-40") ||
    n.includes("wd 40") ||
    (n.includes("desengripante") && n.includes("wd"))
  ) {
    return "wd";
  }
  if (
    n.includes("702358") ||
    n.includes("702366") ||
    (n.includes("desengraxante") && (n.includes("h7") || n.includes("h-7") || n.includes("h 7")))
  ) {
    return "h7";
  }
  return "outro";
}

export function indexarClassesProduto(pedidos: Pedido[]) {
  const porPedido = new Map<string, Set<"wd" | "h7" | "vonixx" | "outro">>();
  for (const p of pedidos) {
    const id = String(p.id_any ?? "").trim();
    if (!id) continue;
    const classes = porPedido.get(id) ?? new Set();
    classes.add(classificarProdutoFiltro(p.Item));
    porPedido.set(id, classes);
  }
  const soWd = new Set<string>();
  const soH7 = new Set<string>();
  const soWdH7 = new Set<string>();
  const soVonixx = new Set<string>();
  for (const [id, classes] of porPedido) {
    if (classes.size === 1 && classes.has("wd")) soWd.add(id);
    if (classes.size === 1 && classes.has("h7")) soH7.add(id);
    if (classes.size === 1 && classes.has("vonixx")) soVonixx.add(id);
    if (classes.size === 2 && classes.has("wd") && classes.has("h7")) soWdH7.add(id);
  }
  return {
    idsPedidoSoWd: soWd,
    idsPedidoSoH7: soH7,
    idsPedidoSoWdH7: soWdH7,
    idsPedidoSoVonixx: soVonixx,
  };
}

export const ehAtrasado = (p: Pedido) =>
  (p["Status CD"] ?? "").trim().startsWith("Atrasado");

export const ehColetaHoje = (p: Pedido) => {
  const status = (p["Status CD"] ?? "").trim();
  return status.startsWith("Coleta Hoje") || status.startsWith("📦");
};

export const ehAgendado = (p: Pedido) =>
  (p["Status CD"] ?? "").trim().startsWith("Agendado");

export const ehCancelado = (p: Pedido) => ehStatusCancelado(p["Status Any"]);

/** Sem NF Pedido e data de coleta hoje ou anterior (exceto cancelados). */
export const ehSemNf = (p: Pedido) => {
  if (ehCancelado(p)) return false;
  if (nfPedidoPreenchida(p)) return false;
  const diaColeta = (p["Data Coleta"] ?? "").slice(0, 10);
  if (!diaColeta) return false;
  return diaColeta <= diaLocalHoje();
};

export const ehNfComErro = (p: Pedido) => {
  if (ehCancelado(p) || ehEnviado(p)) return false;
  return (p.status_nf ?? "").trim().toUpperCase() === "FAILED";
};

export function ehColetaHojePendente(p: Pedido, regras: RegrasNegocio) {
  return ehColetaHoje(p) && !ehStatusFechadoCd(p["Status Any"], regras);
}

/** Filial do CD próprio (Peça Ai - CD SP) — fora do filtro Pendentes Hoje S/ CD. */
export function ehFilialPecaAiCdSp(p: Pedido): boolean {
  const filial = formatarFilial(p.filial_seller).toLocaleLowerCase("pt-BR");
  // Aceita variações leves de acento/espaçamento.
  const compacta = filial.replace(/\s+/g, " ").trim();
  return (
    compacta === "peça ai - cd sp" ||
    compacta === "peca ai - cd sp" ||
    compacta === "peça aí - cd sp" ||
    compacta === "peca aí - cd sp"
  );
}

/** Pendentes hoje excluindo filial Peça Ai - CD SP. */
export function ehColetaHojePendenteSemCd(p: Pedido, regras: RegrasNegocio) {
  if (ehFilialPecaAiCdSp(p)) return false;
  return ehColetaHojePendente(p, regras);
}

export function ehRecebidoParcialmente(p: Pedido, regras: RegrasNegocio) {
  return ehStatusParcial(p["Status Any"], regras);
}

/** Em separação com NF; ou pedido só WD/só H7 em separação (com/sem NF, qualquer status_pedido). */
export function ehEmSeparacaoComNf(p: Pedido, ctx: ContextoFiltrosPedidos) {
  const status = (p["Status Any"] ?? "").trim().toLocaleLowerCase("pt-BR");
  if (status !== "em separação") return false;
  const id = String(p.id_any ?? "").trim();
  if (ctx.idsPedidoSoWd.has(id) || ctx.idsPedidoSoH7.has(id)) return true;
  return nfPedidoPreenchida(p);
}

/** Em separação + NF Pedido vazia + status_pedido <> DELIVERED (só WD / só H7 vão para Separação). */
export function ehAgColetaNoSeller(p: Pedido, ctx: ContextoFiltrosPedidos) {
  if (ehCancelado(p)) return false;
  const statusAny = (p["Status Any"] ?? "").trim().toLocaleLowerCase("pt-BR");
  if (statusAny !== "em separação") return false;
  const id = String(p.id_any ?? "").trim();
  if (ctx.idsPedidoSoWd.has(id) || ctx.idsPedidoSoH7.has(id)) return false;
  if (nfPedidoPreenchida(p)) return false;
  const statusPedido = (p.status_pedido ?? "").trim().toUpperCase();
  if (statusPedido === "DELIVERED") return false;
  return true;
}

export function ehAConferir(p: Pedido) {
  const status = (p["Status Any"] ?? "").trim().toLocaleLowerCase("pt-BR");
  return status === "recebido" || status === "a conferir";
}

export function ehConferido(p: Pedido) {
  return (p["Status Any"] ?? "").trim() === "Conferido";
}

export function ehWdParaConferir(p: Pedido, ctx: ContextoFiltrosPedidos) {
  const id = String(p.id_any ?? "").trim();
  if (!ctx.idsPedidoSoWd.has(id) || !nfPedidoPreenchida(p)) return false;
  if (!statusPermiteLoteConferir(p["Status Any"])) return false;
  const diaColeta = (p["Data Coleta"] ?? "").slice(0, 10);
  if (!diaColeta) return false;
  return true;
}

/** Pedidos só Vonixx · com NF · Em separação/A conferir · coleta ≤ hoje. */
export function ehVonixxParaConferir(p: Pedido, ctx: ContextoFiltrosPedidos) {
  const id = String(p.id_any ?? "").trim();
  if (!ctx.idsPedidoSoVonixx.has(id) || !nfPedidoPreenchida(p)) return false;
  if (!statusPermiteLoteConferir(p["Status Any"])) return false;
  const diaColeta = (p["Data Coleta"] ?? "").slice(0, 10);
  if (!diaColeta) return false;
  return diaColeta <= diaLocalHoje();
}

/** Pedido (marketplace) ainda vazio e tempo de integração > 20 min. */
export function minutosTempoIntegracao(valor?: string | null): number | null {
  const texto = String(valor ?? "").trim();
  if (!texto) return null;
  const m = texto.match(/^(-?)(\d+):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const sinal = m[1] === "-" ? -1 : 1;
  const h = Number(m[2]);
  const min = Number(m[3]);
  const s = Number(m[4]);
  if (![h, min, s].every(Number.isFinite)) return null;
  return sinal * (h * 60 + min + s / 60);
}

export function ehErroIntegracao(p: Pedido): boolean {
  if (ehCancelado(p) || ehEnviado(p)) return false;
  if (textoUtil(p.Pedido)) return false;
  const minutos = minutosTempoIntegracao(p.tempo_integracao);
  return minutos != null && minutos > 20;
}

/** Coleta futura (Agendado) já recebida no CD (Status Any Recebido/FEITO). */
export function ehAgendadoRecebidoCd(p: Pedido, regras: RegrasNegocio): boolean {
  if (!ehAgendado(p) || ehCancelado(p)) return false;
  const status = (p["Status Any"] ?? "").trim().toLocaleLowerCase("pt-BR");
  if (!status) return false;
  return [regras.status_agendado, "Recebido", "FEITO", regras.sheets_status_feito]
    .filter(Boolean)
    .some((s) => s.toLocaleLowerCase("pt-BR") === status);
}

export function passaFiltroRapido(
  pedido: Pedido,
  f: FiltroRapido,
  ctx: ContextoFiltrosPedidos
): boolean {
  const id = String(pedido.id_any ?? "").trim();
  switch (f) {
    case "atrasados":
      return ehAtrasado(pedido);
    case "coletaHoje":
      return ehColetaHoje(pedido);
    case "coletaHojePendentes":
      return ehColetaHojePendente(pedido, ctx.regras);
    case "coletaHojePendentesSemCd":
      return ehColetaHojePendenteSemCd(pedido, ctx.regras);
    case "agendadosRecebidosCd":
      return ehAgendadoRecebidoCd(pedido, ctx.regras);
    case "recebidosParcialmente":
      return ehRecebidoParcialmente(pedido, ctx.regras);
    case "cancelados":
      return ehCancelado(pedido);
    case "soWd":
      return ctx.idsPedidoSoWd.has(id) && !ehCancelado(pedido) && !ehEnviado(pedido);
    case "soH7":
      return ctx.idsPedidoSoH7.has(id) && !ehCancelado(pedido) && !ehEnviado(pedido);
    case "soWdH7":
      return ctx.idsPedidoSoWdH7.has(id);
    case "wdParaConferir":
      return ehWdParaConferir(pedido, ctx);
    case "vonixxParaConferir":
      return ehVonixxParaConferir(pedido, ctx);
    case "erroNf":
      return ehSemNf(pedido);
    case "nfComErro":
      return ehNfComErro(pedido);
    case "erroIntegracao":
      return ehErroIntegracao(pedido);
    default:
      return true;
  }
}

export const FILTROS_OPERACIONAIS: Array<{
  id: FiltroOperacionalId;
  label: string;
  cor: CorFiltro;
  hint?: string;
}> = [
  { id: "atrasados", label: "Atrasados", cor: "red", hint: "Status CD atrasado" },
  { id: "coletaHoje", label: "Coleta Hoje", cor: "cyan", hint: "Coleta do dia" },
  {
    id: "coletaHojePendentes",
    label: "Pendentes Hoje",
    cor: "amber",
    hint: "Coleta hoje ainda aberta",
  },
  {
    id: "recebidosParcialmente",
    label: "Recebidos parcial",
    cor: "amber",
    hint: "Status Any parcial",
  },
  { id: "erroNf", label: "Sem NF", cor: "red", hint: "Sem NF Pedido · coleta ≤ hoje" },
  { id: "nfComErro", label: "Erro NF", cor: "red", hint: "status_nf = FAILED · sem cancelados/enviados" },
  {
    id: "emSeparacao",
    label: "Em separação",
    cor: "amber",
    hint: "Em separação com NF · ou pedido só WD / só H7 em separação",
  },
  { id: "aConferir", label: "A conferir", cor: "cyan", hint: "Status Any = Recebido ou A conferir" },
  { id: "conferidos", label: "Conferidos", cor: "green", hint: "Status Any" },
  {
    id: "wdParaConferir",
    label: "WD para conferir",
    cor: "green",
    hint: "Só WD · com NF · Em separação/A conferir",
  },
  { id: "total", label: "Total", cor: "faint", hint: "Pedidos carregados" },
];

/** Cards do resumo superior (visual Acompanhamento B2C). */
export const CARDS_RESUMO_VISUAL: Array<{
  id: FiltroOperacionalId;
  label: string;
  bg: string;
}> = [
  { id: "coletaHojePendentes", label: "Pendentes", bg: "#6C757D" },
  { id: "emSeparacao", label: "Em Separação", bg: "#FF8C00" },
  { id: "agColetaNoSeller", label: "AG Coleta No Seller", bg: "#FFD700" },
  { id: "aConferir", label: "A Conferir", bg: "#17A2B8" },
  { id: "atrasados", label: "Atrasados", bg: "#DC3545" },
  { id: "conferidos", label: "Conferidos", bg: "#28A745" },
  { id: "enviados", label: "Enviados", bg: "#007BFF" },
  { id: "total", label: "Total Pedidos", bg: "#C9C9C9" },
];

/** Métricas dentro de cada coluna de marketplace. */
export const CARDS_MKP_VISUAL: Array<{
  id: FiltroOperacionalId;
  label: string;
  bg: string;
}> = [
  { id: "emSeparacao", label: "Separação", bg: "#FF8C00" },
  { id: "agColetaNoSeller", label: "AG Coleta No Seller", bg: "#FFD700" },
  { id: "aConferir", label: "A Conferir", bg: "#17A2B8" },
  { id: "atrasados", label: "Atrasados", bg: "#DC3545" },
  { id: "conferidos", label: "Conferidos", bg: "#28A745" },
  { id: "total", label: "Total", bg: "#6C757D" },
];

const MKP_ORDEM = ["mercado livre", "magalu", "shopee", "tray"];

/** @deprecated Preferir MKPS_FIXOS do marketplace.ts no dashboard. */
export function listarMarketplaces(pedidos: Pedido[]): string[] {
  const set = new Set<string>();
  for (const p of pedidos) {
    const mkp = String(p.Mkp ?? "").trim();
    if (mkp) set.add(mkp);
  }
  return [...set].sort((a, b) => {
    const ia = MKP_ORDEM.indexOf(a.toLocaleLowerCase("pt-BR"));
    const ib = MKP_ORDEM.indexOf(b.toLocaleLowerCase("pt-BR"));
    if (ia >= 0 || ib >= 0) {
      return (ia >= 0 ? ia : 999) - (ib >= 0 ? ib : 999);
    }
    return a.localeCompare(b, "pt-BR");
  });
}

export function ehEnviado(p: Pedido) {
  return (p["Status Any"] ?? "").trim() === "Enviado";
}

/** Universo do dashboard "do dia": coleta no dia de referência ou atrasado. Sem cancelados. */
export function ehPedidoDoDia(p: Pedido, diaRef: string = diaLocalHoje()): boolean {
  if (ehCancelado(p)) return false;
  const status = (p["Status Any"] ?? "").trim();
  if (status === "Entregue") return false;
  const diaColeta = (p["Data Coleta"] ?? "").slice(0, 10);
  if (diaColeta === diaRef) return true;
  // Atrasados com coleta anterior ao dia selecionado
  if (ehAtrasado(p) && status !== "Enviado" && diaColeta && diaColeta < diaRef) return true;
  return false;
}

export function passaFiltroOperacional(
  pedido: Pedido,
  id: FiltroOperacionalId,
  ctx: ContextoFiltrosPedidos,
  diaRef: string = diaLocalHoje()
): boolean {
  if (ehCancelado(pedido)) return false;
  const diaColeta = (pedido["Data Coleta"] ?? "").slice(0, 10);
  switch (id) {
    case "atrasados":
      return ehAtrasado(pedido);
    case "coletaHoje":
      // No dia selecionado: usa Data Coleta (Status CD só reflete o dia real).
      return diaColeta === diaRef;
    case "coletaHojePendentes":
      return (
        diaColeta === diaRef && !ehStatusFechadoCd(pedido["Status Any"], ctx.regras)
      );
    case "agendados":
      return ehAgendado(pedido);
    case "recebidosParcialmente":
      return ehRecebidoParcialmente(pedido, ctx.regras);
    case "erroNf":
      return ehSemNf(pedido);
    case "nfComErro":
      return ehNfComErro(pedido);
    case "emSeparacao":
      return ehEmSeparacaoComNf(pedido, ctx);
    case "agColetaNoSeller":
      return ehAgColetaNoSeller(pedido, ctx);
    case "aConferir":
      return ehAConferir(pedido);
    case "conferidos":
      return ehConferido(pedido);
    case "wdParaConferir":
      return ehWdParaConferir(pedido, ctx);
    case "enviados":
      return ehEnviado(pedido);
    case "total":
      return true;
    default:
      return true;
  }
}

/**
 * Base do dashboard operacional do dia.
 * Exclui cancelados, Entregue e (exceto no filtro enviados) Enviado.
 */
export function pedidosBaseOperacional(
  pedidos: Pedido[],
  diaRef: string = diaLocalHoje()
): Pedido[] {
  return pedidos.filter((p) => {
    if (!ehPedidoDoDia(p, diaRef)) return false;
    const s = p["Status Any"];
    return s !== "Entregue" && s !== "Enviado";
  });
}

/** Uma linha por id_any (primeira ocorrência). */
export function deduplicarPorIdAny(pedidos: Pedido[]): Pedido[] {
  const visto = new Set<string>();
  const out: Pedido[] = [];
  for (const p of pedidos) {
    const id = String(p.id_any ?? "").trim();
    if (!id || visto.has(id)) continue;
    visto.add(id);
    out.push(p);
  }
  return out;
}

function baseParaFiltro(
  pedidos: Pedido[],
  id: FiltroOperacionalId,
  diaRef: string
): Pedido[] {
  if (id === "enviados") {
    return pedidos.filter((p) => {
      if (ehCancelado(p)) return false;
      if ((p["Status Any"] ?? "").trim() === "Entregue") return false;
      const diaColeta = (p["Data Coleta"] ?? "").slice(0, 10);
      return diaColeta === diaRef;
    });
  }
  return pedidosBaseOperacional(pedidos, diaRef);
}

export function pedidosDoFiltroOperacional(
  pedidos: Pedido[],
  id: FiltroOperacionalId,
  ctx: ContextoFiltrosPedidos,
  mkpId?: MkpFixoId | null,
  diaRef: string = diaLocalHoje()
): Pedido[] {
  const base = baseParaFiltro(pedidos, id, diaRef).filter((p) => {
    if (mkpId && classificarMkp(p.Mkp) !== mkpId) return false;
    return passaFiltroOperacional(p, id, ctx, diaRef);
  });
  return deduplicarPorIdAny(base);
}

export function contagensOperacionais(
  pedidos: Pedido[],
  ctx: ContextoFiltrosPedidos,
  mkpId?: MkpFixoId | null,
  diaRef: string = diaLocalHoje()
): Record<FiltroOperacionalId, number> {
  const ids = new Set<FiltroOperacionalId>([
    ...FILTROS_OPERACIONAIS.map((f) => f.id),
    ...CARDS_RESUMO_VISUAL.map((f) => f.id),
    ...CARDS_MKP_VISUAL.map((f) => f.id),
  ]);
  const contagens = Object.fromEntries([...ids].map((id) => [id, 0])) as Record<
    FiltroOperacionalId,
    number
  >;

  for (const id of ids) {
    contagens[id] = pedidosDoFiltroOperacional(pedidos, id, ctx, mkpId, diaRef).length;
  }
  return contagens;
}
