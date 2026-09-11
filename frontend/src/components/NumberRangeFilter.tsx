import { Boxes } from "lucide-react";

type Props = {
  label: string;
  min: string;
  max: string;
  onChangeMin: (v: string) => void;
  onChangeMax: (v: string) => void;
};

export default function NumberRangeFilter({ label, min, max, onChangeMin, onChangeMax }: Props) {
  return (
    <div className="min-w-0">
      <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-text-faint">
        {label}
      </label>
      <div className="group flex h-8 items-center rounded-lg border border-border bg-elevated/80 transition focus-within:border-amber/70">
        <Boxes size={14} className="ml-2.5 shrink-0 text-text-faint transition group-focus-within:text-amber" />
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={min}
          onChange={(e) => onChangeMin(e.target.value)}
          placeholder="mín"
          className="w-14 bg-transparent px-2 py-2 text-center text-xs outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="h-4 w-px bg-border" />
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={max}
          onChange={(e) => onChangeMax(e.target.value)}
          placeholder="máx"
          className="w-14 bg-transparent px-2 py-2 text-center text-xs outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
      </div>
    </div>
  );
}
