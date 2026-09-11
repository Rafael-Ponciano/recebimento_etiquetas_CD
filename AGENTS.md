# AGENTS.md — Manual completo do Conferência CD

Manual de referência para humanos e IAs. Em Cursor, este arquivo orienta agentes.
Complementa `README.md` (visão geral) e `INSTALAR.md` (deploy nos PCs).
Versão documentada: ver arquivo `VERSION` na raiz (ex.: `2.0.3`).

---

## 1. Visão geral

App **desktop Windows** de conferência/recebimento B2C no centro de distribuição.

**Faz:** listar pedidos do dia, conferir itens, sincronizar AnyMarket + Google Sheets (Check B2C), imprimir etiqueta/DANFE, histórico, dashboard, performance, logs, baixa manual, auto-update.

**Stack**

| Camada | Tecnologia |
|--------|------------|
| UI | React 19, Vite, TypeScript, TanStack Query/Table, Zustand, Tailwind 4, Lucide |
| API | FastAPI, uvicorn, JWT HS256, bcrypt |
| Desktop | pywebview (Edge/WebView2) — `desktop_window.py` + `backend/run_app.py` |
| Dados | Supabase (Postgres), BigQuery (lista), Google Sheets, AnyMarket |
| Empacote | PyInstaller (`ConferenciaPedidos.spec`), `build.bat` → `release\` |
| Update | `latest.json` no bucket Supabase `app-releases` + ZIP no Google Drive |

**Origem da lista de pedidos:** BigQuery (`BQ_TABELA_PEDIDOS`). Overrides de status: tabela Supabase `pedidos_status_manual`. Saldos de conferência: `conferencia_itens` / `conferencia_recebimentos`.

---

## 2. Árvore do repositório

```
recebimento_etiquetas_CD/
├── VERSION                          # Semver exibida no app / update
├── AGENTS.md                        # Este manual
├── README.md / INSTALAR.md
├── config.ini                       # Segredos locais (NÃO versionar)
├── config.example.ini               # Modelo
├── desktop_window.py                # Janela, splash, js_api Salvar como
├── build.bat                        # Front → static → PyInstaller → release\
├── iniciar_dev.py / iniciar_dev.bat # Dev: API + Vite + janela
├── atualizador.ps1                  # Fallback PowerShell do update
├── recebimento-sa-key.json          # SA BigQuery (raiz; vai p/ release\dados)
├── token_any.json                   # Cache token AnyMarket (runtime)
├── scripts/
│   ├── gerar_pacote_completo.py     # ZIP + latest.json
│   ├── upload_latest_json.py        # Sobe JSON (--also-old; NÃO ZIP)
│   ├── publicar_release.ps1
│   └── old_supabase.ini[.example]   # Credenciais Supabase antigo
├── backend/
│   ├── run_app.py                   # Entry do .exe / boot
│   ├── ConferenciaPedidos.spec
│   ├── requirements.txt
│   ├── static/                      # Front buildado (gerado)
│   └── app/                         # Código da API (ver §4)
├── frontend/src/                    # UI (ver §5)
├── release/                         # Saída do build (PC sem Python)
├── releases/                        # ZIPs + latest.json para publicar
├── downloads/                       # PDFs etiqueta/DANFE
├── _webview_data/                   # Cache WebView2
└── _update/                         # Staging, backup_prev, logs do update
```

**Não editar lógica em:** `release\`, `releases\`, `backend\dist\`, `frontend\dist\`, `frontend\node_modules\`.

---

## 3. Configuração (`config.ini`)

Path canônico: `config/config.ini` (legado: raiz). Defaults abaixo = `backend/app/config.py` se a chave faltar.

| Chave | Default / exemplo | Função |
|-------|-------------------|--------|
| `SUPABASE_URL` | URL do projeto | Supabase |
| `SUPABASE_KEY` | *(obrigatório)* service_role | API Supabase |
| `SUPABASE_TABELA_PEDIDOS` | `pedidos_recebimento` | Legado; lista vem do BQ |
| `BQ_PROJECT` | projeto GCP | BigQuery |
| `BQ_TABELA_PEDIDOS` | `project.dataset.tabela` | Lista de pedidos |
| `BQ_CREDENTIALS_FILE` | `dados/recebimento-sa-key.json` | SA BigQuery |
| `JWT_SECRET` | gerado se vazio | Assina JWT |
| `JWT_EXPIRE_HOURS` | `12` | TTL login |
| `APP_HOST` | `127.0.0.1` | Bind uvicorn |
| `APP_PORT` | `8080` | Porta local |
| `PRINTER_NAME` | nome Windows da impressora | Ghostscript |
| `GHOSTSCRIPT_PATH` | path `gswin64c.exe` | Impressão PDF |
| `PRINT_TIMEOUT_SECONDS` | `20` | Timeout print |
| `DOWNLOADS_RETENCAO_DIAS` | `7` | Retenção PDFs em fila |
| `ORG_ID` | org AnyMarket | API AM |
| `ANYMARKET_EMAIL` / `ANYMARKET_SENHA` | — | Login AM |
| `ANYMARKET_TIMEOUT_SECONDS` | `15` | HTTP AM |
| `GOOGLE_CREDENTIALS_FILE` | `dados/credenciais.json` | SA Sheets |
| `SHEET_ID_B2C` | ID spreadsheet | Check B2C |
| `SHEET_ABA_B2C` | `Check B2C` | Aba |
| `SHEET_COL_STATUS` | `8` (H) | Coluna status |
| `SHEET_COL_OBS_QTD` | `12` (L) | Obs parcial |
| `SHEETS_CACHE_TTL_SECONDS` | `45` | Cache aba |
| `CACHE_PEDIDOS_TTL_SECONDS` | `300` | Cache DF pedidos |
| `CACHE_ITENS_TTL_SECONDS` | `300` | Cache itens AM |
| `LOCK_FINALIZACAO_TTL_SECONDS` | `240` | Lock órfão |
| `STATUS_COLETA_HOJE` | `Conferido` | Status Any sucesso coleta |
| `STATUS_AGENDADO` | `Recebido` | Status Any agendado OK |
| `STATUS_PARCIAL` | `Recebido Parcial` | Parcial (ainda falta receber item físico) |
| `STATUS_RECEBIDO_PENDENTE` | `Recebido - Pendência Any` | 100% recebido, mas finalização (AnyMarket/etiqueta) falhou — ver §4.6 |
| `SHEETS_STATUS_FEITO` | `FEITO` | Item chegou no CD (qtd conferida = total) — ver §4.6 |
| `SHEETS_STATUS_PARCIAL` | `FALTANDO ITEM` | Item parcial |
| `IMPRIMIR_EM_PARCIAL` | `false` | Libera print em parcial |
| `OFFSET_HORAS_TESTE` | `0` | Desloca “hoje” (teste) |
| `SMTP_*` | Gmail 587 TLS | Recuperação de senha |
| `UPDATE_ENABLED` | `true` | Auto-update |
| `UPDATE_BUCKET` | `app-releases` | Bucket latest.json |
| `UPDATE_LATEST_PATH` | `latest.json` | Path no bucket |
| `UPDATE_LATEST_URL` | vazio | URL absoluta opcional |
| `UPDATE_CHECK_TTL_SECONDS` | `300` | Cache check update |

JWT: algoritmo `HS256`. Pastas runtime: `config/`, `dados/`, `tools/`, `logs/`.

---

## 4. Backend (`backend/app/`)

### 4.1 Módulos principais

| Arquivo | Responsabilidade |
|---------|------------------|
| `main.py` | FastAPI, CORS, routers, `/api/health`, static, startup limpeza downloads (bg) |
| `config.py` / `config_merge.py` | INI + merge de chaves novas no update |
| `run_app.py` *(pasta backend/)* | Boot .exe, porta, uvicorn, splash |
| `pedidos_service.py` | ★ Núcleo: lista, conferir, finalizar, lote, reimprimir |
| `anymarket.py` | Token, enviar/conferir, etiqueta, DANFE, desmarcar |
| `bigquery_pedidos.py` | `ler_pedidos_do_bigquery()` |
| `google_sheets.py` | `atualizar_status_item_planilha(...)` |
| `printing.py` | `print_pdf` via Ghostscript |
| `pdf_util.py` | Magalu: mantém só 1ª página da etiqueta |
| `supabase_client.py` / `supabase_pedidos.py` | Cliente + status pedido |
| `status_manual_service.py` | Override Baixa Manual |
| `auth.py` | Login bcrypt, JWT |
| `acesso_telas.py` | Mapa usuário → telas |
| `historico_service.py` / `dashboard_service.py` / `performance_service.py` | Telas admin/ops |
| `etiqueta_prefetch.py` | Prefetch PDFs em background |
| `downloads_cleanup.py` | Apaga PDFs antigos (**não** dispara BQ no boot) |
| `presenca_service.py` | Quem está no pedido |
| `update_service.py` | Checa/baixa update |
| `atualizador_runtime.py` | Aplica ZIP; `backup_prev` |
| `sheets_erros_service.py` / `finalizacao_erros_service.py` | Filas de erro na TopBar |
| `email_smtp.py` | Recuperação de senha |
| `usuarios_service.py` | `listar_usuarios` (usado por `acesso_telas_router` / `etiqueta_prefetch_router`) |
| `timeutil.py` / `version.py` | Fuso BR / versão |

### 4.2 Boot do `.exe`

1. Splash nativo Win32  
2. Migra layout legado + merge `config.ini`  
3. Exige config + `SUPABASE_KEY`  
4. **Libera porta** `APP_PORT` (mata PID LISTENING anterior — reopen rápido)  
5. Importa `app.main` (pesado) com splash nativo ainda aberto  
6. Uvicorn em thread (`Server.should_exit` ao fechar)  
7. `desktop_window.abrir_janela` → splash HTML “Carregando serviços…” (~10s máx, com retry liberando porta)  
8. `GET /api/health` OK → carrega UI (`static/`)  
9. Limpeza de downloads e limpeza leve de cache WebView **não bloqueiam** o health  

Modo `--atualizar`: processo separado → `atualizador_runtime.main`.  
Log de falha: `logs/conferencia_erro.log`.

### 4.3 Tabelas Supabase (uso no código)

| Tabela | Campos principais |
|--------|-------------------|
| `usuarios` | `usuario`, `senha_hash`, `nome`, `role`, `email`, `imagem`, `ativo`, `reset_*` |
| `pedidos_status_manual` | `id_any`, `status_any`, `usuario`, `observacao`, `atualizado_em` |
| `conferencia_itens` | `order_id`, `line_key`, `item_id`, `sku`, qtds, `status`, `conferido_por`, sync Sheets |
| `conferencia_recebimentos` | recebimentos parciais por linha/operador |
| `conferencia_finalizacoes` | lock de finalização (`PROCESSANDO`…) |
| `conferencia_presenca` | `order_id` + `operador` |
| `conferencia_performance` | tempos por pedido/usuário |
| `preferencias_usuario` | `usuario`, `tela`, `preferencias` JSON (colunas, acesso-telas, prefetch) |
| `logs` | auditoria |

> `chat_mensagens` (tabela) e o bucket `chat-temp` **não são mais usados pelo código** (chat removido, §10) mas ainda existem no projeto Supabase até serem apagados manualmente lá — não fazem parte do schema efetivo do app.

**Storage:** `app-releases`.

**RPCs usadas:** `registrar_recebimento_item`, `tentar_iniciar_finalizacao_pedido`, `concluir_finalizacao_pedido`, `liberar_lock_finalizacao_pedido`, `registrar_resultado_sync_sheets`, `resetar_saldo_conferencia`, `registrar_conferencia_performance`, `listar_conferencia_performance`, `limpar_retencao`, `obter_perfil_usuario` (+ RPC de perfil no auth).

> Não há pasta `sql/` versionada no repo atual; schema efetivo = uso no Python + RPCs no projeto Supabase.

### 4.4 Auth e telas

- Login: `POST /api/auth/login` → bcrypt em `usuarios` → JWT (`usuario`, `nome`, `role`, `email`, `exp`)  
- Roles: `operador` | `admin`  
- Telas efetivas via `acesso_telas` (não só role):

| id | Label | Default operador | Default admin |
|----|-------|------------------|---------------|
| `pedidos` | Pedidos | ✓ | ✓ |
| `historico` | Histórico | ✓ | ✓ |
| `dashboard` | Dashboard | | ✓ |
| `logs` | Logs | | ✓ |
| `performance` | Performance | | ✓ |
| `baixa-manual` | Baixa manual | | ✓ |

Override global: `preferencias_usuario` do usuário `rafael.silva`, tela `acesso-telas`. Só esse usuário edita via `/api/acesso-telas`.

### 4.5 API HTTP (`/api`)

**Health:** `GET /api/health` → `{ status, version, regras }`.

#### Auth `/api/auth`
| Método | Path | Uso |
|--------|------|-----|
| POST | `/login` | JWT |
| GET | `/me` | Perfil + telas |
| GET | `/resumo-dia` | Peças/tempo do dia |
| PUT | `/perfil` | Nome/e-mail/imagem |
| PUT | `/senha` | Troca senha |
| POST | `/recuperar-senha` | Código e-mail |
| POST | `/redefinir-senha` | Nova senha |
| POST | `/logout` | Log |

#### Pedidos `/api/pedidos`
| Método | Path | Uso |
|--------|------|-----|
| GET | `/` | Lista (BQ + status manual) |
| GET | `/{id}/itens` | Itens + saldo |
| POST | `/{id}/conferir-item` | Conferência item/parcial |
| POST | `/{id}/desmarcar-conferencia` | Admin desfaz |
| POST | `/{id}/retomar-finalizacao` | Retoma pós-falha ou libera agendado Recebido (`forcar_conferencia`) |
| POST | `/{id}/imprimir` | Reimprimir |
| POST | `/{id}/presenca` / DELETE | Heartbeat presença |
| POST | `/lote/passo` | Fase lote (`conferir\|baixar\|imprimir\|planilha`) + `forcar_conferencia` |
| POST | `/lote/imprimir` | Reimprimir lote |
| GET/POST | `/erros-sheets*` | Fila Check B2C |
| GET/POST | `/erros-finalizacao*` | Fila finalização |

#### Outros
| Prefix | Rotas |
|--------|-------|
| `/api/historico` | Lista + detalhe timeline |
| `/api/dashboard` | KPIs |
| `/api/logs` | Lista; limpar retenção (admin) |
| `/api/performance` | Tempos + POST tempo-cliente |
| `/api/baixa-manual` | status / buscar / aplicar |
| `/api/preferencias/{tela}` | GET/PUT colunas etc. |
| `/api/update` | status / progress / aplicar |
| `/api/etiquetas-prefetch` | status + config |
| `/api/acesso-telas` | GET/PUT config |

### 4.6 Status e transições (`pedidos_service`)

**Item (planilha / saldo local)**  
`Pendente` → `FALTANDO ITEM` (parcial) → `FEITO` (completo). Cancelado → Sheets `CANCELADO`.

> **`FEITO` na planilha = "chegou fisicamente no CD", não "pedido deu certo".** É decidido só por `quantidade_conferida == quantidade_total` (`conferir_item_parcial`), gravado **antes e independente** de qualquer resultado de AnyMarket, impressão ou do Status Any final do pedido — inclusive em pedido **agendado**, onde o Sheets FEITO é síncrono no recebimento e a AnyMarket/etiqueta só rodam depois, na coleta. Se o item deu erro de impressão ou de sync com a AnyMarket, a planilha continua `FEITO` — o erro fica só no pedido (fila de erros), não desfaz o registro de recebimento físico. A única exceção que sobrescreve isso é pedido **Cancelado**: aí a planilha vai para `CANCELADO` mesmo que a quantidade já tivesse fechado.

**Pedido — Status Any (sucesso)**

| Situação | Status Any (default config) |
|----------|----------------------------|
| Coleta hoje OK (ou agendado **com** forçar conferência) | `Conferido` (`STATUS_COLETA_HOJE`) |
| Agendado OK **sem** forçar | `Recebido` (`STATUS_AGENDADO`) — pula AM/etiqueta |
| Conferência parcial (ainda falta receber item físico) | `Recebido Parcial` |
| Só erro de impressão | Ainda grava Conferido/Recebido + aviso |
| **Itens 100% recebidos, mas erro na finalização** (AnyMarket/NF/etiqueta) | `Recebido - Pendência Any` (`STATUS_RECEBIDO_PENDENTE`) — ver nota abaixo |
| Já estava num status terminal (Conferido/Recebido/FEITO/Cancelado) e uma nova tentativa falhou | Mantém o status terminal — não regride |
| Cancelado | Bloqueia alteração (exceto baixa manual admin) |
| Desmarcar (admin) | Reabre; reset saldos — aceita `Recebido - Pendência Any` também |
| Reimpressão limpando histórico só-impressão | `AG AJUSTE` → `Conferido` |

> **Correção de bug (ago/2026):** `_status_manter_apos_falha` costumava relogar o status que já estava salvo — e como `conferir_item_parcial` grava `Recebido Parcial` como placeholder de "ainda conferindo" a cada item que **não** é o último, um pedido de N itens ficava preso em `Recebido Parcial` se o último item desse erro na AnyMarket (ex.: NF), mesmo com os itens 100% recebidos fisicamente e já marcados `FEITO` na planilha. Toda chamada a `_status_manter_apos_falha` só acontece depois de `_todas_linhas_feitas` confirmar recebimento completo — por isso agora, se o status atual for só um placeholder (`Recebido Parcial`, vazio, `AG AJUSTE`/`Finalizando` legados), ela devolve `status_recebido_pendente` em vez de repetir o placeholder. Se já for um status terminal, comportamento inalterado. `Recebido - Pendência Any` **não** entra em `_status_pedido_fechado`/`ehStatusFechadoCd` — continua contando como pendente em "Pendentes Hoje"/"Coleta Hoje", e `retomar_finalizacao_pedido` continua funcionando nele (não é tratado como "imóvel"). Reprint continua bloqueado até resolver (mesma regra de `Recebido Parcial`); a fila de erros de finalização (TopBar) já pegava esse caso antes via `FINALIZACAO_PENDENTE` e continua pegando.

> **Liberação antecipada de pedidos agendados (`Recebido` → `Conferido`):** pedidos agendados com itens 100% recebidos e marcados `FEITO` no Sheets ficam com Status Any `Recebido`. Se a NF de venda for emitida antes da data oficial de coleta e a operação desejar antecipar o despacho, qualquer operador pode usar o botão **"Liberar / Emitir Hoje"** (ou conferência com forçar ativo). O backend (`retomar_finalizacao_pedido` com `forcar_conferencia=True`) envia os dados para a AnyMarket, baixa etiqueta/DANFE, imprime e atualiza para `Conferido`, sem exigir privilégio de admin nem desmarcar itens na AnyMarket/Sheets.

**Status CD** (coluna UI): derivado — Coleta Hoje, Agendado DD/MM, Atrasado, etc.

**Lote elegível:** pedido exclusivo **WD** / **H7** / **Vonixx** / **WD+H7** (`_classificar_produto_lote` / `_pedido_elegivel_lote_produto`). Status lote: Em separação | A conferir.

**Funções públicas típicas:** `get_pedidos_df`, `obter_itens_pedido`, `conferir_item_parcial`, `conferir_pedido_integral`, `executar_lote_passo`, `desmarcar_conferencia_pedido`, `retomar_finalizacao_pedido`, `reimprimir_pedido` / `reimprimir_lote`, reattempts Sheets/finalização.

### 4.7 Lock de finalização (concorrência) — `pedidos_service.py`

Camada mais arriscada do arquivo (127KB / ~90 funções): garante que dois operadores não finalizem o mesmo pedido ao mesmo tempo e que um pedido nunca fique "preso" (lock travado) por falha de rede. Antes de mexer em `conferir_item_parcial`, `conferir_pedido_integral`, `lote_fase_*` ou `retomar_finalizacao_pedido`, ler isto — não só o nome das funções.

**Tabela de controle:** `conferencia_finalizacoes` (`order_id`, `operador`, `status` = `PROCESSANDO`/outro, `iniciado_em`, `finalizado_em`).

**Fluxo de aquisição (`_adquirir_lock_finalizacao`):**

1. Chama RPC `tentar_iniciar_finalizacao_pedido`. Se `true` → lock adquirido, segue.
2. Se `false`/erro → busca a linha do lock (`_consultar_lock_finalizacao`).
   - Dono = mesmo operador **e** lock não órfão (`_lock_finalizacao_orfao`) → reusa sem liberar (permite retomar após, ex., falha só de impressão).
   - Caso contrário → força liberação (`_liberar_lock_finalizacao`), espera 0.2s, tenta a RPC de novo.
   - Se ainda falhar → retorna `False` (log `LOCK_FINALIZACAO_OCUPADO`); quem chamou trata como "outro operador está finalizando".
3. **Órfão** (`_lock_finalizacao_orfao`) = já tem `finalizado_em`, ou `status != "processando"`, ou sem `iniciado_em`, ou `iniciado_em` mais velho que `LOCK_FINALIZACAO_TTL_SECONDS` (default 240s/config.ini). Só depois desse TTL um lock de outro operador pode ser tomado.
4. **Liberação** (`_liberar_lock_finalizacao`) tenta em cascata: RPC `liberar_lock_finalizacao_pedido` → `DELETE` na linha → `UPDATE` forçando `iniciado_em` antigo. Só levanta erro se as três falharem.

**Execução (`_executar_finalizacao_com_lock`):** roda `_finalizar_pedido_completo` dentro de try/except/finally.
- Sucesso → retorna `ok=True` com status/erros/tempos; se o resultado pedir `liberar_lock_em_background`, o lock **não** é liberado aqui (fica pra outro fluxo).
- Exceção → loga `ERRO_FINALIZACAO`, recalcula status via `_status_manter_apos_falha`, grava local + Supabase, retorna `ok=False` (pedido some da tela de "processando" mas com erro registrado).
- **`finally`: sempre chama `_concluir_finalizacao`** (exceto quando liberação foi adiada) — é essa garantia que impede lock travado mesmo se `_finalizar_pedido_completo` explodir no meio.
- `_concluir_finalizacao` chama RPC `concluir_finalizacao_pedido`; se a própria RPC falhar (rede), cai para `_liberar_lock_finalizacao` como último recurso — nunca deve deixar `conferencia_finalizacoes` com `status=PROCESSANDO` esquecido.

**Regra para IA:** qualquer mudança nesse bloco precisa preservar a garantia "lock sempre libera no fim, sucesso ou falha". Testar manualmente forçando uma exceção dentro do bloco protegido antes de dar como pronto.

### 4.8 Integrações — entry points

| Sistema | Módulo | Funções-chave |
|---------|--------|---------------|
| BigQuery | `bigquery_pedidos.py` | `ler_pedidos_do_bigquery` |
| AnyMarket | `anymarket.py` | `enviar_para_conferencia`, `conferir_produtos`, `desmarcar_conferencia`, `get_order_items`, `baixar_etiqueta`, `baixar_documento`, `garantir_etiqueta_magalu_1_pagina` |
| Sheets | `google_sheets.py` | `atualizar_status_item_planilha` |
| Impressão | `printing.py` | `print_pdf` |
| PDF Magalu | `pdf_util.py` | 1ª página apenas |
| Prefetch | `etiqueta_prefetch.py` | `enfileirar_de_df` |

> **`tempo_integracao` (coluna calculada, não vem do BQ):** `bigquery_pedidos._calcular_tempo_integracao()` = `data_back − data_pedido` (`Data Back`/`Data`). Enquanto `data_back` não existe, conta ao vivo usando "agora" — é o indicador de "há quanto tempo esse pedido espera integrar". **Exceção:** pedido **Cancelado** (`Status Any` contém "cancel") que nunca chegou a ter `data_back` nunca vai ganhar esse timestamp (não existe evento de integração pra gravar); nesse caso o cálculo NÃO usa "agora" — fica em branco, em vez de crescer indefinidamente a cada refresh da lista (bug corrigido em ago/2026; antes disso pedidos cancelados antigos chegavam a mostrar milhares de horas). Cancelado que já tinha `data_back` antes de cancelar mantém o tempo real congelado normalmente.

---

## 5. Frontend (`frontend/src/`)

### 5.1 Rotas (`App.tsx`)

| Path | Página | Tela |
|------|--------|------|
| `/login` | LoginPage | pública |
| `/` | PedidosPage | `pedidos` |
| `/historico` | HistoricoPage | `historico` |
| `/dashboard` | DashboardPage | `dashboard` |
| `/logs` | LogsPage | `logs` |
| `/performance` | PerformancePage | `performance` |
| `/baixa-manual` | BaixaManualPage | `baixa-manual` |

Shell: `ProtectedRoute` → `IdleSessionGuard` + `TopBar` + Outlet. Globais: `UpdateChecker`, `GlobalContextMenu`.

### 5.2 Páginas

| Página | Função |
|--------|--------|
| PedidosPage | ★ Lista, filtros, conferir, lote, export XLSX, colunas |
| HistoricoPage | Conferências passadas + reimpressão |
| DashboardPage | Operacional do dia + produtividade |
| LogsPage | Auditoria (+ CSV) |
| PerformancePage | Tempos por etapa |
| BaixaManualPage | Ajuste manual Status Any |
| LoginPage | Login / recuperar senha |

### 5.3 Componentes críticos

| Componente | Função |
|------------|--------|
| `ConferirDialog` | Conferência unitária; suporte a "Liberar / Emitir Hoje" em agendados Recebido com NF |
| `ImpressaoLoteDialog` | Lote conferir→baixar→imprimir→planilha; checkbox forçar agendados |
| `IdleSessionGuard` | Logout **30 min** idle |
| `UpdateDialog` | Auto-update UI |
| `TopBar` | Nav, resumo dia, erros Sheets/finalização, prefetch, perfil |
| `ReimprimirDialog` | Rebaixa/reimprime |
| `SheetsErrosDialog` / `FinalizacaoErrosDialog` | Filas de erro |
| `ProfileSettingsDialog` | Perfil, senha, prefetch, acesso telas |
| `QuickFilterCard` / `StatusCdComNf` / filtros Date/Number/MultiSelect | UX Pedidos |

### 5.4 `lib/` e stores

| Módulo | Uso |
|--------|-----|
| `api.ts` | axios `baseURL: "/api"` + Bearer; 401 → logout |
| `filtrosPedidos.ts` | Filtros rápidos/operacionais, WD/H7/Vonixx |
| `exportarPedidosXlsx.ts` | SheetJS + Salvar como |
| `regras.ts` | Regras do `/health` |
| `acessoTelas.ts` | Catálogo telas / `temTela` |
| `pedidoItens.ts` | Prefetch itens |
| `format.ts` / `marketplace.ts` | Formatação / MKP |

**Zustand**  
- `auth`: `token`, `user` (persist `conferencia.auth`)  
- `ui`: `columnEditMode`

### 5.5 Tipo `Pedido`

Campos: `Status CD`, `id_any`, `Pedido`, `Data`, `Data Coleta`, `Cliente`, `CPF`, `Status Any`, `Item`, `QTND`, `filial_seller`, `Pedido Seller`, `Pedido Any`, `Mkp`, `NF Venda`, `NF Seller`, `ean`, `status_nf?`, `status_pedido?`, `tempo_integracao?`.

### 5.6 Filtros rápidos (Pedidos)

**Union:** `atrasados` | `coletaHoje` | `coletaHojePendentes` | `coletaHojePendentesSemCd` | `agendadosRecebidosCd` | `recebidosParcialmente` | `cancelados` | `soWd` | `soH7` | `soWdH7` | `wdParaConferir` | `vonixxParaConferir` | `erroNf` | `nfComErro` | `erroIntegracao`

**Cards na UI:** Pendentes Hoje, Pendentes Hoje S/ CD, Agendados Recebidos no CD, Recebidos parcial, Coleta Hoje, WD para Conferir, Vonixx para Conferir, Só H7, Sem NF, Erro NF, Atrasados, Erro Integração.

**Lote liberado com:** `wdParaConferir` | `vonixxParaConferir` | `soWd` | `soH7` | `soWdH7`.

**Vonixx/WD para Conferir:** pedido exclusivo + NF + Em separação|A conferir. Vonixx exige coleta ≤ hoje; WD permite coletas futuras (ativando por padrão forçar conferência nos modais unitário e lote).

### 5.7 Export XLSX

Linhas filtradas (pré-paginação) + colunas visíveis → SheetJS → salvar: `pywebview.api.salvar_arquivo` → `showSaveFilePicker` → download âncora.

### 5.8 Dev vs produção

- Sempre `/api` relativo.  
- **Dev:** Vite `:5173` proxy → `127.0.0.1:8080`.  
- **Prod:** FastAPI serve `static/` + `/api` na mesma origem (`APP_PORT`).

---

## 6. Update e release

### 6.1 Como o PC atualiza

1. Poll `GET /api/update/status` → lê `latest.json` no Supabase  
2. Só atualiza se `version` remota **estritamente maior** que a local  
3. Baixa ZIP da `url` (Drive), valida `sha256`  
4. Lança atualizador → backup `_update/backup_prev` → copia → merge config → reabre exe  

**Rollback**

| Situação | Ação |
|----------|------|
| Falha no meio do update | Restaura `backup_prev` automaticamente |
| Versão nova ruim | Copiar `_update/backup_prev` de volta sobre a pasta do app (preservar `config/`, `dados/`) |
| Rollback “oficial” para todos | Publicar **versão maior** com binário antigo + novo `latest.json` |

> Publicar `2.0.0` com PCs em `2.0.2` **não** dispara update.

### 6.2 Publicar release

```
1. Editar VERSION
2. build.bat
3. python scripts/gerar_pacote_completo.py --notes "..." --drive-url "https://drive/..."
4. Substituir o ZIP no Drive (mesmo link ou novo)
5. python scripts/upload_latest_json.py --also-old
```

- ZIP **não** vai para o Supabase (só `latest.json`).  
- `--also-old` espelha o JSON no Supabase antigo (PCs pré-migração).  
- Artefato: `releases/ConferenciaPedidos-{VERSION}.zip` + `releases/latest.json`.

---

## 7. Glossário

| Termo | Significado |
|-------|-------------|
| Status Any | Status operacional persistido (Conferido, Recebido, …) |
| Status CD | Rótulo derivado do dia na UI |
| id_any | ID do pedido na AnyMarket |
| FEITO | Produto **chegou fisicamente no CD** (quantidade conferida = total). Sinal de recebimento na planilha, independente de erro/status posterior no Status Any — ver nota em §4.6 |
| Check B2C | Aba Google Sheets de recebimento |
| forçar conferência | Em lote: agendado segue fluxo de coleta hoje → Conferido |
| AG AJUSTE | Estado de ajuste pós-falha de impressão / legado |
| Recebido - Pendência Any | Itens 100% recebidos, mas erro na finalização (AnyMarket/NF/etiqueta) — ver §4.6 |
| backup_prev | Snapshot da versão anterior em `_update/` |

---

## 8. Regras para agentes (IA)

1. **Não commitar** `config.ini`, SA keys, `token_any.json`, ZIPs grandes.  
2. Status/conferência → `pedidos_service.py` (+ `filtrosPedidos.ts` / dialogs se UI).  
3. Boot/porta/splash → `run_app.py` + `desktop_window.py`.  
4. Update/release → `update_service.py`, `atualizador_runtime.py`, `scripts/*`.  
5. Front build deve ir para `backend/static` (`build.bat`).  
6. Diffs focados; não reescrever `pedidos_service.py` inteiro sem necessidade.  
7. **Chat foi removido de vez** (código deletado, não só desligado) — não recriar `chat_service.py`/`chat_router.py` nem religar isso na UI sem pedido explícito (ver §10).  
8. Lembrar reopen rápido (libera porta 8080) e splash ≤ ~10s.  
9. Magalu: etiqueta PDF só página 1 (`pdf_util` / `anymarket`).  
10. Preferir ler este manual + abrir só os arquivos da área afetada.  
11. Rota de API mudou (path, request, response)? Rodar `scripts/gerar_openapi.bat` e conferir `docs/openapi.json` antes de assumir o contrato antigo.  
12. Tabela/coluna/RPC do Supabase mudou? Rodar `scripts/gerar_schema_supabase.bat` e conferir `docs/schema_supabase.json` — não confiar de memória no schema.  
13. Qualquer status novo em `pedidos_service.py` (Status Any) precisa ser somado em três lugares ao mesmo tempo, senão gera um bug parecido com o de `Recebido Parcial` travado (§4.6): `TARGET_STATUSES` (backend, senão não ganha Status CD), `_status_pedido_fechado`/`ehStatusFechadoCd` (decidir se conta como "fechado" — errar aqui faz o pedido sumir ou não sumir de "Pendentes Hoje" incorretamente) e `_status_impressao_livre`/`statusLiberamImpressao` (decidir se libera reimpressão).

---

## 9. Ordem de leitura sugerida (nova IA)

1. `AGENTS.md` (este arquivo)  
2. `VERSION`  
3. `docs/openapi.json` — contrato exato de request/response de cada rota (gerado; ver §11)  
4. `backend/app/main.py`  
5. Região relevante de `pedidos_service.py` (se mexer no lock de finalização, ler §4.7 inteiro antes)  
6. `frontend/src/pages/PedidosPage.tsx` + `lib/filtrosPedidos.ts`  
7. Se desktop/boot: `run_app.py`, `desktop_window.py`  
8. Se release: `build.bat`, `scripts/gerar_pacote_completo.py`, `upload_latest_json.py`  
9. Se auth/telas: `auth.py`, `acesso_telas.py`, `ProtectedRoute` / `RequireTela`  
10. Se Supabase (tabela/RPC): `docs/schema_supabase.json` (gerado; ver §11) antes de assumir colunas de memória

---

## 10. Chat (removido)

O chat (DM entre operadores) foi **removido do código**, não só desligado. Antes disso, já vinha desativado há um tempo: router não montado em `main.py`, UI já removida do frontend.

**O que saiu:** `backend/app/chat_service.py`, `backend/app/routers/chat_router.py`, a entrada `"chat_local"` de `PRESERVE_DIRS` em `atualizador_runtime.py`, e as referências a `app.routers.chat_router` / `app.chat_service` em `ConferenciaPedidos.spec` (hiddenimports do PyInstaller).

**O que ficou:** a função `listar_usuarios` (usada por `acesso_telas_router` e `etiqueta_prefetch_router`, sem relação nenhuma com chat) foi extraída para `backend/app/usuarios_service.py` antes da remoção, para não quebrar essas duas telas.

**O que só existe fora do repo:** a tabela `chat_mensagens` e o bucket de Storage `chat-temp` continuam no projeto Supabase — remover código não apaga dado/schema no banco. Se quiser apagar de lá também, isso é uma ação destrutiva direto no Supabase (dashboard ou SQL), fora do escopo de qualquer script deste repo; feita à parte e sob confirmação explícita.

**Regra para IA:** não recriar chat sem pedido explícito do Rafael. Se pedirem, é um recurso novo — não uma "reativação".

---

## 11. Documentação gerada (`docs/`) — contrato exato, não resumo

Duas fontes de verdade **geradas a partir do sistema real** (não escritas à mão, não podem ficar desatualizadas sem querer):

| Arquivo | Gerado por | O que tem | Custo p/ regenerar |
|---------|-----------|-----------|---------------------|
| `docs/openapi.json` | `scripts/gerar_openapi.py` (ou `.bat`) | Schema OpenAPI real do FastAPI: todo path, método, request body e response model, exportado direto de `app.openapi()` — sem subir servidor, sem rede. | Segundos; só precisa do venv do backend. |
| `docs/schema_supabase.json` | `scripts/gerar_schema_supabase.py` (ou `.bat`) | Schema OpenAPI que o próprio PostgREST do Supabase expõe em `/rest/v1/`: tabelas, colunas, tipos e RPCs realmente visíveis com a `SUPABASE_KEY` do `config.ini`. Chamada HTTP GET, somente leitura. | Segundos; precisa de rede até o projeto Supabase (por isso roda no PC do dev/operação, não em sandbox sem acesso externo). |

**Por que existem:** a tabela de rotas em §4.5 e a lista de tabelas em §4.3 são resumos de uma linha — úteis para achar o arquivo certo, mas não têm o request/response exato nem o tipo exato de cada coluna. Uma IA que confiar só nesses resumos para escrever código arrisca acertar o "onde" e errar o "como" (nome de campo, tipo, obrigatoriedade).

**Regra:** os dois arquivos **não são escritos à mão**. Se divergirem do código/banco, o problema é não ter rodado o script de novo — nunca editar `docs/*.json` direto. Rodar antes de qualquer mudança de rota ou schema, e de novo depois, para confirmar o diff esperado.
