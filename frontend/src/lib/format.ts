export function formatarData(iso: string | null, comHora = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const data = d.toLocaleDateString("pt-BR");
  if (!comHora) return data;
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${data} ${hora}`;
}

export function textoUtil(valor?: string | number | null): string {
  const texto = String(valor ?? "").trim();
  if (!texto) return "";
  if (["nan", "none", "null", "n/a", "-", "—"].includes(texto.toLocaleLowerCase("pt-BR"))) {
    return "";
  }
  return texto;
}

export function normalizarParaBusca(valor: unknown): string {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function termosBuscaUniversal(busca: string): string[] {
  return busca
    .split(",")
    .flatMap((grupo) => normalizarParaBusca(grupo).split(" "))
    .map((t) => t.trim())
    .filter(Boolean);
}

export const FILIAL_AGUARDANDO = "Aguardando Vendedor";

export function formatarFilial(valor?: string | number | null): string {
  const texto = textoUtil(valor);
  if (!texto) return FILIAL_AGUARDANDO;
  const chave = texto.toLocaleLowerCase("pt-BR");
  if (chave === "padrão" || chave === "padrao") return FILIAL_AGUARDANDO;
  return texto;
}

export function formatarReferenciasPedido(pedido: {
  Pedido?: string | null;
  "Pedido Any"?: string | null;
  id_any?: string | number | null;
}): string {
  const anyRef = textoUtil(pedido["Pedido Any"]);
  const idAny = textoUtil(pedido.id_any);
  const partes: string[] = [];
  if (anyRef) partes.push(`Any ${anyRef}`);
  if (idAny) partes.push(`ID ${idAny}`);
  return partes.join(" · ");
}

/** Resume erros técnicos do Check B2C para o operador. */
export function resumirErroSheets(erro?: string | null): string {
  const texto = String(erro ?? "").trim();
  if (!texto) return "Planilha Check B2C não atualizou.";

  const lower = texto.toLocaleLowerCase("pt-BR");
  const itemMatch =
    texto.match(/item=['"]([^'"]+)['"]/i) ||
    texto.match(/item[=:]\s*([^\])\n]+)/i);
  const item = textoUtil(itemMatch?.[1]?.replace(/['"]+$/g, ""));

  if (lower.includes("linha não encontrada") || lower.includes("linha nao encontrada")) {
    return item
      ? `Item não encontrado na planilha: ${item}`
      : "Item não encontrado na planilha Check B2C.";
  }
  if (lower.includes("aba vazia")) return "Planilha Check B2C vazia.";
  if (lower.includes("nenhum identificador")) {
    return "Pedido sem ID válido para a planilha.";
  }

  const semPrefixo = texto
    .replace(
      /^(item conferido no app[^:]*:\s*|recebimento[^:]*:\s*|pedido agendado[^:]*:\s*)/i,
      ""
    )
    .trim();
  if (semPrefixo && semPrefixo !== texto) return resumirErroSheets(semPrefixo);

  if (texto.length > 110) return `${texto.slice(0, 107)}…`;
  return texto;
}

export function mensagemConferidoSemPlanilha(erroSheets?: string | null): string {
  return `Conferido no app · ${resumirErroSheets(erroSheets)}`;
}

export function corStatusCD(
  status: string,
  regras?: {
    status_coleta_hoje: string;
    status_agendado: string;
    status_parcial: string;
    sheets_status_feito: string;
  }
): { text: string; bg: string; border: string } {
  if (status.startsWith("Atrasado")) return { text: "text-red", bg: "bg-red/10", border: "border-red/30" };
  if (status.startsWith("Coleta Hoje")) return { text: "text-amber", bg: "bg-amber/10", border: "border-amber/30" };
  if (status.startsWith("📦")) return { text: "text-green", bg: "bg-green/10", border: "border-green/30" };
  if (status.startsWith("Agendado")) return { text: "text-cyan", bg: "bg-cyan/10", border: "border-cyan/30" };
  const fechados = new Set([
    "FEITO",
    "Conferido",
    "Recebido",
    "Ag. Coleta",
    "Ag. Coleta CD",
    regras?.status_coleta_hoje,
    regras?.status_agendado,
    regras?.sheets_status_feito,
  ].filter(Boolean));
  if (fechados.has(status)) return { text: "text-green", bg: "bg-green/10", border: "border-green/30" };
  if (status === "Recebido Parcial" || status === regras?.status_parcial) {
    return { text: "text-amber", bg: "bg-amber/10", border: "border-amber/30" };
  }
  if (status === "Entregue") return { text: "text-green", bg: "bg-green/10", border: "border-green/30" };
  if (status === "Enviado") return { text: "text-cyan", bg: "bg-cyan/10", border: "border-cyan/30" };
  if (status.toLowerCase().includes("cancel")) return { text: "text-red", bg: "bg-red/10", border: "border-red/30" };
  return { text: "text-text-faint", bg: "bg-elevated", border: "border-border" };
}
