import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";

export type PedidoItemApi = {
  line_key: string;
  orderItemIds: string[];
  sku: string;
  description?: string;
  product?: { title?: string };
  quantity?: number;
  quantidade_conferida?: number;
  status?: string;
  conferido_por?: string;
  operadores?: string[];
  ultimo_operador?: string;
  data_conferencia?: string;
  ean?: string;
  imageUrl?: string;
  seller?: string;
  nome_tabela?: string;
  historico?: Array<{
    quantidade: number;
    operador: string;
    recebido_em: string;
  }>;
};

export const PEDIDO_ITENS_STALE_MS = 300_000;

/** Hover: no máx. 1 prefetch por vez e ≥2,5s entre inícios (protege AnyMarket). */
const PREFETCH_MIN_INTERVAL_MS = 2_500;
const PREFETCH_MAX_INFLIGHT = 1;

let _prefetchInflight = 0;
let _ultimoPrefetchInicio = 0;
let _prefetchPendente: { queryClient: QueryClient; orderId: string } | null = null;
let _prefetchTimer: ReturnType<typeof setTimeout> | null = null;

export function pedidoItensQueryKey(orderId: string | number) {
  return ["pedido-itens", String(orderId)] as const;
}

export async function fetchPedidoItens(orderId: string | number): Promise<PedidoItemApi[]> {
  const { data } = await api.get<{ items: PedidoItemApi[] }>(
    `/pedidos/${orderId}/itens`
  );
  return data.items ?? [];
}

function _jaEmCache(queryClient: QueryClient, orderId: string): boolean {
  const state = queryClient.getQueryState(pedidoItensQueryKey(orderId));
  if (!state?.data) return false;
  const idade = Date.now() - (state.dataUpdatedAt || 0);
  return idade < PEDIDO_ITENS_STALE_MS;
}

function _dispararPrefetch(queryClient: QueryClient, orderId: string): Promise<void> {
  _prefetchInflight += 1;
  _ultimoPrefetchInicio = Date.now();
  return queryClient
    .prefetchQuery({
      queryKey: pedidoItensQueryKey(orderId),
      queryFn: () => fetchPedidoItens(orderId),
      staleTime: PEDIDO_ITENS_STALE_MS,
    })
    .catch(() => undefined)
    .then(() => {
      _prefetchInflight = Math.max(0, _prefetchInflight - 1);
      _agendarPendente();
    });
}

function _agendarPendente(): void {
  if (!_prefetchPendente) return;
  if (_prefetchInflight >= PREFETCH_MAX_INFLIGHT) return;

  const espera = Math.max(
    0,
    PREFETCH_MIN_INTERVAL_MS - (Date.now() - _ultimoPrefetchInicio)
  );
  if (_prefetchTimer != null) {
    clearTimeout(_prefetchTimer);
    _prefetchTimer = null;
  }

  const rodada = () => {
    _prefetchTimer = null;
    const pendente = _prefetchPendente;
    if (!pendente) return;
    if (_prefetchInflight >= PREFETCH_MAX_INFLIGHT) return;
    if (_jaEmCache(pendente.queryClient, pendente.orderId)) {
      _prefetchPendente = null;
      return;
    }
    _prefetchPendente = null;
    void _dispararPrefetch(pendente.queryClient, pendente.orderId);
  };

  if (espera <= 0) {
    rodada();
  } else {
    _prefetchTimer = setTimeout(rodada, espera);
  }
}

/**
 * Prefetch com rate limit (hover).
 * Só 1 em voo; mínimo 1,5s entre inícios; ignora se já estiver em cache.
 * Abrir o modal usa useQuery/fetch direto — não passa por aqui.
 */
export function prefetchPedidoItens(queryClient: QueryClient, orderId: string | number) {
  const id = String(orderId ?? "").trim();
  if (!id) return Promise.resolve();
  if (_jaEmCache(queryClient, id)) return Promise.resolve();

  // Substitui o pendente: hover no pedido atual importa mais que o anterior.
  _prefetchPendente = { queryClient, orderId: id };
  _agendarPendente();
  return Promise.resolve();
}
