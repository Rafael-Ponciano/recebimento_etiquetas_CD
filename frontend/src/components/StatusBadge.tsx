import { corStatusCD } from "../lib/format";
import { useRegras } from "../lib/regras";

export default function StatusBadge({ status }: { status: string }) {
  const regras = useRegras();
  if (!status) return <span className="text-[11px] text-text-faint">—</span>;
  const c = corStatusCD(status, regras);
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-px text-[11px] font-medium leading-tight ${c.text} ${c.bg} ${c.border}`}
    >
      {status}
    </span>
  );
}
