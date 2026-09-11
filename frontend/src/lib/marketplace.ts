export type MkpFixoId = "meli" | "magalu" | "shopee" | "tray";

export const MKPS_FIXOS: Array<{
  id: MkpFixoId;
  label: string;
  logoSrc?: string;
}> = [
  { id: "meli", label: "Meli", logoSrc: "/mkp/meli.png" },
  { id: "magalu", label: "Magalu", logoSrc: "/mkp/magalu.png" },
  { id: "shopee", label: "Shopee", logoSrc: "/mkp/shopee.png" },
  { id: "tray", label: "Tray", logoSrc: "/mkp/tray.png" },
];

export function classificarMkp(mkp?: string | null): MkpFixoId | null {
  const chave = (mkp ?? "").trim().toLocaleLowerCase("pt-BR");
  if (!chave) return null;
  if (chave.includes("meli") || chave.includes("mercado")) return "meli";
  if (chave.includes("magalu") || chave.includes("magazine")) return "magalu";
  if (chave.includes("shopee")) return "shopee";
  if (chave.includes("tray")) return "tray";
  return null;
}

export function logoMarketplace(mkp?: string | null): { src: string; alt: string } | null {
  const id = classificarMkp(mkp);
  if (!id) return null;
  const info = MKPS_FIXOS.find((m) => m.id === id);
  if (!info?.logoSrc) return null;
  return { src: info.logoSrc, alt: info.label === "Meli" ? "Mercado Livre" : info.label };
}
