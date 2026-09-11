import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";

export type UpdateStatus = {
  enabled: boolean;
  current_version: string;
  latest_version?: string | null;
  update_available: boolean;
  mandatory: boolean;
  notes?: string;
  released_at?: string | null;
  error?: string | null;
  writable?: boolean;
  frozen?: boolean;
};

type UpdateProgress = {
  ativo: boolean;
  fase: string;
  percent: number;
  mensagem: string;
  erro?: string | null;
  to_version?: string | null;
  from_version?: string | null;
  bytes_baixados?: number;
  bytes_total?: number | null;
};

const FASES: Array<{ id: string; label: string }> = [
  { id: "preparando", label: "Preparar" },
  { id: "baixando", label: "Download" },
  { id: "verificando", label: "Verificar" },
  { id: "extraindo", label: "Extrair" },
  { id: "desbloqueando", label: "Desbloquear" },
  { id: "reiniciando", label: "Reiniciar" },
];

function indiceFase(fase: string): number {
  if (fase === "erro") return -1;
  if (fase === "ok" || fase === "reiniciando") return FASES.length - 1;
  const i = FASES.findIndex((f) => f.id === fase);
  return i >= 0 ? i : 0;
}

function formatBytes(n?: number | null): string {
  if (n == null || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UpdateChecker() {
  const [dismissed, setDismissed] = useState(false);
  const [acompanhando, setAcompanhando] = useState(false);
  // As rotas de update exigem sessão; sem token nem consultamos.
  const autenticado = useAuthStore((state) => Boolean(state.token));

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["update-status"],
    queryFn: async () => {
      const { data: resp } = await api.get<UpdateStatus>("/update/status");
      return resp;
    },
    enabled: autenticado,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const { data: progress } = useQuery({
    queryKey: ["update-progress"],
    queryFn: async () => {
      const { data: resp } = await api.get<UpdateProgress>("/update/progress");
      return resp;
    },
    enabled: autenticado && acompanhando,
    refetchInterval: acompanhando ? 400 : false,
  });

  const aplicar = useMutation({
    mutationFn: async () => {
      const { data: resp } = await api.post<{ ok: boolean; message: string; started?: boolean }>(
        "/update/aplicar"
      );
      return resp;
    },
    onMutate: () => {
      setAcompanhando(true);
    },
  });

  useEffect(() => {
    if (aplicar.isError && progress?.fase === "idle") {
      setAcompanhando(false);
    }
  }, [aplicar.isError, progress?.fase]);

  useEffect(() => {
    if (data?.mandatory) setDismissed(false);
  }, [data?.mandatory]);

  const fase = progress?.fase || (acompanhando ? "preparando" : "idle");
  const emAndamento = acompanhando && fase !== "erro" && fase !== "idle";
  const falhou = acompanhando && fase === "erro";
  const reiniciando = fase === "reiniciando";

  const mostrar =
    emAndamento || falhou || (!!data?.enabled && !!data.update_available && !dismissed);

  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
  const idx = indiceFase(fase);

  const titulo = useMemo(() => {
    if (falhou) return "Falha na atualização";
    if (reiniciando) return "Quase pronto";
    if (emAndamento) return "Atualizando…";
    return "Nova versão disponível";
  }, [falhou, reiniciando, emAndamento]);

  const bytesHint = useMemo(() => {
    const baixados = formatBytes(progress?.bytes_baixados);
    const total = formatBytes(progress?.bytes_total);
    if (baixados && total) return `${baixados} / ${total}`;
    if (baixados) return baixados;
    return "";
  }, [progress?.bytes_baixados, progress?.bytes_total]);

  if (!autenticado || isLoading || !mostrar || !data) return null;

  const bloqueadoEscrita = data.writable === false;
  const podeIniciar = !bloqueadoEscrita && !aplicar.isPending && !acompanhando;
  const fromV = progress?.from_version || data.current_version;
  const toV = progress?.to_version || data.latest_version;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-[#05070a]/72 backdrop-blur-[6px]"
        aria-hidden
      />
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 80% 50% at 50% -10%, #3ecf8e 0%, transparent 55%), radial-gradient(ellipse 60% 40% at 90% 100%, #f2a63c 0%, transparent 50%)",
        }}
        aria-hidden
      />

      <div className="relative w-full max-w-[440px] overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.65)]">
        {/* Faixa hazard */}
        <div
          className="h-1.5 w-full"
          style={{
            background:
              "repeating-linear-gradient(-45deg, #f2a63c, #f2a63c 8px, #0a0d11 8px, #0a0d11 16px)",
          }}
        />

        <div className="relative px-5 pb-2 pt-5">
          <div className="flex items-start gap-3">
            <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated">
              <div className="absolute inset-1.5 rounded-md bg-amber/90" />
              <div className="absolute left-1/2 top-1.5 h-2 w-3.5 -translate-x-1/2 rounded-sm bg-green" />
              {emAndamento && !falhou ? (
                <Sparkles size={14} className="relative z-10 text-void animate-pulse" />
              ) : falhou ? (
                <XCircle size={16} className="relative z-10 text-red" />
              ) : reiniciando ? (
                <CheckCircle2 size={16} className="relative z-10 text-green" />
              ) : (
                <RefreshCw size={14} className="relative z-10 text-void" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
                Conferência CD · Recebimento
              </p>
              <h2 className="mt-0.5 font-display text-lg font-semibold tracking-tight text-text">
                {titulo}
              </h2>
            </div>

            {!data.mandatory && !emAndamento && (
              <button
                type="button"
                onClick={() => {
                  setDismissed(true);
                  setAcompanhando(false);
                }}
                className="rounded-lg p-1.5 text-text-faint transition hover:bg-elevated hover:text-text"
                aria-label="Fechar"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* Versões */}
          <div className="mt-4 flex items-center gap-2">
            <span className="rounded-lg border border-border-soft bg-elevated px-2.5 py-1 font-mono text-xs text-text-muted">
              v{fromV}
            </span>
            <ArrowRight size={14} className="shrink-0 text-text-faint" />
            <span className="rounded-lg border border-green/35 bg-green/10 px-2.5 py-1 font-mono text-xs font-medium text-green shadow-[0_0_12px_rgba(62,207,142,0.2)]">
              v{toV}
            </span>
          </div>
        </div>

        <div className="space-y-4 px-5 py-4">
          {!acompanhando && (
            <>
              {data.notes ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-text">{data.notes}</p>
              ) : (
                <p className="text-sm leading-relaxed text-text-muted">
                  Há uma atualização pronta. O download e a instalação aparecem nesta tela.
                </p>
              )}
              {data.mandatory && (
                <div className="flex items-start gap-2 rounded-xl border border-amber/30 bg-amber/10 px-3 py-2.5 text-sm text-amber">
                  <TriangleAlert size={16} className="mt-0.5 shrink-0" />
                  <span>Atualização obrigatória — continue para usar o sistema.</span>
                </div>
              )}
              {(error || data.error) && (
                <div className="rounded-xl border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
                  {data.error || "Falha ao verificar atualização."}
                </div>
              )}
              {bloqueadoEscrita && (
                <p className="text-sm text-red">
                  Pasta sem permissão de escrita. Use Área de Trabalho ou Documentos.
                </p>
              )}
            </>
          )}

          {acompanhando && (
            <>
              <div className="space-y-2">
                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text">
                      {progress?.mensagem || "Aguarde…"}
                    </p>
                    {bytesHint ? (
                      <p className="mt-0.5 font-mono text-[11px] text-text-faint">{bytesHint}</p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 font-mono text-xl font-semibold tabular-nums ${
                      falhou ? "text-red" : "text-green"
                    }`}
                  >
                    {percent}%
                  </span>
                </div>
                <div className="relative h-3 overflow-hidden rounded-full bg-elevated ring-1 ring-border-soft">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ease-out ${
                      falhou
                        ? "bg-red"
                        : "bg-gradient-to-r from-green/80 via-green to-[#7ee7b5]"
                    }`}
                    style={{
                      width: `${falhou ? 100 : percent}%`,
                      boxShadow: falhou ? undefined : "0 0 16px rgba(62,207,142,0.45)",
                    }}
                  />
                </div>
              </div>

              <ol className="space-y-1.5">
                {FASES.map((f, i) => {
                  const ativa = !falhou && i === idx;
                  const feita = !falhou && i < idx;
                  return (
                    <li
                      key={f.id}
                      className={`flex items-center gap-3 rounded-lg px-2 py-1.5 transition ${
                        ativa ? "bg-green/10" : ""
                      }`}
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                          feita
                            ? "bg-green text-void"
                            : ativa
                              ? "border-2 border-green text-green"
                              : "border border-border text-text-faint"
                        }`}
                      >
                        {feita ? <Check size={11} strokeWidth={3} /> : i + 1}
                      </span>
                      <span
                        className={`text-xs font-medium ${
                          feita || ativa ? "text-text" : "text-text-faint"
                        }`}
                      >
                        {f.label}
                      </span>
                      {ativa && !falhou ? (
                        <Loader2 size={12} className="ml-auto animate-spin text-green" />
                      ) : null}
                    </li>
                  );
                })}
              </ol>

              {falhou && (
                <div className="rounded-xl border border-red/30 bg-red/10 px-3 py-3 text-sm text-red">
                  {progress?.erro || "Erro desconhecido na atualização."}
                </div>
              )}

              {reiniciando && (
                <div className="flex items-start gap-2 rounded-xl border border-green/30 bg-green/10 px-3 py-3 text-sm text-green">
                  <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin" />
                  <span>
                    O app fecha e abre a janela de instalação. Não feche essa janela.
                  </span>
                </div>
              )}
            </>
          )}

          {aplicar.isError && !acompanhando && (
            <div className="rounded-xl border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
              {(aplicar.error as { response?: { data?: { detail?: string } } })?.response?.data
                ?.detail ||
                (aplicar.error as Error)?.message ||
                "Falha ao iniciar atualização."}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-soft bg-void/40 px-5 py-3.5">
          {!acompanhando && (
            <>
              <button
                type="button"
                onClick={() => refetch()}
                disabled={isFetching || aplicar.isPending}
                className="rounded-lg px-3 py-2 text-sm text-text-muted transition hover:bg-elevated hover:text-text"
              >
                {isFetching ? <Loader2 size={14} className="animate-spin" /> : "Verificar"}
              </button>
              {!data.mandatory && (
                <button
                  type="button"
                  onClick={() => setDismissed(true)}
                  className="rounded-lg px-3 py-2 text-sm text-text-muted transition hover:bg-elevated hover:text-text"
                >
                  Depois
                </button>
              )}
              <button
                type="button"
                disabled={!podeIniciar}
                onClick={() => aplicar.mutate()}
                className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                style={
                  podeIniciar
                    ? {
                        backgroundColor: "#3ecf8e",
                        color: "#0a0d11",
                        boxShadow: "0 0 20px rgba(62,207,142,0.4)",
                      }
                    : {
                        backgroundColor: "rgba(62,207,142,0.2)",
                        color: "rgba(62,207,142,0.65)",
                      }
                }
              >
                {aplicar.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                Atualizar agora
              </button>
            </>
          )}

          {falhou && (
            <>
              <button
                type="button"
                onClick={() => {
                  setAcompanhando(false);
                  setDismissed(false);
                }}
                className="rounded-lg px-3 py-2 text-sm text-text-muted transition hover:bg-elevated hover:text-text"
              >
                Fechar
              </button>
              <button
                type="button"
                onClick={() => aplicar.mutate()}
                className="inline-flex items-center gap-2 rounded-xl bg-green px-4 py-2.5 text-sm font-semibold text-void transition hover:brightness-110"
              >
                <RefreshCw size={14} />
                Tentar de novo
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
