import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";

/** Tempo sem interação do usuário antes de desconectar. */
export const IDLE_LOGOUT_MS = 30 * 60 * 1000;

const EVENTOS: Array<keyof WindowEventMap> = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
  "wheel",
  "pointerdown",
];

/**
 * Se o usuário ficar 30 min sem mexer no app, faz logout
 * (para as polls do Supabase e volta à tela de login).
 */
export default function IdleSessionGuard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const autenticado = useAuthStore((s) => Boolean(s.token && s.user));
  const logout = useAuthStore((s) => s.logout);
  const timerRef = useRef<number | null>(null);
  const desconectandoRef = useRef(false);

  useEffect(() => {
    if (!autenticado) return;

    desconectandoRef.current = false;

    const limparTimer = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const desconectar = () => {
      if (desconectandoRef.current) return;
      desconectandoRef.current = true;
      limparTimer();
      try {
        sessionStorage.setItem("conferencia.idle_logout", "1");
      } catch {
        // ignore
      }
      void api.post("/auth/logout").catch(() => undefined);
      logout();
      queryClient.clear();
      navigate("/login", { replace: true });
    };

    const reiniciar = () => {
      if (desconectandoRef.current) return;
      limparTimer();
      timerRef.current = window.setTimeout(desconectar, IDLE_LOGOUT_MS);
    };

    reiniciar();
    for (const ev of EVENTOS) {
      window.addEventListener(ev, reiniciar, { passive: true });
    }
    // Foco na janela também conta (voltou do outro monitor / alt-tab).
    window.addEventListener("focus", reiniciar);

    return () => {
      limparTimer();
      for (const ev of EVENTOS) {
        window.removeEventListener(ev, reiniciar);
      }
      window.removeEventListener("focus", reiniciar);
    };
  }, [autenticado, logout, navigate, queryClient]);

  return null;
}
