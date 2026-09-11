import * as XLSX from "xlsx";
import type { Pedido } from "../types/pedido";
import { formatarData, formatarFilial } from "./format";

type ColunaExport = {
  id: string;
  label: string;
};

export type ResultadoExportXlsx =
  | { ok: true; caminho?: string; registros: number }
  | { ok: false; cancelado: true }
  | { ok: false; cancelado?: false; erro: string };

type PywebviewSalvar = (nome: string, b64: string) => Promise<{
  ok: boolean;
  cancelado?: boolean;
  caminho?: string;
  erro?: string;
}>;

function valorCelula(pedido: Pedido, columnId: string): string | number {
  switch (columnId) {
    case "Status CD":
      return pedido["Status CD"] ?? "";
    case "Pedido":
      return pedido.Pedido ?? "";
    case "id_any":
      return pedido.id_any ?? "";
    case "Pedido Seller":
      return pedido["Pedido Seller"] ?? "";
    case "NF Venda":
      return pedido["NF Venda"] ?? "";
    case "NF Seller":
      return pedido["NF Seller"] ?? "";
    case "Data":
      return formatarData(pedido.Data, true) || "";
    case "tempo_integracao":
      return pedido.tempo_integracao ?? "";
    case "Data Coleta":
      return formatarData(pedido["Data Coleta"]) || "";
    case "Cliente":
      return pedido.Cliente ?? "";
    case "Status Any":
      return pedido["Status Any"] ?? "";
    case "Item":
      return pedido.Item ?? "";
    case "QTND": {
      const n = Number(String(pedido.QTND ?? "").replace(",", "."));
      return Number.isFinite(n) ? n : (pedido.QTND ?? "");
    }
    case "filial_seller":
      return formatarFilial(pedido.filial_seller);
    case "Mkp":
      return pedido.Mkp ?? "";
    case "ean":
      return pedido.ean ?? "";
    default:
      return "";
  }
}

function montarWorkbook(pedidos: Pedido[], colunas: ColunaExport[]) {
  const headers = colunas.map((c) => c.label);
  const rows = pedidos.map((pedido) =>
    colunas.map((coluna) => valorCelula(pedido, coluna.id))
  );
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const colWidths = headers.map((header, idx) => {
    let max = String(header).length;
    for (const row of rows) {
      const len = String(row[idx] ?? "").length;
      if (len > max) max = len;
    }
    return { wch: Math.min(Math.max(max + 2, 10), 60) };
  });
  sheet["!cols"] = colWidths;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Pedidos");
  return workbook;
}

function bytesParaBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function nomeSugerido(prefixo: string): string {
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-");
  return `${prefixo}_${stamp}.xlsx`;
}

async function salvarViaPywebview(
  blob: Blob,
  nomeArquivo: string
): Promise<"ok" | "cancelado" | "indisponivel" | string> {
  const salvar = window.pywebview?.api?.salvar_arquivo as PywebviewSalvar | undefined;
  if (typeof salvar !== "function") return "indisponivel";
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const resp = await salvar(nomeArquivo, bytesParaBase64(bytes));
  if (resp?.cancelado) return "cancelado";
  if (resp?.ok) return "ok";
  return resp?.erro || "Falha ao salvar o arquivo.";
}

async function salvarViaFilePicker(
  blob: Blob,
  nomeArquivo: string
): Promise<"ok" | "cancelado" | "indisponivel"> {
  const picker = window.showSaveFilePicker;
  if (typeof picker !== "function") return "indisponivel";
  try {
    const handle = await picker.call(window, {
      suggestedName: nomeArquivo,
      types: [
        {
          description: "Planilha Excel",
          accept: {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
              ".xlsx",
            ],
          },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return "ok";
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "cancelado";
    throw e;
  }
}

function salvarViaDownload(blob: Blob, nomeArquivo: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Exporta as linhas filtradas como .xlsx, pedindo onde salvar. */
export async function exportarPedidosXlsx(
  pedidos: Pedido[],
  colunas: ColunaExport[],
  nomeArquivo = "pedidos"
): Promise<ResultadoExportXlsx> {
  if (pedidos.length === 0) {
    return { ok: false, erro: "Nada para exportar com os filtros atuais." };
  }

  const workbook = montarWorkbook(pedidos, colunas);
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const nome = nomeSugerido(nomeArquivo);

  try {
    const viaDesktop = await salvarViaPywebview(blob, nome);
    if (viaDesktop === "ok") {
      return { ok: true, registros: pedidos.length };
    }
    if (viaDesktop === "cancelado") {
      return { ok: false, cancelado: true };
    }
    if (viaDesktop !== "indisponivel") {
      return { ok: false, erro: viaDesktop };
    }

    const viaPicker = await salvarViaFilePicker(blob, nome);
    if (viaPicker === "ok") {
      return { ok: true, registros: pedidos.length };
    }
    if (viaPicker === "cancelado") {
      return { ok: false, cancelado: true };
    }

    // Último recurso (navegador/dev sem diálogo nativo).
    salvarViaDownload(blob, nome);
    return { ok: true, registros: pedidos.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Falha ao gerar o arquivo XLSX.";
    return { ok: false, erro: msg };
  }
}
