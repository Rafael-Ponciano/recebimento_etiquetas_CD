/** Telas controláveis por login (Configurações → Acesso). */

export const TELAS = [
  { id: "pedidos", label: "Pedidos", path: "/" },
  { id: "historico", label: "Histórico", path: "/historico" },
  { id: "despacho", label: "Despacho", path: "/despacho" },
  { id: "dashboard", label: "Dashboard", path: "/dashboard" },
  { id: "logs", label: "Logs", path: "/logs" },
  { id: "performance", label: "Performance", path: "/performance" },
  { id: "baixa-manual", label: "Baixa manual", path: "/baixa-manual" },
] as const;

export type TelaId = (typeof TELAS)[number]["id"];

export const ADMIN_ACESSO = "rafael.silva";

export function pathDaTela(tela: string): string {
  return TELAS.find((t) => t.id === tela)?.path ?? "/";
}

export function primeiraTelaPermitida(telas?: string[] | null): string {
  if (!telas?.length) return "/";
  for (const t of TELAS) {
    if (telas.includes(t.id)) return t.path;
  }
  return "/";
}

export function temTela(
  user: { role?: string; telas?: string[] | null; usuario?: string } | null | undefined,
  tela: string
): boolean {
  if (!user) return false;
  if ((user.usuario || "").toLowerCase() === ADMIN_ACESSO.toLowerCase()) return true;
  if (user.telas?.length) return user.telas.includes(tela);
  // Fallback legado (sessão antiga sem telas)
  if (tela === "pedidos" || tela === "historico") return true;
  return user.role === "admin";
}
