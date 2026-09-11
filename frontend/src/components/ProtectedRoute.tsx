import { useEffect } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuthStore, type AuthUser } from "../store/auth";
import { api } from "../lib/api";
import IdleSessionGuard from "./IdleSessionGuard";
import TopBar from "./TopBar";

export default function ProtectedRoute() {
  const token = useAuthStore((state) => state.token);
  const user = useAuthStore((state) => state.user);
  const updateUser = useAuthStore((state) => state.updateUser);

  useEffect(() => {
    if (!token) return;
    let ativo = true;
    api
      .get<AuthUser>("/auth/me")
      .then(({ data }) => {
        if (!ativo) return;
        const atual = useAuthStore.getState().user;
        updateUser({
          ...data,
          imagem: data.imagem || atual?.imagem || null,
        });
      })
      .catch(() => {});
    return () => {
      ativo = false;
    };
  }, [token, updateUser]);

  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-void">
      <IdleSessionGuard />
      <TopBar />
      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
