# Conferência CD

Aplicação desktop para conferência de pedidos B2C no centro de distribuição: listagem, conferência por peça, impressão de etiquetas, integração com AnyMarket e Google Sheets, histórico, logs e indicadores de produtividade.

**Stack:** FastAPI (Python) + React (Vite/TypeScript) + Supabase + BigQuery + pywebview (janela nativa no Windows).

---

## Funcionalidades

| Área | Descrição | Acesso |
|------|-----------|--------|
| Pedidos | Conferência, filtros, colunas personalizáveis, impressão | Operador / Admin |
| Histórico | Pedidos já conferidos | Operador / Admin |
| Dashboard | Produtividade e tempo médio por operador | Admin |
| Performance | Métricas detalhadas de conferência | Admin |
| Logs | Auditoria de ações no sistema | Admin |
| Baixa manual | Ajustes manuais de status | Admin |
| Presença em tempo real | Alerta quando outro operador está no mesmo pedido | Operador / Admin |
| Recuperação de senha | Código por e-mail (SMTP) | Todos |

Na barra superior, cada usuário vê **peças conferidas hoje** e **tempo médio por pedido**.

---

## Estrutura do projeto

```
recebimento_etiquetas_CD/
├── VERSION                          # Versão exibida no app / update
├── AGENTS.md                        # Manual técnico completo (referência canônica)
├── README.md / INSTALAR.md
├── config.ini                       # Configuração local (não versionar com segredos)
├── config.example.ini               # Modelo sem segredos
├── desktop_window.py                # Janela desktop / splash
├── build.bat                        # Front → static → PyInstaller → release\
├── iniciar_dev.bat / iniciar_dev.py # Desenvolvimento local (API + Vite + janela)
├── atualizador.ps1                  # Fallback PowerShell do auto-update
├── recebimento-sa-key.json          # Service Account do BigQuery (não versionar)
├── token_any.json                   # Cache do token AnyMarket (gerado em runtime)
├── scripts/                         # Empacotar/publicar releases + gerar docs/*.json
├── docs/                            # openapi.json e schema_supabase.json (gerados, ver abaixo)
├── backend/                         # API FastAPI
│   ├── app/                         # Código da aplicação
│   ├── static/                      # Frontend buildado (gerado)
│   ├── run_app.py                   # Entrada do executável
│   └── ConferenciaPedidos.spec
├── frontend/                        # Interface React
├── release/                         # Saída do build (PC sem Python)
├── releases/                        # ZIPs + latest.json para publicar
├── downloads/                       # PDFs de etiqueta/DANFE
├── _webview_data/                   # Cache do WebView2
└── _update/                         # Staging/backup/logs do auto-update (runtime)
```

> Não há mais pasta `backend/sql/` versionada no repositório — o schema efetivo do Supabase é mantido diretamente no projeto (tabelas + RPCs), sem scripts SQL no repo.

---

## Desenvolvimento local

### Pré-requisitos

- Python 3.11+
- Node.js 20+
- Ghostscript (para impressão)
- Impressora térmica configurada no Windows

### Backend

```bat
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

### Frontend

```bat
cd frontend
npm install
```

### Configuração

1. Copie `config.example.ini` → `config.ini` na raiz do projeto.
2. Preencha Supabase, BigQuery, AnyMarket, Google Sheets, impressora e SMTP (se usar recuperação de senha).
3. Coloque `credenciais.json` (Service Account do Google Sheets) e `recebimento-sa-key.json` (Service Account do BigQuery) na raiz.

### Subir o app

```bat
iniciar_dev.bat
```

Isso inicia a API em `http://127.0.0.1:8080`, o Vite em `http://127.0.0.1:5173` e abre a janela desktop.

Variável opcional: `DEV_RELOAD=1` habilita reload automático do backend.

---

## Build do executável (PC de build)

Na raiz, com venv do backend pronto:

```bat
build.bat
```

Saída em `release\`:

- `ConferenciaPedidos.exe`
- `_internal\` (dependências Python)
- `static\` (interface)
- `config.example.ini`
- `VERSION`

O `config.ini` **não** é copiado automaticamente (segurança). Em cada PC de operação, copie `config.example.ini` → `config.ini` e preencha.

Detalhes de instalação nos PCs finais: [INSTALAR.md](INSTALAR.md).

---

## Configuração (`config.ini`)

Arquivo na **raiz** do projeto (dev) ou **ao lado do `.exe`** (produção).

### Supabase

```ini
SUPABASE_URL = https://seu-projeto.supabase.co
SUPABASE_KEY = sua_service_role_aqui
SUPABASE_TABELA_PEDIDOS = pedidos_recebimento   # legado; a lista de pedidos vem do BigQuery
```

Use a chave **service_role** (Dashboard → Settings → API). Não use a chave `publishable`/`anon` no app.

### BigQuery (fonte da lista de pedidos)

```ini
BQ_PROJECT = seu-projeto-gcp
BQ_TABELA_PEDIDOS = projeto.dataset.tabela
BQ_CREDENTIALS_FILE = recebimento-sa-key.json
```

A listagem de pedidos (`GET /api/pedidos`) é lida do BigQuery. O Supabase guarda apenas os overrides de status manual (`pedidos_status_manual`) e os saldos de conferência (`conferencia_itens` / `conferencia_recebimentos`).

### Autenticação

```ini
JWT_SECRET =          # gerado automaticamente se vazio
JWT_EXPIRE_HOURS = 12
```

### App / impressão

```ini
APP_HOST = 127.0.0.1
APP_PORT = 8080
PRINTER_NAME = ELGIN L42PRO FULL
GHOSTSCRIPT_PATH = C:\Program Files\gs\gs10.06.0\bin\gswin64c.exe
PRINT_TIMEOUT_SECONDS = 20
DOWNLOADS_RETENCAO_DIAS = 3
```

PDFs antigos em `downloads\` são removidos automaticamente na inicialização.

### AnyMarket

```ini
ORG_ID = ...
ANYMARKET_EMAIL = ...
ANYMARKET_SENHA = ...
ANYMARKET_TIMEOUT_SECONDS = 15
```

O arquivo `token_any.json` é criado automaticamente no primeiro login.

### Google Sheets

```ini
GOOGLE_CREDENTIALS_FILE = credenciais.json
SHEET_ID_B2C = ...
SHEET_ABA_B2C = Check B2C
SHEET_COL_STATUS = 8
SHEET_COL_OBS_QTD = 12
SHEETS_CACHE_TTL_SECONDS = 45
```

### Cache e regras de negócio

```ini
CACHE_PEDIDOS_TTL_SECONDS = 60
CACHE_ITENS_TTL_SECONDS = 180
LOCK_FINALIZACAO_TTL_SECONDS = 240
STATUS_COLETA_HOJE = Conferido
STATUS_AGENDADO = Recebido
STATUS_PARCIAL = Recebido Parcial
SHEETS_STATUS_FEITO = FEITO
SHEETS_STATUS_PARCIAL = FALTANDO ITEM
IMPRIMIR_EM_PARCIAL = false
```

### SMTP (recuperação de senha)

```ini
SMTP_HOST = smtp.gmail.com
SMTP_PORT = 587
SMTP_USER = seu-email@empresa.com.br
SMTP_PASSWORD = senha_de_app
SMTP_FROM = seu-email@empresa.com.br
SMTP_USE_TLS = true
```

`SMTP_USER` e `SMTP_PASSWORD` também podem vir de variáveis de ambiente. Sem SMTP configurado, o login funciona, mas "Esqueci a senha" retorna erro 503.

### Auto-update

```ini
UPDATE_ENABLED = true
UPDATE_BUCKET = app-releases
UPDATE_LATEST_PATH = latest.json
UPDATE_LATEST_URL =
UPDATE_CHECK_TTL_SECONDS = 300
```

O app confere periodicamente o `latest.json` no bucket Supabase acima; se a versão remota for **estritamente maior** que a local, baixa o ZIP (Google Drive), valida o `sha256` e aplica com backup automático da versão anterior. Detalhes do fluxo e do rollback em [AGENTS.md](AGENTS.md#6-update-e-release).

---

## Supabase — tabelas e RPCs

Não há mais scripts `.sql` versionados no repositório: o schema efetivo do Supabase é mantido diretamente no projeto e usado via cliente Python + RPCs. As principais tabelas são `usuarios`, `pedidos_status_manual`, `conferencia_itens`, `conferencia_recebimentos`, `conferencia_finalizacoes`, `conferencia_presenca`, `conferencia_performance`, `preferencias_usuario` e `logs`; as RPCs usadas incluem `registrar_recebimento_item`, `tentar_iniciar_finalizacao_pedido`, `concluir_finalizacao_pedido`, `liberar_lock_finalizacao_pedido`, `registrar_resultado_sync_sheets`, `resetar_saldo_conferencia`, `registrar_conferencia_performance`, `listar_conferencia_performance` e `limpar_retencao`. Lista completa com campos em [AGENTS.md](AGENTS.md#43-tabelas-supabase-uso-no-código).

Use sempre a chave **service_role** no `config.ini` — nunca `anon`/`publishable`.

---

## Origem dos pedidos (BigQuery) e status manual (Supabase)

A listagem de pedidos vem do **BigQuery** (`BQ_TABELA_PEDIDOS`), não mais de um ETL para a tabela `pedidos_recebimento` no Supabase — essa tabela e a chave `SUPABASE_TABELA_PEDIDOS` são mantidas apenas por compatibilidade legada. Overrides manuais de status ficam na tabela Supabase `pedidos_status_manual`, e os saldos de conferência em `conferencia_itens` / `conferencia_recebimentos`.

---

## Rede e portas

- Cada PC roda o app localmente (`127.0.0.1:8080`). Não há conflito de porta entre computadores na mesma rede.
- É necessária **internet** para Supabase, AnyMarket e Google Sheets.
- O SMTP (Gmail) exige senha de app se usar autenticação em duas etapas.

---

## Solução de problemas

| Problema | O que verificar |
|----------|-----------------|
| `ERR_CONNECTION_REFUSED` no executável | `config.ini` ao lado do `.exe`, com `SUPABASE_KEY` válida |
| Erro `pythonnet` / `Python.Runtime.dll` | Rode `release\desbloquear_release.bat` |
| Recuperação de senha não funciona | SMTP no `config.ini` + colunas `reset_codigo_hash`/`reset_expira_em` em `usuarios` no Supabase |
| Usuário sem e-mail | Cadastre e-mail no perfil ou via banco |
| Impressão falha | Nome exato da impressora, Ghostscript instalado, driver Elgin |
| Pedidos desatualizados | Cache de 60s (`CACHE_PEDIDOS_TTL_SECONDS`) — normal em conferência ativa |

---

## Documentação gerada (`docs/`)

Dois arquivos versionados, gerados automaticamente (não escritos à mão — ver [AGENTS.md](AGENTS.md#11-documentação-gerada-docs--contrato-exato-não-resumo)):

| Arquivo | Como gerar | Conteúdo |
|---------|-----------|----------|
| `docs/openapi.json` | `scripts\gerar_openapi.bat` | Schema OpenAPI exato de toda rota `/api/*` (request/response), direto do FastAPI |
| `docs/schema_supabase.json` | `scripts\gerar_schema_supabase.bat` | Schema real das tabelas/RPCs do Supabase, via endpoint OpenAPI do PostgREST (`SUPABASE_KEY` do `config.ini`) |

Rode os dois de novo sempre que mudar uma rota ou o schema do Supabase — mantém a documentação confiável para humanos e IAs sem precisar reler o projeto inteiro.

---

## Documentação relacionada

- [AGENTS.md](AGENTS.md) — manual técnico completo (arquitetura, API, tabelas, regras de status, release)
- [INSTALAR.md](INSTALAR.md) — deploy rápido nos PCs de operação
- `config.example.ini` — modelo de configuração sem segredos
