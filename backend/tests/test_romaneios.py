"""Testes automatizados do módulo de Romaneios Expedidos."""

import os
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi.testclient import TestClient
from app.main import app
from app.auth import get_current_user, AuthUser
from app.romaneios_service import (
    gerar_codigo_romaneio,
    salvar_romaneio,
    listar_romaneios,
    obter_romaneio,
)


class TestRomaneiosService(unittest.TestCase):
    """Testa a geração, gravação e recuperação de romaneios."""

    def test_gerar_codigo_romaneio_formato(self):
        cod = gerar_codigo_romaneio("meli")
        self.assertTrue(cod.startswith("ROM-"))
        self.assertIn("MELI", cod)
        partes = cod.split("-")
        self.assertEqual(len(partes), 4)

    @patch("app.romaneios_service._salvar_backup_local")
    @patch("app.romaneios_service.log_evento")
    def test_salvar_romaneio_grava_log_e_backup(self, mock_log, mock_backup):
        res = salvar_romaneio(
            codigo_romaneio="ROM-20260914-120000-MELI",
            marketplace="meli",
            transportadora="Mercado Envios",
            operador="Operador Teste",
            pedidos=[
                {"id": "111", "pedido": "PED-111", "nf": "1001", "cliente": "Cliente 1"}
            ],
            confirmado_em="2026-09-14T15:00:00+00:00",
        )
        self.assertEqual(res["codigo_romaneio"], "ROM-20260914-120000-MELI")
        self.assertEqual(res["total_pedidos"], 1)
        mock_log.assert_called_once()
        args, _ = mock_log.call_args
        self.assertEqual(args[0], "Operador Teste")
        self.assertEqual(args[1], "ROMANEIO_EXPEDIDO")
        self.assertEqual(args[3], "ROM-20260914-120000-MELI")
        mock_backup.assert_called_once()

    @patch("app.romaneios_service._buscar_romaneios_supabase")
    def test_listar_romaneios_com_filtro(self, mock_busca):
        mock_busca.return_value = [
            {"codigo_romaneio": "ROM-1", "marketplace": "meli", "total_pedidos": 5},
            {"codigo_romaneio": "ROM-2", "marketplace": "shopee", "total_pedidos": 3},
        ]
        # Sem filtro
        todos = listar_romaneios(dias=30, force_refresh=True)
        self.assertEqual(len(todos), 2)

        # Com filtro marketplace
        so_meli = listar_romaneios(dias=30, marketplace="meli", force_refresh=True)
        self.assertEqual(len(so_meli), 1)
        self.assertEqual(so_meli[0]["codigo_romaneio"], "ROM-1")


class TestRomaneiosRotasAPI(unittest.TestCase):
    """Testa endpoints HTTP dos romaneios."""

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

    @patch("app.romaneios_service.listar_romaneios")
    def test_rota_listar_romaneios(self, mock_listar):
        mock_listar.return_value = [
            {"codigo_romaneio": "ROM-TESTE-1", "marketplace": "meli", "total_pedidos": 10}
        ]
        resp = self.client.get("/api/pedidos/despachos/romaneios?dias=7")
        self.assertEqual(resp.status_code, 200)
        dados = resp.json()
        self.assertEqual(dados["total"], 1)
        self.assertEqual(dados["items"][0]["codigo_romaneio"], "ROM-TESTE-1")

    @patch("app.romaneios_service.obter_romaneio")
    def test_rota_obter_romaneio_sucesso(self, mock_obter):
        mock_obter.return_value = {
            "codigo_romaneio": "ROM-TESTE-1",
            "marketplace": "meli",
            "transportadora": "Mercado Envios",
            "pedidos": [{"id": "1", "pedido": "P1"}],
        }
        resp = self.client.get("/api/pedidos/despachos/romaneios/ROM-TESTE-1")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["codigo_romaneio"], "ROM-TESTE-1")

    @patch("app.romaneios_service.obter_romaneio", return_value=None)
    def test_rota_obter_romaneio_404(self, _mock_obter):
        resp = self.client.get("/api/pedidos/despachos/romaneios/INEXISTENTE")
        self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main()
