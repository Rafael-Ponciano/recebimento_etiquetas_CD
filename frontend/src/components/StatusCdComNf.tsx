import { corStatusCD } from "../lib/format";
import { useRegras } from "../lib/regras";

export function ehStatusNfFailed(statusNf?: string | null): boolean {
  return (statusNf ?? "").trim().toUpperCase() === "FAILED";
}

type Props = {
  statusCd: string;
  statusNf?: string | null;
};

/** Badge de Status CD; se status_nf = FAILED, mostra chip Erro NF ao lado. */
export default function StatusCdComNf({ statusCd, statusNf }: Props) {
  const regras = useRegras();
  const nfErro = ehStatusNfFailed(statusNf);

  if (!statusCd && !nfErro) {
    return <span className="text-[11px] text-text-faint">—</span>;
  }

  const c = statusCd ? corStatusCD(statusCd, regras) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {statusCd && c ? (
        <span
          className={`inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-px text-[11px] font-medium leading-tight ${c.text} ${c.bg} ${c.border}`}
        >
          {statusCd}
        </span>
      ) : null}
      {nfErro ? (
        <span
          className="inline-flex items-center whitespace-nowrap rounded-md border border-red/40 bg-red/15 px-1.5 py-px text-[11px] font-semibold leading-tight text-red"
          title="status_nf = FAILED — verifique a nota antes de finalizar / imprimir"
        >
          Erro NF
        </span>
      ) : null}
    </span>
  );
}
