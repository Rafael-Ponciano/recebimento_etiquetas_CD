import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Camera,
  Check,
  CloudDownload,
  Columns3,
  Eye,
  EyeOff,
  LayoutGrid,
  Loader2,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { ADMIN_ACESSO, TELAS } from "../lib/acessoTelas";
import { useAuthStore, type AuthUser } from "../store/auth";

type Tab = "perfil" | "seguranca" | "tabela" | "prefetch" | "acesso";

type AcessoOpcao = { usuario: string; nome: string; role: string };

type Props = {
  onClose: () => void;
  onOpenColumns: () => void;
};

function iniciais(nome: string) {
  const partes = nome.trim().split(/\s+/);
  return ((partes[0]?.[0] ?? "") + (partes[1]?.[0] ?? "")).toUpperCase();
}

async function comprimirImagem(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error("Escolha uma imagem de até 5 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Não foi possível ler a imagem."));
      img.src = url;
    });

    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Não foi possível processar a imagem.");
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.72);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ProfileSettingsDialog({ onClose, onOpenColumns }: Props) {
  const user = useAuthStore((state) => state.user)!;
  const updateUser = useAuthStore((state) => state.updateUser);
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("perfil");
  const [nome, setNome] = useState(user.nome);
  const [email, setEmail] = useState(user.email ?? "");
  const [imagem, setImagem] = useState(user.imagem ?? "");
  const [senhaAtual, setSenhaAtual] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [mostrarSenhas, setMostrarSenhas] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const podePrefetch = user.usuario.toLowerCase() === ADMIN_ACESSO.toLowerCase();
  const podeAcesso = podePrefetch;
  const [prefetchOpcoes, setPrefetchOpcoes] = useState<string[]>([]);
  const [prefetchUsuarios, setPrefetchUsuarios] = useState<string[]>([]);
  const [prefetchCarregando, setPrefetchCarregando] = useState(false);
  const [acessoOpcoes, setAcessoOpcoes] = useState<AcessoOpcao[]>([]);
  const [acessoMapa, setAcessoMapa] = useState<Record<string, string[]>>({});
  const [acessoDefaults, setAcessoDefaults] = useState<Record<string, string[]>>({});
  const [acessoSelecionado, setAcessoSelecionado] = useState<string | null>(null);
  const [acessoCarregando, setAcessoCarregando] = useState(false);

  function feedback(error: unknown, fallback: string) {
    const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    setErro(detail ?? (error instanceof Error ? error.message : fallback));
    setSucesso(null);
  }

  useEffect(() => {
    if (!podePrefetch || tab !== "prefetch") return;
    let cancelado = false;
    setPrefetchCarregando(true);
    setErro(null);
    api
      .get<{ usuarios: string[]; opcoes: string[] }>("/etiquetas-prefetch/config")
      .then(({ data }) => {
        if (cancelado) return;
        setPrefetchUsuarios(data.usuarios ?? []);
        setPrefetchOpcoes(data.opcoes ?? []);
      })
      .catch((error) => {
        if (!cancelado) feedback(error, "Não foi possível carregar a pré-baixa.");
      })
      .finally(() => {
        if (!cancelado) setPrefetchCarregando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [podePrefetch, tab]);

  useEffect(() => {
    if (!podeAcesso || tab !== "acesso") return;
    let cancelado = false;
    setAcessoCarregando(true);
    setErro(null);
    api
      .get<{
        efetivo: Record<string, string[]>;
        opcoes: AcessoOpcao[];
        defaults: Record<string, string[]>;
      }>("/acesso-telas/config")
      .then(({ data }) => {
        if (cancelado) return;
        setAcessoOpcoes(data.opcoes ?? []);
        setAcessoMapa(data.efetivo ?? {});
        setAcessoDefaults(data.defaults ?? {});
        setAcessoSelecionado((atual) => {
          if (atual && (data.opcoes ?? []).some((o) => o.usuario === atual)) return atual;
          return data.opcoes?.[0]?.usuario ?? null;
        });
      })
      .catch((error) => {
        if (!cancelado) feedback(error, "Não foi possível carregar o acesso às telas.");
      })
      .finally(() => {
        if (!cancelado) setAcessoCarregando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [podeAcesso, tab]);

  async function selecionarImagem(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setErro(null);
    try {
      setImagem(await comprimirImagem(file));
    } catch (error) {
      feedback(error, "Não foi possível processar a imagem.");
    } finally {
      event.target.value = "";
    }
  }

  async function salvarPerfil(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setSucesso(null);
    setSalvando(true);
    try {
      const avatarEnviado = imagem || null;
      const { data } = await api.put<AuthUser>("/auth/perfil", {
        nome: nome.trim(),
        email: email.trim() || null,
        imagem: avatarEnviado,
      });
      const atualizado: AuthUser = {
        ...data,

        imagem: data.imagem ?? avatarEnviado,
      };
      updateUser(atualizado);
      setImagem(atualizado.imagem ?? "");
      if (avatarEnviado && !data.imagem) {
        setSucesso("Perfil atualizado, mas a imagem pode não ter sido gravada no banco.");
      } else {
        setSucesso("Perfil atualizado.");
      }
    } catch (error) {
      feedback(error, "Não foi possível atualizar o perfil.");
    } finally {
      setSalvando(false);
    }
  }

  async function salvarSenha(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setSucesso(null);
    if (novaSenha !== confirmacao) {
      setErro("A confirmação não corresponde à nova senha.");
      return;
    }
    setSalvando(true);
    try {
      await api.put("/auth/senha", { senha_atual: senhaAtual, nova_senha: novaSenha });
      setSenhaAtual("");
      setNovaSenha("");
      setConfirmacao("");
      setSucesso("Senha alterada com sucesso.");
    } catch (error) {
      feedback(error, "Não foi possível alterar a senha.");
    } finally {
      setSalvando(false);
    }
  }

  async function salvarPrefetch() {
    setErro(null);
    setSucesso(null);
    setSalvando(true);
    try {
      const { data } = await api.put<{ ok: boolean; usuarios: string[] }>(
        "/etiquetas-prefetch/config",
        { usuarios: prefetchUsuarios }
      );
      setPrefetchUsuarios(data.usuarios ?? []);
      setSucesso("Pré-baixa atualizada.");
    } catch (error) {
      feedback(error, "Não foi possível salvar a pré-baixa.");
    } finally {
      setSalvando(false);
    }
  }

  async function salvarAcesso() {
    setErro(null);
    setSucesso(null);
    setSalvando(true);
    try {
      const { data } = await api.put<{ ok: boolean; mapa: Record<string, string[]> }>(
        "/acesso-telas/config",
        { mapa: acessoMapa }
      );
      setAcessoMapa((atual) => ({ ...atual, ...(data.mapa ?? {}) }));
      setSucesso("Acesso às telas atualizado. Os usuários precisam reabrir o app (ou atualizar) para valer.");
    } catch (error) {
      feedback(error, "Não foi possível salvar o acesso às telas.");
    } finally {
      setSalvando(false);
    }
  }

  function togglePrefetchUsuario(login: string) {
    const chave = login.toLowerCase();
    setPrefetchUsuarios((atual) => {
      const tem = atual.some((u) => u.toLowerCase() === chave);
      if (tem) return atual.filter((u) => u.toLowerCase() !== chave);
      return [...atual, login].sort((a, b) => a.localeCompare(b, "pt-BR"));
    });
  }

  function toggleAcessoTela(telaId: string) {
    if (!acessoSelecionado) return;
    if (acessoSelecionado.toLowerCase() === ADMIN_ACESSO.toLowerCase()) return;
    setAcessoMapa((atual) => {
      const lista = atual[acessoSelecionado] ?? [];
      const tem = lista.includes(telaId);
      const proxima = tem
        ? lista.filter((t) => t !== telaId)
        : [...lista, telaId];
      // Sempre manter ao menos Pedidos
      const final = proxima.includes("pedidos") ? proxima : ["pedidos", ...proxima];
      return { ...atual, [acessoSelecionado]: final };
    });
  }

  function restaurarPadraoAcesso() {
    if (!acessoSelecionado) return;
    const op = acessoOpcoes.find((o) => o.usuario === acessoSelecionado);
    const role = op?.role === "admin" ? "admin" : "operador";
    const padrao = acessoDefaults[role] ?? ["pedidos", "historico"];
    setAcessoMapa((atual) => ({ ...atual, [acessoSelecionado]: [...padrao] }));
  }

  const acessoTelasAtuais =
    (acessoSelecionado && acessoMapa[acessoSelecionado]) || [];
  const acessoEhAdminConfig =
    (acessoSelecionado || "").toLowerCase() === ADMIN_ACESSO.toLowerCase();

  const inputClass =
    "h-10 w-full rounded-xl border border-border bg-elevated px-3 text-sm outline-none transition focus:border-amber/70";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <section
        className="flex h-[min(34rem,90vh)] w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <aside className="w-48 shrink-0 border-r border-border-soft bg-elevated/25 p-3">
          <div className="mb-4 px-2 pt-2">
            <p className="font-display text-sm font-semibold">Configurações</p>
            <p className="mt-1 truncate text-[11px] text-text-faint">@{user.usuario}</p>
          </div>
          {[
            { id: "perfil" as const, label: "Meu perfil", icon: <UserRound size={15} /> },
            { id: "seguranca" as const, label: "Segurança", icon: <ShieldCheck size={15} /> },
            { id: "tabela" as const, label: "Tabela", icon: <Columns3 size={15} /> },
            ...(podePrefetch
              ? [{ id: "prefetch" as const, label: "Pré-baixa", icon: <CloudDownload size={15} /> }]
              : []),
            ...(podeAcesso
              ? [{ id: "acesso" as const, label: "Acesso", icon: <LayoutGrid size={15} /> }]
              : []),
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setTab(item.id);
                setErro(null);
                setSucesso(null);
              }}
              className={`mb-1 flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-sm transition ${
                tab === item.id ? "bg-amber/15 text-amber" : "text-text-muted hover:bg-elevated hover:text-text"
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-border-soft px-6">
            <div>
              <h2 className="font-display font-semibold">
                {tab === "perfil"
                  ? "Meu perfil"
                  : tab === "seguranca"
                    ? "Segurança"
                    : tab === "prefetch"
                      ? "Pré-baixa de etiquetas"
                      : tab === "acesso"
                        ? "Acesso às telas"
                        : "Preferências da tabela"}
              </h2>
              <p className="text-xs text-text-faint">
                {tab === "perfil"
                  ? "Atualize seus dados e sua imagem."
                  : tab === "seguranca"
                    ? "Altere sua senha de acesso."
                    : tab === "prefetch"
                      ? "Escolha quais logins pré-baixam no PC em que estiverem logados."
                      : tab === "acesso"
                        ? "Defina quais telas cada login pode abrir."
                        : "Edite as colunas direto na tabela de pedidos."}
              </p>
            </div>
            <button onClick={onClose} className="rounded-lg p-2 text-text-muted hover:bg-elevated hover:text-text">
              <X size={17} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto p-6">
            {tab === "perfil" && (
              <form onSubmit={salvarPerfil}>
                <div className="mb-6 flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="group relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-border bg-amber-dim"
                  >
                    {imagem ? (
                      <img src={imagem} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="font-display text-xl font-semibold text-amber">{iniciais(nome)}</span>
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-void/65 opacity-0 transition group-hover:opacity-100">
                      <Camera size={18} />
                    </span>
                  </button>
                  <div>
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="rounded-lg border border-border bg-elevated px-3 py-2 text-xs hover:border-text-faint"
                    >
                      Alterar imagem
                    </button>
                    {imagem && (
                      <button type="button" onClick={() => setImagem("")} className="ml-2 px-2 py-2 text-xs text-text-muted hover:text-red">
                        Remover
                      </button>
                    )}
                    <p className="mt-2 text-[11px] text-text-faint">JPG, PNG ou WebP, até 5 MB.</p>
                  </div>
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={selecionarImagem} className="hidden" />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-xs text-text-muted">
                    Nome
                    <div className="relative mt-1.5">
                      <UserRound size={15} className="absolute left-3 top-3 text-text-faint" />
                      <input value={nome} onChange={(event) => setNome(event.target.value)} className={`${inputClass} pl-9`} required />
                    </div>
                  </label>
                  <label className="block text-xs text-text-muted">
                    E-mail
                    <div className="relative mt-1.5">
                      <Mail size={15} className="absolute left-3 top-3 text-text-faint" />
                      <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className={`${inputClass} pl-9`} />
                    </div>
                  </label>
                </div>
                <button disabled={salvando} className="mt-6 flex h-10 items-center gap-2 rounded-xl bg-amber px-5 text-sm font-medium text-void disabled:opacity-50">
                  {salvando && <Loader2 size={15} className="animate-spin" />}
                  Salvar perfil
                </button>
              </form>
            )}

            {tab === "seguranca" && (
              <form onSubmit={salvarSenha} className="max-w-md space-y-4">
                {[
                  { label: "Senha atual", value: senhaAtual, set: setSenhaAtual, autoComplete: "current-password" },
                  { label: "Nova senha", value: novaSenha, set: setNovaSenha, autoComplete: "new-password" },
                  { label: "Confirmar nova senha", value: confirmacao, set: setConfirmacao, autoComplete: "new-password" },
                ].map((field) => (
                  <label key={field.label} className="block text-xs text-text-muted">
                    {field.label}
                    <div className="relative mt-1.5">
                      <LockKeyhole size={15} className="absolute left-3 top-3 text-text-faint" />
                      <input
                        type={mostrarSenhas ? "text" : "password"}
                        value={field.value}
                        onChange={(event) => field.set(event.target.value)}
                        autoComplete={field.autoComplete}
                        minLength={field.label === "Senha atual" ? undefined : 8}
                        className={`${inputClass} pl-9 pr-10`}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setMostrarSenhas((value) => !value)}
                        className="absolute right-2 top-2 rounded-md p-1 text-text-faint hover:text-text"
                      >
                        {mostrarSenhas ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </label>
                ))}
                <p className="text-[11px] text-text-faint">Use pelo menos 8 caracteres.</p>
                <button disabled={salvando} className="flex h-10 items-center gap-2 rounded-xl bg-amber px-5 text-sm font-medium text-void disabled:opacity-50">
                  {salvando && <Loader2 size={15} className="animate-spin" />}
                  Alterar senha
                </button>
              </form>
            )}

            {tab === "tabela" && (
              <div className="rounded-2xl border border-border-soft bg-elevated/35 p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber/15 text-amber">
                    <Columns3 size={18} />
                  </span>
                  <div className="flex-1">
                    <h3 className="text-sm font-medium">Colunas dos pedidos</h3>
                    <p className="mt-1 text-xs leading-relaxed text-text-muted">
                      Edite direto na tabela: arraste, oculte e redimensione. As escolhas ficam salvas no seu usuário.
                    </p>
                    <button
                      type="button"
                      onClick={onOpenColumns}
                      className="mt-4 rounded-xl border border-amber/35 bg-amber/10 px-4 py-2.5 text-sm font-medium text-amber hover:bg-amber/15"
                    >
                      Editar colunas na tabela
                    </button>
                  </div>
                </div>
              </div>
            )}

            {tab === "prefetch" && podePrefetch && (
              <div className="space-y-4">
                {prefetchCarregando ? (
                  <div className="flex items-center gap-2 text-sm text-text-muted">
                    <Loader2 size={15} className="animate-spin" />
                    Carregando usuários…
                  </div>
                ) : (
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border-soft p-2">
                    {prefetchOpcoes.length === 0 && (
                      <p className="px-2 py-3 text-xs text-text-faint">Nenhum usuário encontrado.</p>
                    )}
                    {prefetchOpcoes.map((login) => {
                      const ativo = prefetchUsuarios.some(
                        (u) => u.toLowerCase() === login.toLowerCase()
                      );
                      return (
                        <label
                          key={login}
                          className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-elevated"
                        >
                          <input
                            type="checkbox"
                            checked={ativo}
                            onChange={() => togglePrefetchUsuario(login)}
                            className="size-4 accent-cyan"
                          />
                          <span className="font-mono text-xs">@{login}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                <button
                  type="button"
                  disabled={salvando || prefetchCarregando}
                  onClick={salvarPrefetch}
                  className="flex h-10 items-center gap-2 rounded-xl bg-amber px-5 text-sm font-medium text-void disabled:opacity-50"
                >
                  {salvando && <Loader2 size={15} className="animate-spin" />}
                  Salvar pré-baixa
                </button>
              </div>
            )}

            {tab === "acesso" && podeAcesso && (
              <div className="space-y-4">
                {acessoCarregando ? (
                  <div className="flex items-center gap-2 text-sm text-text-muted">
                    <Loader2 size={15} className="animate-spin" />
                    Carregando usuários…
                  </div>
                ) : (
                  <>
                    <label className="block text-xs text-text-muted">
                      Login
                      <select
                        value={acessoSelecionado ?? ""}
                        onChange={(e) => setAcessoSelecionado(e.target.value || null)}
                        className={`${inputClass} mt-1.5`}
                      >
                        {acessoOpcoes.map((op) => (
                          <option key={op.usuario} value={op.usuario}>
                            {op.nome} (@{op.usuario}) · {op.role}
                          </option>
                        ))}
                      </select>
                    </label>

                    {acessoEhAdminConfig ? (
                      <p className="rounded-xl border border-amber/25 bg-amber/10 px-3 py-2.5 text-xs text-amber">
                        Seu login (@{ADMIN_ACESSO}) sempre tem acesso a todas as telas.
                      </p>
                    ) : (
                      <div className="space-y-1 rounded-xl border border-border-soft p-2">
                        {TELAS.map((tela) => {
                          const ativo = acessoTelasAtuais.includes(tela.id);
                          const bloqueado = tela.id === "pedidos";
                          return (
                            <label
                              key={tela.id}
                              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${
                                bloqueado
                                  ? "cursor-default opacity-80"
                                  : "cursor-pointer hover:bg-elevated"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={ativo}
                                disabled={bloqueado}
                                onChange={() => toggleAcessoTela(tela.id)}
                                className="size-4 accent-cyan"
                              />
                              <span>{tela.label}</span>
                              {bloqueado && (
                                <span className="ml-auto text-[10px] text-text-faint">obrigatória</span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={salvando || acessoCarregando || acessoEhAdminConfig}
                        onClick={salvarAcesso}
                        className="flex h-10 items-center gap-2 rounded-xl bg-amber px-5 text-sm font-medium text-void disabled:opacity-50"
                      >
                        {salvando && <Loader2 size={15} className="animate-spin" />}
                        Salvar acesso
                      </button>
                      <button
                        type="button"
                        disabled={salvando || acessoCarregando || acessoEhAdminConfig}
                        onClick={restaurarPadraoAcesso}
                        className="h-10 rounded-xl border border-border-soft px-4 text-sm text-text-muted hover:bg-elevated disabled:opacity-50"
                      >
                        Restaurar padrão do role
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {(erro || sucesso) && (
              <div className={`mt-5 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${
                erro ? "border-red/30 bg-red/10 text-red" : "border-green/30 bg-green/10 text-green"
              }`}>
                {sucesso && <Check size={15} />}
                {erro ?? sucesso}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
