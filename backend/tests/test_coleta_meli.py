"""Testes automatizados do módulo e rota de Coleta Meli."""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi.testclient import TestClient
from app.main import app
from app.auth import get_current_user, AuthUser
from app.acesso_telas import TELAS_TODAS, TELA_LABELS, DEFAULTS_POR_ROLE


class TestColetaMeliPermissoes(unittest.TestCase):
    def test_tela_registrada_em_acesso_telas(self):
        self.assertIn("coleta-meli", TELAS_TODAS)
        self.assertEqual(TELA_LABELS.get("coleta-meli"), "Coleta Meli")
        self.assertIn("coleta-meli", DEFAULTS_POR_ROLE["operador"])
        self.assertIn("coleta-meli", DEFAULTS_POR_ROLE["admin"])


class TestColetaMeliRotasAPI(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_rota_bloqueada_sem_autenticacao(self):
        resp = self.client.get("/api/expedicao/coleta-meli")
        self.assertIn(resp.status_code, (401, 403))

    @patch("app.anymarket.consultar_horarios_coleta_meli")
    def test_rota_sucesso_com_usuario_autorizado(self, mock_consulta):
        mock_consulta.return_value = {
            "accountId": 47155,
            "logisticType": "cross_docking",
            "marketplace": "MERCADO_LIVRE",
            "monday": {"work": False},
            "tuesday": {
                "work": True,
                "detail": [{"from": "13:00", "to": "15:00", "cutoff": "09:00"}],
                "capacity": {"value": 425},
            },
        }
        app.dependency_overrides[get_current_user] = lambda: AuthUser(
            usuario="operador1",
            nome="Operador",
            role="operador",
            email=None,
        )
        resp = self.client.get("/api/expedicao/coleta-meli")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["accountId"], 47155)
        self.assertEqual(data["marketplace"], "MERCADO_LIVRE")
        self.assertEqual(data["tuesday"]["capacity"]["value"], 425)

    @patch("app.anymarket.consultar_horarios_coleta_meli")
    def test_rota_erro_anymarket_retorna_502(self, mock_consulta):
        mock_consulta.side_effect = RuntimeError("Erro de conexão AnyMarket")
        app.dependency_overrides[get_current_user] = lambda: AuthUser(
            usuario="admin",
            nome="Admin",
            role="admin",
            email=None,
        )
        resp = self.client.get("/api/expedicao/coleta-meli")
        self.assertEqual(resp.status_code, 502)
        self.assertIn("Falha ao consultar grade", resp.json()["detail"])
