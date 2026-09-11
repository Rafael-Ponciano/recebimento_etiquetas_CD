import { NavLink, useNavigate } from "react-router-dom";
import {
  Package,
  ClipboardList,
  History,
  LogOut,
  Timer,
  Wrench,
  LayoutDashboard,
  TriangleAlert,
  Printer,
  Truck,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../store/auth";
import { useUiStore } from "../store/ui";
import { api } from "../lib/api";
import { temTela } from "../lib/acessoTelas";
import ProfileSettingsDialog from "./ProfileSettingsDialog";
import PrefetchProgressCard from "./PrefetchProgressCard";
import SheetsErrosDialog from "./SheetsErrosDialog";
import FinalizacaoErrosDialog from "./FinalizacaoErrosDialog";

type ResumoDia = {
  pecas: number;
  pedidos: number;
  finalizacoes: number;
  media_ms: number | null;
  amostras_tempo: number;
};

function formatarMedia(ms: number | null | undefined) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function MiniStat({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      className="flex min-w-[4.25rem] flex-col items-center justify-center rounded-md border border-border-soft bg-elevated/50 px-2 py-1 leading-none text-center"
    >
      <span className="text-[9px] uppercase tracking-wide text-text-faint">{label}</span>
      <span className="mt-0.5 font-mono text-[11px] tabular-nums text-text">{value}</span>
    </div>
  );
}

function ErroFilaCard({
  label,
  total,
  title,
  icon,
  tom,
  onClick,
}: {
  label: string;
  total: number;
  title: string;
  icon: ReactNode;
  tom: "amber" | "red";
  onClick: () => void;
}) {
  const ativo = total > 0;
  const classes =
    tom === "amber"
      ? ativo
        ? "border-amber/40 bg-amber/10 text-amber hover:bg-amber/20"
        : "border-border-soft bg-elevated/50 text-text-faint hover:bg-elevated hover:text-text-muted"
      : ativo
        ? "border-red/40 bg-red/10 text-red hover:bg-red/20"
        : "border-border-soft bg-elevated/50 text-text-faint hover:bg-elevated hover:text-text-muted";

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex min-w-[4.25rem] flex-col items-center justify-center rounded-md border px-2 py-1 leading-none text-center transition ${classes}`}
    >
      <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wide">
        {icon}
        {label}
      </span>
      <span className="mt-0.5 font-mono text-[11px] tabular-nums">
        {total.toLocaleString("pt-BR")}
      </span>
    </button>
  );
}

function iniciais(nome?: string) {
  if (!nome) return "?";
  const partes = nome.trim().split(/\s+/);
  return ((partes[0]?.[0] ?? "") + (partes[1]?.[0] ?? "")).toUpperCase();
}

function NavItem({
  to,
  end,
  icon,
  children,
}: {
  to: string;
  end?: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `relative flex items-center gap-2 h-full px-4 text-sm font-medium transition-colors ${
          isActive ? "text-text" : "text-text-muted hover:text-text"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {icon}
          {children}
          <span
            className={`absolute left-3 right-3 -bottom-px h-0.5 rounded-full transition-colors ${
              isActive ? "bg-amber" : "bg-transparent"
            }`}
          />
        </>
      )}
    </NavLink>
  );
}

export default function TopBar() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const setColumnEditMode = useUiStore((state) => state.setColumnEditMode);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [configuracoesAbertas, setConfiguracoesAbertas] = useState(false);
  const [errosSheetsAbertos, setErrosSheetsAbertos] = useState(false);
  const [errosFinalizacaoAbertos, setErrosFinalizacaoAbertos] = useState(false);

  const { data: resumo } = useQuery({
    queryKey: ["resumo-dia", user?.usuario],
    enabled: !!user?.usuario,
    queryFn: async () => {
      const { data } = await api.get<ResumoDia>("/auth/resumo-dia");
      return data;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: errosSheets } = useQuery({
    queryKey: ["erros-sheets-count"],
    enabled: !!user?.usuario,
    queryFn: async () => {
      const { data } = await api.get<{ total: number }>("/pedidos/erros-sheets/count");
      return data;
    },
    refetchInterval: 45_000,
    staleTime: 20_000,
  });

  const { data: errosFinalizacao } = useQuery({
    queryKey: ["erros-finalizacao-count"],
    enabled: !!user?.usuario,
    queryFn: async () => {
      const { data } = await api.get<{ total: number }>(
        "/pedidos/erros-finalizacao/count"
      );
      return data;
    },
    refetchInterval: 45_000,
    staleTime: 20_000,
  });

  async function handleLogout() {
    try {
      await api.post("/auth/logout");
    } catch {

    }
    logout();
    queryClient.clear();
    navigate("/login");
  }

  const totalErrosSheets = errosSheets?.total ?? 0;
  const totalErrosFinalizacao = errosFinalizacao?.total ?? 0;

  return (
    <div className="shrink-0 bg-void">
      <div className="hazard-strip" />
      <div className="flex h-14 items-center border-b border-border-soft px-6 pr-3">
        <div className="flex items-center gap-3 h-full pr-5 mr-2 border-r border-border-soft">
          <div className="relative w-8 h-8 rounded-md bg-elevated border border-border flex items-center justify-center">
            <Package size={15} className="text-amber" />
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green ring-2 ring-void" />
          </div>
          <div className="hidden sm:flex flex-col leading-none">
            <span className="font-display font-semibold text-[13px] tracking-tight text-text">
              Conferência
            </span>
            <span className="font-mono text-[10px] tracking-[0.14em] text-text-faint uppercase mt-1">
              CD · Recebimento
            </span>
          </div>
        </div>

        <nav className="flex items-center h-full">
          {temTela(user, "pedidos") && (
            <NavItem to="/" end icon={<Package size={15} />}>
              Pedidos
            </NavItem>
          )}
          {temTela(user, "despacho") && (
            <NavItem to="/despacho" icon={<Truck size={15} />}>
              Despacho
            </NavItem>
          )}
          {temTela(user, "historico") && (
            <NavItem to="/historico" icon={<History size={15} />}>
              Histórico
            </NavItem>
          )}
          {temTela(user, "dashboard") && (
            <NavItem to="/dashboard" icon={<LayoutDashboard size={15} />}>
              Dashboard
            </NavItem>
          )}
          {temTela(user, "logs") && (
            <NavItem to="/logs" icon={<ClipboardList size={15} />}>
              Logs
            </NavItem>
          )}
          {temTela(user, "performance") && (
            <NavItem to="/performance" icon={<Timer size={15} />}>
              Performance
            </NavItem>
          )}
          {temTela(user, "baixa-manual") && (
            <NavItem to="/baixa-manual" icon={<Wrench size={15} />}>
              Baixa manual
            </NavItem>
          )}
        </nav>

        <div className="flex-1" />

        <div className="hidden md:flex items-center gap-2 mr-3">
          <MiniStat
            label="Peças hoje"
            value={(resumo?.pecas ?? 0).toLocaleString("pt-BR")}
            title={
              resumo
                ? `${resumo.pedidos} pedido(s) · ${resumo.finalizacoes} finalização(ões)`
                : "Produtividade do dia"
            }
          />
          <ErroFilaCard
            label="Erro Sheets"
            total={totalErrosSheets}
            title="Pedidos com falha ao atualizar o Check B2C"
            icon={<TriangleAlert size={9} />}
            tom="amber"
            onClick={() => setErrosSheetsAbertos(true)}
          />
          <ErroFilaCard
            label="Erro conf."
            total={totalErrosFinalizacao}
            title="Pedidos com falha em conferência, etiqueta ou impressão"
            icon={<Printer size={9} />}
            tom="red"
            onClick={() => setErrosFinalizacaoAbertos(true)}
          />
          <MiniStat
            label="Tempo médio"
            value={formatarMedia(resumo?.media_ms)}
            title={
              resumo?.amostras_tempo
                ? `Média de ${resumo.amostras_tempo} conferência(s) hoje`
                : "Sem amostras de tempo hoje"
            }
          />
          <PrefetchProgressCard />
        </div>
        <button
          type="button"
          onClick={() => setConfiguracoesAbertas(true)}
          className="group flex h-full items-center gap-2.5 border-l border-border-soft pl-4 pr-3 transition hover:bg-elevated/40"
          title="Abrir configurações"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-amber/30 bg-amber-dim">
            {user?.imagem ? (
              <img src={user.imagem} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="font-mono text-[11px] font-medium text-amber">
                {iniciais(user?.nome)}
              </span>
            )}
          </div>
          <div className="hidden lg:flex flex-col leading-none">
            <span className="text-sm text-text group-hover:text-amber">{user?.nome}</span>
            <span className="font-mono text-[10px] text-text-faint uppercase tracking-wide mt-0.5">
              {user?.role}
            </span>
          </div>
        </button>

        <button
          onClick={handleLogout}
          className="ml-3 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-muted transition hover:border-red/40 hover:bg-red/5 hover:text-red"
        >
          <LogOut size={14} />
          <span className="hidden sm:inline">Sair</span>
        </button>
      </div>
      {configuracoesAbertas && (
        <ProfileSettingsDialog
          onClose={() => setConfiguracoesAbertas(false)}
          onOpenColumns={() => {
            setConfiguracoesAbertas(false);
            setColumnEditMode(true);
            navigate("/");
          }}
        />
      )}
      {errosSheetsAbertos && (
        <SheetsErrosDialog onClose={() => setErrosSheetsAbertos(false)} />
      )}
      {errosFinalizacaoAbertos && (
        <FinalizacaoErrosDialog onClose={() => setErrosFinalizacaoAbertos(false)} />
      )}
    </div>
  );
}
