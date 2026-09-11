import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

type Props = {
  value: number;
  options: readonly number[];
  onChange: (value: number) => void;
};

export default function PageSizeSelect({ value, options, onChange }: Props) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setAberto(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside, true);
    return () => document.removeEventListener("mousedown", onClickOutside, true);
  }, [aberto]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-label="Linhas por página"
        aria-expanded={aberto}
        className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border bg-elevated px-2.5 text-xs text-text transition ${
          aberto ? "border-amber/70" : "border-border hover:border-text-faint"
        }`}
      >
        <span className="font-mono tabular-nums">{value} por página</span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-text-faint transition ${aberto ? "rotate-180 text-amber" : ""}`}
        />
      </button>

      {aberto && (
        <div className="absolute bottom-full right-0 z-30 mb-1.5 min-w-[10.5rem] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl shadow-black/40">
          {options.map((tamanho) => {
            const ativo = tamanho === value;
            return (
              <button
                key={tamanho}
                type="button"
                onClick={() => {
                  onChange(tamanho);
                  setAberto(false);
                }}
                className={`flex w-full items-center justify-between gap-3 whitespace-nowrap px-3 py-1.5 text-left text-xs transition ${
                  ativo
                    ? "bg-amber/15 text-amber"
                    : "text-text-muted hover:bg-elevated hover:text-text"
                }`}
              >
                <span className="font-mono tabular-nums">{tamanho} por página</span>
                {ativo && <Check size={13} className="shrink-0 text-amber" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
