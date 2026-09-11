import type { ReactNode } from "react";

type Cor = "red" | "amber" | "cyan" | "green" | "faint";

const CORES: Record<
  Cor,
  { base: string; active: string; icon: string; iconActive: string; count: string }
> = {
  red: {
    base: "border-red/35 bg-surface/50 text-red/90 hover:border-red/55 hover:bg-red/10",
    active: "border-red bg-red text-void shadow-[0_0_12px_rgba(229,88,107,0.28)]",
    icon: "text-red",
    iconActive: "text-void",
    count: "text-red",
  },
  amber: {
    base: "border-amber/35 bg-surface/50 text-amber/90 hover:border-amber/55 hover:bg-amber/10",
    active: "border-amber bg-amber text-void shadow-[0_0_12px_rgba(242,166,60,0.28)]",
    icon: "text-amber",
    iconActive: "text-void",
    count: "text-amber",
  },
  cyan: {
    base: "border-cyan/35 bg-surface/50 text-cyan/90 hover:border-cyan/55 hover:bg-cyan/10",
    active: "border-cyan bg-cyan text-void shadow-[0_0_12px_rgba(79,184,216,0.28)]",
    icon: "text-cyan",
    iconActive: "text-void",
    count: "text-cyan",
  },
  green: {
    base: "border-green/35 bg-surface/50 text-green/90 hover:border-green/55 hover:bg-green/10",
    active: "border-green bg-green text-void shadow-[0_0_12px_rgba(62,207,142,0.28)]",
    icon: "text-green",
    iconActive: "text-void",
    count: "text-green",
  },
  faint: {
    base: "border-border bg-surface/50 text-text-muted hover:border-text-faint hover:text-text",
    active: "border-text bg-elevated text-text",
    icon: "text-text-faint",
    iconActive: "text-text",
    count: "text-text-muted",
  },
};

type Props = {
  label: string;
  count: number;
  icon: ReactNode;
  cor: Cor;
  active: boolean;
  onClick: () => void;
  /** chip = barra superior; tile = modal de filtros */
  variant?: "chip" | "tile";
  hint?: string;
  className?: string;
};

export default function QuickFilterCard({
  label,
  count,
  icon,
  cor,
  active,
  onClick,
  variant = "chip",
  hint,
  className = "",
}: Props) {
  const c = CORES[cor];

  if (variant === "tile") {
    return (
      <button
        type="button"
        onClick={onClick}
        title={hint || undefined}
        aria-label={hint ? `${label}. ${hint}` : label}
        aria-pressed={active}
        className={`group flex w-full items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left transition-[color,background-color,border-color,box-shadow] duration-150 ${
          active ? c.active : c.base
        } ${className}`}
      >
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-md border [&_svg]:size-3 ${
            active
              ? "border-void/15 bg-void/10"
              : "border-border-soft bg-elevated/80"
          } ${active ? c.iconActive : c.icon}`}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold leading-tight">{label}</span>
          {hint ? (
            <span
              className={`mt-px block text-[9px] leading-snug ${
                active ? "opacity-80" : "text-text-faint"
              }`}
            >
              {hint}
            </span>
          ) : null}
        </span>
        <span
          className={`font-mono text-xs font-semibold tabular-nums leading-none ${
            active ? "" : c.count
          }`}
        >
          {count}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={hint || undefined}
      aria-label={hint ? `${label}. ${hint}` : label}
      aria-pressed={active}
      className={`inline-flex items-center gap-0.5 rounded-md border px-1.5 text-[10px] font-medium leading-none whitespace-nowrap transition-[color,background-color,border-color,box-shadow] duration-150 ${
        active ? c.active : c.base
      } ${className || "h-6 w-max"}`}
    >
      <span
        className={`flex size-2.5 shrink-0 items-center justify-center [&_svg]:size-2.5 ${
          active ? c.iconActive : c.icon
        }`}
      >
        {icon}
      </span>
      <span className="shrink-0">{label}</span>
      <span
        className={`inline-flex h-3.5 w-[4ch] shrink-0 items-center justify-end font-mono text-[9px] tabular-nums ${
          active ? "" : "opacity-75"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
