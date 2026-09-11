# Gera ZIP completo + latest.json (sem cortar arquivos).
# Fluxo recomendado: ZIP no Google Drive, latest.json no Supabase.
#
# Uso (após build.bat):
#   powershell -ExecutionPolicy Bypass -File scripts\publicar_release.ps1
#   (depois suba o ZIP no Drive e rode gerar_pacote_completo.py --drive-url ...)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$py = Join-Path $Root "backend\.venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $py)) {
    throw "Python venv não encontrado em backend\.venv"
}

& $py (Join-Path $Root "scripts\gerar_pacote_completo.py") @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
