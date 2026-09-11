import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";

type Props = {
  label: string;
  de: string;
  ate: string;
  onChangeDe: (value: string) => void;
  onChangeAte: (value: string) => void;
};

const MESES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

const DIAS_SEMANA = ["D", "S", "T", "Q", "Q", "S", "S"];

function paraIso(ano: number, mes: number, dia: number) {
  return `${ano}-${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function parseIso(iso: string) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function formatarExibicao(iso: string) {
  const d = parseIso(iso);
  if (!d) return "";
  return d.toLocaleDateString("pt-BR");
}

function mesmoDia(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export default function DateRangeFilter({ label, de, ate, onChangeDe, onChangeAte }: Props) {
  const [aberto, setAberto] = useState(false);
  const [cursor, setCursor] = useState(() => parseIso(de) || parseIso(ate) || new Date());
  const [inicioTemp, setInicioTemp] = useState<string | null>(null);
  const ultimoCliqueRef = useRef<{ iso: string; em: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const ativo = Boolean(de || ate || inicioTemp);

  function confirmarSeDiaUnico() {
    const diaUnico = inicioTemp || (de && !ate ? de : "");
    if (!diaUnico) return;
    onChangeDe(diaUnico);
    onChangeAte(diaUnico);
  }

  function fecharCalendario() {
    confirmarSeDiaUnico();
    setInicioTemp(null);
    setAberto(false);
  }

  useEffect(() => {
    if (!aberto) return;
    function fora(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        fecharCalendario();
      }
    }
    document.addEventListener("mousedown", fora, true);
    return () => document.removeEventListener("mousedown", fora, true);
    // fecharCalendario usa de/ate/inicioTemp atuais
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, inicioTemp, de, ate]);

  function abrirCalendario() {
    setCursor(parseIso(de) || parseIso(ate) || new Date());
    setInicioTemp(null);
    ultimoCliqueRef.current = null;
    setAberto(true);
  }

  function alternarCalendario() {
    if (aberto) {
      fecharCalendario();
      return;
    }
    abrirCalendario();
  }

  const dias = useMemo(() => {
    const ano = cursor.getFullYear();
    const mes = cursor.getMonth();
    const primeiro = new Date(ano, mes, 1);
    const total = new Date(ano, mes + 1, 0).getDate();
    const offset = primeiro.getDay();
    const celulas: Array<{ iso: string; dia: number; fora: boolean }> = [];

    for (let i = 0; i < offset; i += 1) {
      const d = new Date(ano, mes, -offset + i + 1);
      celulas.push({
        iso: paraIso(d.getFullYear(), d.getMonth(), d.getDate()),
        dia: d.getDate(),
        fora: true,
      });
    }
    for (let dia = 1; dia <= total; dia += 1) {
      celulas.push({ iso: paraIso(ano, mes, dia), dia, fora: false });
    }
    while (celulas.length % 7 !== 0) {
      const idx = celulas.length - offset - total + 1;
      const d = new Date(ano, mes + 1, idx);
      celulas.push({
        iso: paraIso(d.getFullYear(), d.getMonth(), d.getDate()),
        dia: d.getDate(),
        fora: true,
      });
    }
    return celulas;
  }, [cursor]);

  const inicio = inicioTemp || de;
  const fim = inicioTemp ? "" : ate;

  function noIntervalo(iso: string) {
    if (!inicio) return false;
    if (!fim) return iso === inicio;
    const a = inicio <= fim ? inicio : fim;
    const b = inicio <= fim ? fim : inicio;
    return iso >= a && iso <= b;
  }

  function extremos(iso: string) {
    if (!inicio) return false;
    if (!fim) return iso === inicio;
    const a = inicio <= fim ? inicio : fim;
    const b = inicio <= fim ? fim : inicio;
    return iso === a || iso === b;
  }

  function selecionarDia(iso: string) {
    const agora = Date.now();
    const ultimo = ultimoCliqueRef.current;
    const duplo = Boolean(ultimo && ultimo.iso === iso && agora - ultimo.em < 400);
    ultimoCliqueRef.current = { iso, em: agora };

    if (duplo) {
      onChangeDe(iso);
      onChangeAte(iso);
      setInicioTemp(null);
      setAberto(false);
      return;
    }

    if (!inicioTemp) {
      setInicioTemp(iso);
      onChangeDe(iso);
      onChangeAte("");
      return;
    }

    const a = inicioTemp <= iso ? inicioTemp : iso;
    const b = inicioTemp <= iso ? iso : inicioTemp;
    onChangeDe(a);
    onChangeAte(b);
    setInicioTemp(null);
    setAberto(false);
  }

  function limpar(e: ReactMouseEvent) {
    e.stopPropagation();
    onChangeDe("");
    onChangeAte("");
    setInicioTemp(null);
  }

  const texto =
    de && ate
      ? de === ate
        ? formatarExibicao(de)
        : `${formatarExibicao(de)} – ${formatarExibicao(ate)}`
      : de
        ? `${formatarExibicao(de)} – …`
        : "Selecionar período";

  return (
    <div className="relative min-w-0" ref={rootRef}>
      <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-text-faint">
        {label}
      </label>
      <button
        type="button"
        onClick={alternarCalendario}
        className={`group flex h-8 w-full items-center gap-2 rounded-lg border bg-elevated/80 px-2.5 text-left transition ${
          aberto ? "border-amber/70" : "border-border hover:border-text-faint"
        }`}
      >
        <CalendarDays size={15} className="shrink-0 text-text-faint transition group-hover:text-amber" />
        <span className={`min-w-0 flex-1 truncate text-xs ${de || ate ? "text-text" : "text-text-muted"}`}>
          {texto}
        </span>
        <span
          role="button"
          tabIndex={ativo ? 0 : -1}
          onClick={ativo ? limpar : undefined}
          onKeyDown={
            ativo
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onChangeDe("");
                    onChangeAte("");
                    setInicioTemp(null);
                  }
                }
              : undefined
          }
          className={`rounded-md p-0.5 text-text-faint transition hover:bg-surface hover:text-text ${
            ativo ? "" : "invisible pointer-events-none"
          }`}
          aria-label={`Limpar ${label}`}
          aria-hidden={!ativo}
        >
          <X size={13} />
        </span>
      </button>

      {aberto && (
        <div className="absolute z-50 mt-1.5 w-full rounded-xl border border-border bg-surface p-3 shadow-xl shadow-black/40">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
              className="rounded-lg p-1.5 text-text-muted hover:bg-elevated hover:text-text"
              aria-label="Mês anterior"
            >
              <ChevronLeft size={16} />
            </button>
            <p className="text-sm font-medium">
              {MESES[cursor.getMonth()]} {cursor.getFullYear()}
            </p>
            <button
              type="button"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
              className="rounded-lg p-1.5 text-text-muted hover:bg-elevated hover:text-text"
              aria-label="Próximo mês"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-0.5">
            {DIAS_SEMANA.map((dia, i) => (
              <div key={`${dia}-${i}`} className="py-1 text-center text-[10px] font-medium text-text-faint">
                {dia}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {dias.map((celula, index) => {
              const selecionado = extremos(celula.iso);
              const meio = noIntervalo(celula.iso) && !selecionado;
              const dataCelula = parseIso(celula.iso);
              const hoje = dataCelula ? mesmoDia(dataCelula, new Date()) : false;
              return (
                <button
                  key={`${celula.iso}-${index}`}
                  type="button"
                  onClick={() => selecionarDia(celula.iso)}
                  className={`h-8 rounded-lg text-xs transition ${
                    selecionado
                      ? "bg-amber font-semibold text-void"
                      : meio
                        ? "bg-amber/20 text-text"
                        : celula.fora
                          ? "text-text-faint/50 hover:bg-elevated"
                          : "text-text hover:bg-elevated"
                  } ${hoje && !selecionado ? "ring-1 ring-amber/40" : ""}`}
                >
                  {celula.dia}
                </button>
              );
            })}
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-text-faint">
            1º clique: início · 2º clique: fim · 1 dia + clicar fora: só aquele dia
          </p>
        </div>
      )}
    </div>
  );
}
