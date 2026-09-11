import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  TriangleAlert,
  UserRound,
  LockKeyhole,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  KeyRound,
  CheckCircle2,
  ArrowLeft,
} from "lucide-react";
import { api } from "../lib/api";
import { primeiraTelaPermitida } from "../lib/acessoTelas";
import { useAuthStore, type AuthUser } from "../store/auth";
import { useQueryClient } from "@tanstack/react-query";

const LEMBRAR_KEY = "conferencia.lembrar";
const VERSAO_BUILD = import.meta.env.VITE_APP_VERSION || "dev";

type Passo = "login" | "recuperar" | "redefinir";

function carregarLembrar(): { usuario: string; senha: string; lembrar: boolean } {
  try {
    const raw = localStorage.getItem(LEMBRAR_KEY);
    if (!raw) return { usuario: "", senha: "", lembrar: false };
    const parsed = JSON.parse(raw) as { usuario?: string; senha?: string };
    return {
      usuario: String(parsed.usuario ?? ""),
      senha: String(parsed.senha ?? ""),
      lembrar: true,
    };
  } catch {
    return { usuario: "", senha: "", lembrar: false };
  }
}

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setSession = useAuthStore((s) => s.setSession);
  const inicial = carregarLembrar();

  const [passo, setPasso] = useState<Passo>("login");
  const [usuario, setUsuario] = useState(inicial.usuario);
  const [senha, setSenha] = useState(inicial.senha);
  const [lembrar, setLembrar] = useState(inicial.lembrar);
  const [identificador, setIdentificador] = useState(inicial.usuario);
  const [codigo, setCodigo] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [confirmarSenha, setConfirmarSenha] = useState("");
  const [mostrarSenha, setMostrarSenha] = useState(false);
  const [mostrarNovaSenha, setMostrarNovaSenha] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [versao, setVersao] = useState(VERSAO_BUILD);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("conferencia.idle_logout") === "1") {
        sessionStorage.removeItem("conferencia.idle_logout");
        setSucesso("Sessão encerrada por inatividade (30 min). Faça login novamente.");
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    api
      .get<{ version?: string }>("/health")
      .then((r) => {
        if (r.data?.version) setVersao(r.data.version);
      })
      .catch(() => {});
  }, []);

  function irPara(destino: Passo) {
    setErro(null);
    setSucesso(null);
    setPasso(destino);
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    if (!usuario.trim() || !senha) {
      setErro("Preencha usuário e senha.");
      return;
    }
    setErro(null);
    setSucesso(null);
    setCarregando(true);
    try {
      const { data } = await api.post("/auth/login", { usuario: usuario.trim(), senha });
      const me = await api.get<AuthUser>("/auth/me", {
        headers: { Authorization: `Bearer ${data.token}` },
      });
      queryClient.clear();
      setSession(data.token, me.data);
      if (lembrar) {
        localStorage.setItem(
          LEMBRAR_KEY,
          JSON.stringify({ usuario: usuario.trim(), senha })
        );
      } else {
        localStorage.removeItem(LEMBRAR_KEY);
      }
      navigate(primeiraTelaPermitida(me.data.telas));
    } catch (err: any) {
      setErro(err?.response?.data?.detail ?? "Usuário ou senha inválidos.");
    } finally {
      setCarregando(false);
    }
  }

  async function handleRecuperar(e: FormEvent) {
    e.preventDefault();
    if (!identificador.trim()) {
      setErro("Informe seu usuário ou e-mail.");
      return;
    }
    setErro(null);
    setSucesso(null);
    setCarregando(true);
    try {
      const { data } = await api.post<{ ok: boolean; mensagem?: string }>("/auth/recuperar-senha", {
        identificador: identificador.trim(),
      });
      setSucesso(data?.mensagem ?? "Código enviado por e-mail.");
      setCodigo("");
      setNovaSenha("");
      setConfirmarSenha("");
      setPasso("redefinir");
    } catch (err: any) {
      setErro(err?.response?.data?.detail ?? "Não foi possível solicitar a recuperação.");
    } finally {
      setCarregando(false);
    }
  }

  async function handleRedefinir(e: FormEvent) {
    e.preventDefault();
    if (!codigo.trim() || !novaSenha || !confirmarSenha) {
      setErro("Preencha código, nova senha e confirmação.");
      return;
    }
    if (novaSenha.length < 8) {
      setErro("A nova senha deve ter pelo menos 8 caracteres.");
      return;
    }
    if (novaSenha !== confirmarSenha) {
      setErro("A confirmação não confere com a nova senha.");
      return;
    }
    setErro(null);
    setSucesso(null);
    setCarregando(true);
    try {
      const { data } = await api.post<{ ok: boolean; mensagem?: string }>("/auth/redefinir-senha", {
        identificador: identificador.trim(),
        codigo: codigo.trim(),
        nova_senha: novaSenha,
      });
      setUsuario(identificador.includes("@") ? usuario : identificador.trim());
      setSenha("");
      setCodigo("");
      setNovaSenha("");
      setConfirmarSenha("");
      setSucesso(data?.mensagem ?? "Senha redefinida. Faça login com a nova senha.");
      setPasso("login");
    } catch (err: any) {
      setErro(err?.response?.data?.detail ?? "Não foi possível redefinir a senha.");
    } finally {
      setCarregando(false);
    }
  }

  const titulo =
    passo === "login"
      ? "Acesse sua conta"
      : passo === "recuperar"
        ? "Recuperar senha"
        : "Definir nova senha";

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-void px-5 py-10">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 50% -10%, rgba(242,166,60,0.14), transparent 55%)",
        }}
      />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber/50 to-transparent" />

      <form
        onSubmit={
          passo === "login" ? handleLogin : passo === "recuperar" ? handleRecuperar : handleRedefinir
        }
        className="relative w-full max-w-[400px] rounded-2xl border border-border-soft bg-surface/95 p-7 shadow-2xl shadow-black/40 sm:p-8"
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <img
            src="/logo.png"
            alt="Conferência CD"
            className="mb-8 h-16 w-auto max-w-[220px] object-contain"
          />
          <h1 className="font-display text-[1.125rem] font-semibold tracking-[-0.02em] text-text">
            {titulo}
          </h1>
          {passo === "recuperar" && (
            <p className="mt-2 text-sm text-text-muted">
              Informe usuário ou e-mail. Enviaremos um código.
            </p>
          )}
        </div>

        {passo === "login" && (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-muted" htmlFor="usuario">
                Usuário
              </label>
              <div className="group flex h-11 items-center gap-3 rounded-xl border border-border bg-elevated px-3.5 transition focus-within:border-amber/70">
                <UserRound size={16} className="shrink-0 text-text-faint transition group-focus-within:text-amber" />
                <input
                  id="usuario"
                  autoFocus={!inicial.usuario}
                  autoComplete="username"
                  value={usuario}
                  onChange={(e) => setUsuario(e.target.value)}
                  placeholder="seu.usuario"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-faint"
                />
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-text-muted" htmlFor="senha">
                  Senha
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setIdentificador(usuario.trim() || identificador);
                    irPara("recuperar");
                  }}
                  className="mr-1 text-xs font-medium text-amber transition hover:brightness-110"
                >
                  Esqueci a senha
                </button>
              </div>
              <div className="group flex h-11 items-center gap-3 rounded-xl border border-border bg-elevated px-3.5 transition focus-within:border-amber/70">
                <LockKeyhole size={16} className="shrink-0 text-text-faint transition group-focus-within:text-amber" />
                <input
                  id="senha"
                  type={mostrarSenha ? "text" : "password"}
                  autoComplete="current-password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  placeholder="Digite sua senha"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-faint"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setMostrarSenha((atual) => !atual)}
                  className="relative z-10 shrink-0 rounded-md p-1 text-text-faint transition hover:bg-surface hover:text-text"
                  aria-label={mostrarSenha ? "Ocultar senha" : "Mostrar senha"}
                >
                  {mostrarSenha ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
          </div>
        )}

        {passo === "recuperar" && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-muted" htmlFor="identificador">
              Usuário ou e-mail
            </label>
            <div className="group flex h-11 items-center gap-3 rounded-xl border border-border bg-elevated px-3.5 transition focus-within:border-amber/70">
              <Mail size={16} className="shrink-0 text-text-faint transition group-focus-within:text-amber" />
              <input
                id="identificador"
                autoFocus
                autoComplete="username"
                value={identificador}
                onChange={(e) => setIdentificador(e.target.value)}
                placeholder="seu.usuario ou e-mail"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-faint"
              />
            </div>
          </div>
        )}

        {passo === "redefinir" && (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-muted" htmlFor="codigo">
                Código do e-mail
              </label>
              <div className="group flex h-11 items-center gap-3 rounded-xl border border-border bg-elevated px-3.5 transition focus-within:border-amber/70">
                <KeyRound size={16} className="shrink-0 text-text-faint transition group-focus-within:text-amber" />
                <input
                  id="codigo"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  className="min-w-0 flex-1 bg-transparent font-mono text-sm tracking-[0.2em] outline-none placeholder:text-text-faint"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-muted" htmlFor="nova-senha">
                Nova senha
              </label>
              <div className="group flex h-11 items-center gap-3 rounded-xl border border-border bg-elevated px-3.5 transition focus-within:border-amber/70">
                <LockKeyhole size={16} className="shrink-0 text-text-faint transition group-focus-within:text-amber" />
                <input
                  id="nova-senha"
                  type={mostrarNovaSenha ? "text" : "password"}
                  autoComplete="new-password"
                  value={novaSenha}
                  onChange={(e) => setNovaSenha(e.target.value)}
                  placeholder="Mínimo 8 caracteres"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-faint"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setMostrarNovaSenha((atual) => !atual)}
                  className="relative z-10 shrink-0 rounded-md p-1 text-text-faint transition hover:bg-surface hover:text-text"
                  aria-label={mostrarNovaSenha ? "Ocultar senha" : "Mostrar senha"}
                >
                  {mostrarNovaSenha ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-muted" htmlFor="confirmar-senha">
                Confirmar nova senha
              </label>
              <div className="group flex h-11 items-center gap-3 rounded-xl border border-border bg-elevated px-3.5 transition focus-within:border-amber/70">
                <LockKeyhole size={16} className="shrink-0 text-text-faint transition group-focus-within:text-amber" />
                <input
                  id="confirmar-senha"
                  type={mostrarNovaSenha ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirmarSenha}
                  onChange={(e) => setConfirmarSenha(e.target.value)}
                  placeholder="Repita a nova senha"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-faint"
                />
              </div>
            </div>
          </div>
        )}

        {passo === "login" && (
          <label className="mt-4 flex cursor-pointer items-center gap-2.5 select-none">
            <input
              type="checkbox"
              checked={lembrar}
              onChange={(e) => setLembrar(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-amber"
            />
            <span className="text-sm text-text-muted">Lembrar meus dados</span>
          </label>
        )}

        {sucesso && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-green/25 bg-green/10 px-3.5 py-3 text-sm text-green">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            <span>{sucesso}</span>
          </div>
        )}

        {erro && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red/25 bg-red/10 px-3.5 py-3 text-sm text-red">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            <span>{erro}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={carregando}
          className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-amber text-sm font-semibold text-void transition hover:brightness-110 active:brightness-95 disabled:cursor-wait disabled:opacity-60"
        >
          {carregando ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {passo === "login"
                ? "Autenticando..."
                : passo === "recuperar"
                  ? "Enviando..."
                  : "Salvando..."}
            </>
          ) : passo === "login" ? (
            <>
              Entrar
              <ArrowRight size={16} />
            </>
          ) : passo === "recuperar" ? (
            <>
              Enviar código
              <Mail size={16} />
            </>
          ) : (
            <>
              Redefinir senha
              <KeyRound size={16} />
            </>
          )}
        </button>

        {passo !== "login" && (
          <button
            type="button"
            onClick={() => {
              if (passo === "redefinir") {
                irPara("recuperar");
              } else {
                irPara("login");
              }
            }}
            className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl text-sm text-text-muted transition hover:bg-elevated hover:text-text"
          >
            <ArrowLeft size={15} />
            {passo === "redefinir" ? "Voltar" : "Voltar ao login"}
          </button>
        )}

        {passo === "redefinir" && (
          <button
            type="button"
            disabled={carregando}
            onClick={() => {
              setErro(null);
              setSucesso(null);
              void (async () => {
                setCarregando(true);
                try {
                  const { data } = await api.post<{ mensagem?: string }>("/auth/recuperar-senha", {
                    identificador: identificador.trim(),
                  });
                  setSucesso(data?.mensagem ?? "Código reenviado por e-mail.");
                } catch (err: any) {
                  setErro(err?.response?.data?.detail ?? "Não foi possível reenviar o código.");
                } finally {
                  setCarregando(false);
                }
              })();
            }}
            className="mt-1 w-full text-center text-xs text-amber transition hover:brightness-110 disabled:opacity-50"
          >
            Reenviar código
          </button>
        )}
      </form>

      <p className="absolute bottom-5 left-0 right-0 text-center font-mono text-[11px] text-text-faint">
        Conferência CD · v{versao}
      </p>
    </main>
  );
}
