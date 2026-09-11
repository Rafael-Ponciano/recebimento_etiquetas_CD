import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ClipboardPaste, Copy } from "lucide-react";

export type ContextMenuState = {
  x: number;
  y: number;
  copyText: string;
  pasteTarget: HTMLInputElement | HTMLTextAreaElement | null;
};

type Props = {
  menu: ContextMenuState | null;
  onClose: () => void;
};

async function copiarTexto(texto: string) {
  if (!texto) return;
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = texto;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

async function colarNoInput(input: HTMLInputElement | HTMLTextAreaElement) {
  input.focus();
  let texto = "";
  try {
    texto = await navigator.clipboard.readText();
  } catch {
    return;
  }
  if (!texto) return;

  const ok = document.execCommand("insertText", false, texto);
  if (ok) return;

  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const proximo = input.value.slice(0, start) + texto + input.value.slice(end);
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(input, proximo);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const pos = start + texto.length;
  input.setSelectionRange(pos, pos);
}

export default function ContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    function fechar(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function tecla(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", fechar, true);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fechar, true);
      document.removeEventListener("keydown", tecla);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const podeCopiar = Boolean(menu.copyText.trim());
  const podeColar = Boolean(menu.pasteTarget);

  const estilo: CSSProperties = {
    left: Math.min(menu.x, window.innerWidth - 180),
    top: Math.min(menu.y, window.innerHeight - 100),
  };

  return (
    <div
      ref={ref}
      role="menu"
      style={estilo}
      className="fixed z-[100] min-w-[160px] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl shadow-black/50"
    >
      <button
        type="button"
        role="menuitem"
        disabled={!podeCopiar}
        onClick={() => {
          void copiarTexto(menu.copyText).then(onClose);
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text transition hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Copy size={14} className="text-text-faint" />
        Copiar
      </button>
      {podeColar && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            if (menu.pasteTarget) void colarNoInput(menu.pasteTarget).then(onClose);
          }}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text transition hover:bg-elevated"
        >
          <ClipboardPaste size={14} className="text-text-faint" />
          Colar
        </button>
      )}
    </div>
  );
}

const SELETOR_INPUT =
  "input:not([type='checkbox']):not([type='radio']):not([type='file']):not([type='hidden']), textarea, [contenteditable='true']";

export function menuDeContextEvent(e: {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}): ContextMenuState {
  const alvo = e.target as HTMLElement | null;
  const inputEl = alvo?.closest(SELETOR_INPUT) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLElement
    | null;

  const ehInputNativo =
    inputEl instanceof HTMLInputElement || inputEl instanceof HTMLTextAreaElement;
  const input = ehInputNativo ? inputEl : null;
  const selecao = window.getSelection()?.toString() ?? "";

  let copyText = selecao;
  if (!copyText && input) {
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    copyText = start !== end ? input.value.slice(start, end) : input.value;
  }
  if (!copyText && inputEl && !ehInputNativo) {
    copyText = inputEl.textContent ?? "";
  }
  if (!copyText) {
    const celula = alvo?.closest("td, th");
    copyText = celula?.textContent?.trim() ?? "";
  }
  if (!copyText && alvo) {
    const texto = alvo.closest("[data-copy], .font-mono, p, span, label, h1, h2, h3")
      ?.textContent?.trim();
    if (texto && texto.length < 500) copyText = texto;
  }

  const readOnly = Boolean(input && input.readOnly);
  const pasteTarget =
    input && !input.disabled && !readOnly ? input : null;

  return {
    x: e.clientX,
    y: e.clientY,
    copyText,
    pasteTarget,
  };
}

export function GlobalContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      const state = menuDeContextEvent(e);
      const util = Boolean(state.copyText.trim()) || Boolean(state.pasteTarget);
      if (!util) return;
      e.preventDefault();
      setMenu(state);
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  return <ContextMenu menu={menu} onClose={() => setMenu(null)} />;
}
