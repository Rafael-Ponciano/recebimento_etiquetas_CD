import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LoginPage from "./pages/LoginPage";
import PedidosPage from "./pages/PedidosPage";
import HistoricoPage from "./pages/HistoricoPage";
import LogsPage from "./pages/LogsPage";
import PerformancePage from "./pages/PerformancePage";
import BaixaManualPage from "./pages/BaixaManualPage";
import DashboardPage from "./pages/DashboardPage";
import DespachoDemoPage from "./pages/DespachoDemoPage";
import ProtectedRoute from "./components/ProtectedRoute";
import RequireTela from "./components/RequireTela";
import { GlobalContextMenu } from "./components/ContextMenu";
import UpdateChecker from "./components/UpdateDialog";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <GlobalContextMenu />
        <UpdateChecker />
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<RequireTela tela="pedidos" />}>
              <Route path="/" element={<PedidosPage />} />
            </Route>
            <Route element={<RequireTela tela="historico" />}>
              <Route path="/historico" element={<HistoricoPage />} />
            </Route>
            <Route element={<RequireTela tela="dashboard" />}>
              <Route path="/dashboard" element={<DashboardPage />} />
            </Route>
            <Route element={<RequireTela tela="logs" />}>
              <Route path="/logs" element={<LogsPage />} />
            </Route>
            <Route element={<RequireTela tela="performance" />}>
              <Route path="/performance" element={<PerformancePage />} />
            </Route>
            <Route element={<RequireTela tela="baixa-manual" />}>
              <Route path="/baixa-manual" element={<BaixaManualPage />} />
            </Route>
            <Route element={<RequireTela tela="despacho" />}>
              <Route path="/despacho" element={<DespachoDemoPage />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
