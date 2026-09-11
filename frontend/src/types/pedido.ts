export type Pedido = {
  "Status CD": string;
  id_any: string;
  Pedido: string;
  Data: string | null;
  "Data Coleta": string | null;
  Cliente: string;
  CPF: string;
  "Status Any": string;
  Item: string;
  QTND: string;
  filial_seller: string;
  "Pedido Seller": string;
  "Pedido Any": string;
  Mkp: string;
  "NF Venda": string;
  "NF Seller": string;
  ean: string;
  /** Status da NF no Supabase (ex.: FAILED, OK, PENDING). */
  status_nf?: string | null;
  /** Status do pedido no banco (ex.: DELIVERED). */
  status_pedido?: string | null;
  /** data_back − Data (ou agora − Data se data_back null), formato HH:MM:SS. */
  tempo_integracao?: string | null;
};
