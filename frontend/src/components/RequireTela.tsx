import { Navigate, Outlet } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { primeiraTelaPermitida, temTela } from "../lib/acessoTelas";

type Props = {
  tela: string;
};

/** Só checa permissão de tela; o layout (TopBar) fica no ProtectedRoute pai. */
export default function RequireTela({ tela }: Props) {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (!temTela(user, tela)) {
    return <Navigate to={primeiraTelaPermitida(user.telas)} replace />;
  }
  return <Outlet />;
}
