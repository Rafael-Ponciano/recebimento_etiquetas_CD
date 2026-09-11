import { create } from "zustand";

export type AuthUser = {
  usuario: string;
  nome: string;
  role: "admin" | "operador";
  email?: string | null;
  imagem?: string | null;
  /** Telas liberadas (vêm de /auth/me). */
  telas?: string[];
};

type AuthState = {
  token: string | null;
  user: AuthUser | null;
  setSession: (token: string, user: AuthUser) => void;
  updateUser: (user: AuthUser) => void;
  logout: () => void;
};

const STORAGE_KEY = "conferencia.auth";
const AVATAR_KEY = "conferencia.avatar";

function persistSession(token: string | null, user: AuthUser | null) {
  if (!token || !user) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(AVATAR_KEY);
    return;
  }

  const { imagem, ...semImagem } = user;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user: semImagem }));
  if (imagem) localStorage.setItem(AVATAR_KEY, imagem);
  else localStorage.removeItem(AVATAR_KEY);
}

function loadInitial(): { token: string | null; user: AuthUser | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { token: null, user: null };
    const parsed = JSON.parse(raw) as { token: string | null; user: AuthUser | null };
    const avatar = localStorage.getItem(AVATAR_KEY);
    if (parsed.user && avatar) parsed.user = { ...parsed.user, imagem: avatar };
    return parsed;
  } catch {
    return { token: null, user: null };
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  ...loadInitial(),
  setSession: (token, user) => {
    persistSession(token, user);
    set({ token, user });
  },
  updateUser: (user) =>
    set((state) => {
      persistSession(state.token, user);
      return { user };
    }),
  logout: () => {
    persistSession(null, null);
    set({ token: null, user: null });
  },
}));
