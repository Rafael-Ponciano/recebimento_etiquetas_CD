# Instalação nos PCs (sem Python)

## No PC de BUILD (o seu, com Python + Node)

1. Backend com venv e deps:
   ```bat
   cd backend
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```
2. Na raiz do projeto:
   ```bat
   build.bat
   ```
3. Sai a pasta `release\` com o `.exe` + `_internal\` (todas as libs Python) + `static\`.

## No PC de OPERAÇÃO (sem Python)

Copie a pasta **`release\` inteira** (não só o .exe).

Ao lado de `ConferenciaPedidos.exe`:

| Arquivo | Obrigatório | Nota |
|---------|-------------|------|
| `_internal\` | sim | libs (vem no build) |
| `static\` | sim | interface |
| `VERSION` | sim | versão na tela |
| `config.ini` | sim | copie de `config.example.ini` e preencha |
| `credenciais.json` | sim | Google Sheets (Service Account) |
| `delivery.ico` | recomendado | ícone |
| `token_any.json` | não | gerado sozinho no 1º login AnyMarket |

### config.ini (ajuste por PC)

Use `config.example.ini` como modelo completo. O essencial por PC:

```ini
PRINTER_NAME = ELGIN L42PRO FULL
GHOSTSCRIPT_PATH = C:\Program Files\gs\gs10.06.0\bin\gswin64c.exe

ANYMARKET_EMAIL = usuario@empresa.com.br
ANYMARKET_SENHA = senha_da_conta
ORG_ID = 259061876.

GOOGLE_CREDENTIALS_FILE = credenciais.json
SHEET_ID_B2C = id_da_planilha
SHEET_ABA_B2C = Check B2C
```

Também no ini (sem rebuild): `JWT_EXPIRE_HOURS`, `APP_PORT`, timeouts, TTLs de cache — ver `config.example.ini`.

Regras de texto (status / planilha):

```ini
STATUS_COLETA_HOJE = Conferido
STATUS_AGENDADO = Recebido
STATUS_PARCIAL = Recebido Parcial
SHEETS_STATUS_FEITO = FEITO
SHEETS_STATUS_PARCIAL = FALTANDO ITEM
IMPRIMIR_EM_PARCIAL = false
```

- **AnyMarket**: e-mail e senha do portal. O app gera `token_any.json` na primeira vez.  
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` **não são usados** — só o `credenciais.json` (Service Account).  
- Nome da impressora = **exatamente** como em Configurações → Impressoras  
- Instale o **Ghostscript** e o **driver da Elgin** em cada PC  
- WebView2 (Edge) já vem no Windows 10/11 modernos  
- Depois de editar o `config.ini`, **reinicie** o app.
  

### O que NÃO vai no pacote (e não precisa)

- Python  
- Node.js  
- Código-fonte  

### Rede

O app precisa de internet para Supabase, AnyMarket e Google Sheets.
