import { useEffect, useRef, useState } from "react";
import { X, Loader2, CircleCheck, CircleX, Package, FileText, Printer } from "lucide-react";
import { api } from "../lib/api";
import type { Pedido } from "../types/pedido";

type Passo = { etapa: string; ok: boolean; mensagem: string };

type Props = {
  pedido: Pedido;
  onClose: () => void;

  modo?: "todos" | "faltantes";
  onConcluido?: (opts?: { status_pedido?: string | null }) => void;
};

const ETAPA_META: Record<string, { label: string; icon: typeof Package }> = {
  validacao_saldo: { label: "Validação de saldo", icon: Package },
  etiqueta_download: { label: "Etiqueta de envio", icon: Package },
  danfe_download: { label: "Nota fiscal (DANFE)", icon: FileText },
  etiqueta_impressao: { label: "Impressão — etiqueta", icon: Printer },
  danfe_impressao: { label: "Impressão — DANFE", icon: Printer },
};

export default function ReimprimirDialog({
  pedido,
  onClose,
  modo = "todos",
  onConcluido,
}: Props) {
  const [passos, setPassos] = useState<Passo[] | null>(null);
  const [docs, setDocs] = useState<string[] | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const promiseRef = useRef<Promise<{
    passos: Passo[];
    docs?: string[];
    mensagem?: string;
    status_pedido?: string | null;
    ok?: boolean;
  }> | null>(null);

  useEffect(() => {
    let ativo = true;

    if (!promiseRef.current) {
      promiseRef.current = api
        .post<{
          passos: Passo[];
          docs?: string[];
          mensagem?: string;
          status_pedido?: string | null;
          ok?: boolean;
        }>(`/pedidos/${pedido.id_any}/imprimir`, {
          status_any: pedido["Status Any"] || null,
          modo,
        })
        .then((response) => response.data);
    }

    promiseRef.current
      .then((data) => {
        if (!ativo) return;
        setPassos(data.passos);
        setDocs(data.docs ?? null);
        setMensagem(data.mensagem ?? null);
        onConcluido?.({ status_pedido: data.status_pedido });
      })
      .catch((e) => {
        if (ativo) setErro(e?.response?.data?.detail ?? "Erro ao reimprimir os documentos.");
      })
      .finally(() => {
        if (ativo) setCarregando(false);
      });
    return () => {
      ativo = false;
    };

  }, [pedido.id_any, modo]);

  const titulo =
    modo === "faltantes" ? "Reimprimindo o que faltou" : "Reimprimindo documentos";
  const docsTxt =
    docs?.length === 1
      ? docs[0] === "etiqueta"
        ? "Só etiqueta"
        : "Só DANFE"
      : docs?.length === 2
        ? "Etiqueta + DANFE"
        : null;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-xl border border-border-soft bg-surface shadow-2xl shadow-black/50">
        <div className="flex items-center justify-between border-b border-border-soft px-5 py-4">
          <div>
            <h2 className="font-display font-semibold text-base">{titulo}</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Pedido {pedido["Pedido Any"] || pedido.id_any} · {pedido.Cliente}
              {docsTxt ? ` · ${docsTxt}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-text-faint hover:text-text transition">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-3">
          {carregando && !passos && (
            <div className="flex items-center gap-2 text-sm text-text-muted py-6 justify-center">
              <Loader2 size={16} className="animate-spin" />{" "}
              {modo === "faltantes"
                ? "Imprimindo documentos pendentes…"
                : "Processando etiqueta e DANFE…"}
            </div>
          )}

          {erro && (
            <div className="flex items-center gap-2 rounded-lg border border-red/30 bg-red/10 px-3 py-2.5 text-sm text-red">
              <CircleX size={15} className="shrink-0" />
              {erro}
            </div>
          )}

          {mensagem && !erro && (
            <p className="text-xs text-text-muted">{mensagem}</p>
          )}

          {passos?.map((p) => {
            const meta = ETAPA_META[p.etapa] ?? { label: p.etapa, icon: Package };
            const Icon = meta.icon;
            return (
              <div
                key={p.etapa}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm ${
                  p.ok ? "border-green/30 bg-green/10" : "border-red/30 bg-red/10"
                }`}
              >
                <Icon size={16} className="shrink-0 text-text-muted" />
                <div className="min-w-0 flex-1">
                  <p>{meta.label}</p>
                  {p.mensagem && (
                    <p className={`mt-0.5 text-xs ${p.ok ? "text-text-faint" : "text-red/90"}`}>
                      {p.mensagem}
                    </p>
                  )}
                </div>
                {p.ok ? (
                  <CircleCheck size={15} className="text-green shrink-0" />
                ) : (
                  <CircleX size={15} className="text-red shrink-0" />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-soft px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg bg-amber px-4 py-2 text-sm font-medium text-void hover:brightness-110 transition"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
