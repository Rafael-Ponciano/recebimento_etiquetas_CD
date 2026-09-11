"""Testes automatizados do módulo de Despacho e regras de status (Regra §13)."""

import os
import sys
import unittest
from unittest.mock import patch
import pandas as pd

# Garante backend no sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi.testclient import TestClient

from app.main import app
from app.auth import get_current_user, AuthUser
from app.pedidos_service import (
    TARGET_STATUSES,
    STATUS_AG_COLETA,
    _status_pedido_fechado,
    _status_impressao_livre,
    _eh_status_imovel,
    registrar_despacho_pedido,
    estornar_despacho_pedido,
)


class TestDespachoInvariantesStatus(unittest.TestCase):
    """Garante cumprimento estrito da Regra §13 do AGENTS.md."""

    def test_ag_coleta_presente_em_target_statuses(self):
        self.assertIn(STATUS_AG_COLETA, TARGET_STATUSES)
        self.assertIn("Ag. Coleta", TARGET_STATUSES)

    def test_ag_coleta_em_status_pedido_fechado(self):
        fechados = _status_pedido_fechado()
        self.assertIn("ag. coleta", fechados)
        self.assertIn("ag. coleta cd", fechados)

    def test_ag_coleta_em_status_impressao_livre(self):
        livres = _status_impressao_livre()
        self.assertIn("ag. coleta", livres)
        self.assertIn("ag. coleta cd", livres)

    def test_ag_coleta_eh_status_imovel(self):
        """Conferência de bancada não pode reabrir um pedido já em Ag. Coleta."""
        self.assertTrue(_eh_status_imovel("Ag. Coleta"))
        self.assertTrue(_eh_status_imovel("ag. coleta"))


class TestDespachoService(unittest.TestCase):
    """Testa a lógica de negócio do serviço de despacho."""

    def test_rejeita_pedido_cancelado(self):
        with patch("app.pedidos_service._status_despacho_atual", return_value="Cancelado"):
            res = registrar_despacho_pedido("99999", usuario="operador_teste", marketplace="meli")
            self.assertFalse(res["ok"])
            self.assertEqual(res["status"], "Cancelado")
            self.assertIn("cancelado", res["mensagem"].lower())

    def test_rejeita_pedido_nao_conferido(self):
        with patch("app.pedidos_service._status_despacho_atual", return_value="Em separação"):
            res = registrar_despacho_pedido("99999", usuario="operador_teste", marketplace="meli")
            self.assertFalse(res["ok"])
            self.assertIn("conferir na bancada", res["mensagem"].lower())

    def test_rejeita_agendado_sem_nf(self):
        linhas = pd.DataFrame([{"Status CD": "Agendado 15/09", "NF Venda": ""}])
        with (
            patch("app.pedidos_service._status_despacho_atual", return_value="Recebido"),
            patch("app.pedidos_service._linha_df_pedido", return_value=linhas),
        ):
            res = registrar_despacho_pedido("99999", usuario="operador_teste")
            self.assertFalse(res["ok"])
            self.assertIn("nf de venda", res["mensagem"].lower())

    def test_rejeita_agendado_com_nf_mas_status_feito(self):
        linhas = pd.DataFrame([{"Status CD": "Agendado 15/09", "NF Venda": "123456"}])
        with (
            patch("app.pedidos_service._status_despacho_atual", return_value="FEITO"),
            patch("app.pedidos_service._linha_df_pedido", return_value=linhas),
        ):
            res = registrar_despacho_pedido("99999", usuario="operador_teste")
            self.assertFalse(res["ok"])
            self.assertIn("conferido ou recebido", res["mensagem"].lower())

    def test_avisa_pedido_ja_bipado(self):
        with patch("app.pedidos_service._status_despacho_atual", return_value="Ag. Coleta"):
            res = registrar_despacho_pedido("99999", usuario="operador_teste", marketplace="meli")
            self.assertTrue(res["ok"])
            self.assertTrue(res["ja_bipado"])
            self.assertIn("já foi bipado", res["mensagem"].lower())

    @patch("app.pedidos_service.log_evento")
    @patch("app.pedidos_service._salvar_status_no_supabase")
    @patch("app.pedidos_service._atualizar_status_local")
    def test_despacho_com_sucesso(self, mock_atualizar, mock_salvar, mock_log):
        with (
            patch("app.pedidos_service._status_despacho_atual", return_value="Conferido"),
            patch("app.pedidos_service._linha_df_pedido") as mock_linha,
        ):
            mock_linha.return_value.empty = True
            res = registrar_despacho_pedido(
                "88888",
                usuario="operador_teste",
                marketplace="meli",
                chave_nfe="35260100000000000000550010001992101123456789",
                nf_venda="199210",
            )
            self.assertTrue(res["ok"])
            self.assertFalse(res["ja_bipado"])
            self.assertEqual(res["status_any"], STATUS_AG_COLETA)
            mock_atualizar.assert_called_once_with("88888", STATUS_AG_COLETA)
            mock_salvar.assert_called_once_with("88888", STATUS_AG_COLETA, exigir_linha=False)
            mock_log.assert_called_once()

    @patch("app.pedidos_service.log_evento")
    @patch("app.pedidos_service._salvar_status_no_supabase")
    @patch("app.pedidos_service._atualizar_status_local")
    def test_estornar_despacho(self, mock_atualizar, mock_salvar, mock_log):
        with patch("app.pedidos_service._status_despacho_atual", return_value="Ag. Coleta"):
            res = estornar_despacho_pedido("88888", usuario="operador_teste", motivo="Bipado errado")
            self.assertTrue(res["ok"])
            self.assertEqual(res["status_any"], "Conferido")
            mock_atualizar.assert_called_once_with("88888", "Conferido")
            mock_salvar.assert_called_once_with("88888", "Conferido", exigir_linha=False)
            mock_log.assert_called_once()

    def test_rejeita_estorno_sem_despacho_ativo(self):
        with patch("app.pedidos_service._status_despacho_atual", return_value="Conferido"):
            res = estornar_despacho_pedido("88888", usuario="operador_teste")
            self.assertFalse(res["ok"])
            self.assertIn("não possui um despacho ativo", res["mensagem"].lower())

    @patch("app.pedidos_service._salvar_status_no_supabase", return_value=False)
    @patch("app.pedidos_service._linha_df_pedido")
    def test_nao_confirma_despacho_sem_persistencia(self, mock_linha, _mock_salvar):
        mock_linha.return_value.empty = True
        with patch("app.pedidos_service._status_despacho_atual", return_value="Conferido"):
            res = registrar_despacho_pedido("88888", usuario="operador_teste")
            self.assertFalse(res["ok"])
            self.assertIn("persistir", res["mensagem"].lower())


class TestDespachoRotasAPI(unittest.TestCase):
    """Testa os endpoints HTTP FastAPI usando TestClient."""

    def setUp(self):
        self.mock_user = AuthUser(
            usuario="operador.teste",
            nome="Operador Teste",
            role="operador",
        )
        app.dependency_overrides[get_current_user] = lambda: self.mock_user
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    @patch("app.pedidos_service.registrar_despacho_pedido")
    def test_rota_registrar_despacho_sucesso(self, mock_servico):
        mock_servico.return_value = {
            "ok": True,
            "ja_bipado": False,
            "id_any": "12345",
            "status_any": "Ag. Coleta",
            "mensagem": "OK",
        }
        resp = self.client.post(
            "/api/pedidos/12345/registrar-despacho",
            json={"marketplace": "meli", "chave_nfe": "123", "nf_venda": "456"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])
        self.assertEqual(resp.json()["status_any"], "Ag. Coleta")

    @patch("app.pedidos_service.registrar_despacho_pedido")
    def test_rota_registrar_despacho_rejeicao(self, mock_servico):
        mock_servico.return_value = {
            "ok": False,
            "mensagem": "Pedido cancelado",
        }
        resp = self.client.post(
            "/api/pedidos/12345/registrar-despacho",
            json={"marketplace": "meli"},
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("cancelado", resp.json()["detail"].lower())

    @patch("app.pedidos_service.estornar_despacho_pedido")
    def test_rota_estornar_despacho_sucesso(self, mock_servico):
        mock_servico.return_value = {
            "ok": True,
            "id_any": "12345",
            "status_any": "Conferido",
            "mensagem": "Estornado",
        }
        resp = self.client.post(
            "/api/pedidos/12345/estornar-despacho",
            json={"motivo": "Engano"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])

    @patch("app.pedidos_service.consultar_despachos_recentes")
    def test_rota_listar_despachos_recentes(self, mock_consulta):
        mock_consulta.return_value = [
            {"id": 1, "tipo_acao": "DESPACHO", "pedido_id": "12345"}
        ]
        resp = self.client.get("/api/pedidos/despachos/recentes?limite=10")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()["items"]), 1)


if __name__ == "__main__":
    unittest.main()
