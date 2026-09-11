import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

type Props = {
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
};

export default function MultiSelect({ label, options, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [busca, setBusca] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setBusca("");
      }
    }
    document.addEventListener("mousedown", onClickOutside, true);
    return () => document.removeEventListener("mousedown", onClickOutside, true);
  }, [open]);

  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const filtradas = useMemo(() => {
    const termo = busca.trim().toLocaleLowerCase("pt-BR");
    if (!termo) return options;
    return options.filter((opt) => opt.toLocaleLowerCase("pt-BR").includes(termo));
  }, [busca, options]);

  const todasFiltradasSelecionadas =
    filtradas.length > 0 && filtradas.every((opt) => selected.includes(opt));

  function toggle(opt: string) {
    onChange(selected.includes(opt) ? selected.filter((v) => v !== opt) : [...selected, opt]);
  }

  function selecionarTodasFiltradas() {
    const set = new Set(selected);
    filtradas.forEach((opt) => set.add(opt));
    onChange([...set]);
  }

  function limparFiltradas() {
    const remover = new Set(filtradas);
    onChange(selected.filter((opt) => !remover.has(opt)));
  }

  return (
    <div className="relative min-w-0" ref={ref}>
      <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-text-faint">
        {label}
      </label>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border bg-elevated/80 px-2.5 text-xs transition ${
          open ? "border-amber/70" : "border-border hover:border-text-faint"
        }`}
      >
        <span className={`min-w-0 flex-1 truncate text-left ${selected.length ? "text-text" : "text-text-muted"}`}>
          {selected.length === 0
            ? "Todos"
            : selected.length === 1
              ? selected[0]
              : `${selected.length} selecionados`}
        </span>
        <span
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-[10px] tabular-nums ${
            selected.length > 0 ? "bg-amber/15 text-amber" : "invisible"
          }`}
          aria-hidden={selected.length === 0}
        >
          {selected.length || 0}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-text-faint transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute z-50 mt-1.5 w-full overflow-hidden rounded-xl border border-border bg-surface shadow-xl shadow-black/40">
          <div className="border-b border-border-soft p-2">
            <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-elevated px-2.5">
              <Search size={14} className="shrink-0 text-text-faint" />
              <input
                ref={inputRef}
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Pesquisar..."
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-faint"
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={selecionarTodasFiltradas}
                disabled={filtradas.length === 0 || todasFiltradasSelecionadas}
                className="rounded-md px-2 py-1 text-[11px] text-amber transition hover:bg-amber/10 disabled:opacity-30"
              >
                Selecionar tudo{busca.trim() ? " da pesquisa" : ""}
              </button>
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={busca.trim() ? limparFiltradas : () => onChange([])}
                  className="rounded-md px-2 py-1 text-[11px] text-text-muted transition hover:bg-elevated hover:text-text"
                >
                  {busca.trim() ? "Limpar pesquisa" : "Limpar seleção"}
                </button>
              )}
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto p-1.5">
            {filtradas.length === 0 && (
              <p className="px-3 py-2 text-xs text-text-faint">Nenhuma opção</p>
            )}
            {filtradas.map((opt) => {
              const checked = selected.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggle(opt)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-elevated"
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      checked ? "bg-amber border-amber text-void" : "border-border"
                    }`}
                  >
                    {checked && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="truncate">{opt}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
