@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo  Build ConferenciaPedidos (PC sem Python)
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado. Instale em https://nodejs.org
  goto :erro
)
if not exist "backend\.venv\Scripts\python.exe" (
  echo ERRO: backend\.venv nao encontrado.
  echo Crie com:
  echo   cd backend
  echo   python -m venv .venv
  echo   .venv\Scripts\activate
  echo   pip install -r requirements.txt
  goto :erro
)

set "APP_VERSION=1.0.0"
if exist "VERSION" (
  set /p APP_VERSION=<VERSION
)
echo Versao: %APP_VERSION%
echo.

echo [1/5] Build do frontend...
cd frontend
if not exist "node_modules\" (
  echo Instalando npm dependencies...
  call npm install
  if errorlevel 1 goto :erro
)
set "VITE_APP_VERSION=%APP_VERSION%"
call npm run build
if errorlevel 1 goto :erro
cd ..

echo.
echo [2/5] Copiando front para backend\static...
if exist "backend\static\" rmdir /s /q "backend\static"
mkdir "backend\static"
xcopy /e /i /y "frontend\dist\*" "backend\static\" >nul
if errorlevel 1 goto :erro
copy /y "VERSION" "backend\static\VERSION.txt" >nul

echo.
echo [3/5] Conferindo dependencias Python...
cd backend
call .venv\Scripts\python.exe -m pip install -q -r requirements.txt
if errorlevel 1 goto :erro
call .venv\Scripts\python.exe -c "import webview, fastapi, uvicorn, supabase, pandas, gspread, jwt, bcrypt; print('ok')"
if errorlevel 1 (
  echo ERRO: alguma lib falhou no import. Rode: pip install -r requirements.txt
  goto :erro
)

echo.
echo [4/5] Empacotando com PyInstaller ^(todas as libs^)...
call .venv\Scripts\python.exe -m PyInstaller --noconfirm --clean ConferenciaPedidos.spec
if errorlevel 1 goto :erro
cd ..

echo.
echo [5/5] Montando pasta release\...
if exist "release\" rmdir /s /q "release"
mkdir "release"

xcopy /e /i /y "backend\dist\ConferenciaPedidos\*" "release\" >nul
if errorlevel 1 goto :erro

mkdir "release\static" 2>nul
xcopy /e /i /y "backend\static\*" "release\static\" >nul
copy /y "VERSION" "release\VERSION" >nul
mkdir "release\config" 2>nul
mkdir "release\dados" 2>nul
mkdir "release\tools" 2>nul
copy /y "config.example.ini" "release\config\config.example.ini" >nul
if exist "atualizador.ps1" copy /y "atualizador.ps1" "release\tools\atualizador.ps1" >nul
if exist "frontend\public\delivery.ico" copy /y "frontend\public\delivery.ico" "release\static\delivery.ico" >nul
if exist "frontend\public\delivery.png" copy /y "frontend\public\delivery.png" "release\static\delivery.png" >nul
if exist "recebimento-sa-key.json" (
  copy /y "recebimento-sa-key.json" "release\dados\recebimento-sa-key.json" >nul
  echo Chave BigQuery inclusa: dados\recebimento-sa-key.json
) else (
  echo AVISO: recebimento-sa-key.json nao encontrado na raiz — BQ nao vai funcionar no pacote.
)

echo.
echo Desbloqueando DLLs do pythonnet ^(Mark of the Web^)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path 'release' -Recurse -Include *.dll,*.exe,*.ps1 -ErrorAction SilentlyContinue | Unblock-File" >nul 2>&1
if exist "desbloquear_release.bat" copy /y "desbloquear_release.bat" "release\desbloquear_release.bat" >nul

if exist "config.ini" (
  echo.
  echo AVISO: config.ini de DEV nao foi copiado ^(segredos^).
  echo         Em cada PC, copie config.example.ini -^> config.ini e preencha.
)

echo.
echo ========================================
echo  OK
echo  Pasta: release\
echo  Exe:   release\ConferenciaPedidos.exe
echo  Versao: %APP_VERSION%
echo.
echo  O QUE COPIAR PARA O PC SEM PYTHON:
echo    pasta release\ inteira
echo.
echo  EM CADA PC ^(ao lado do .exe^):
echo    1. config\config.ini   ^(de config\config.example.ini^)
echo         - ANYMARKET_EMAIL / ANYMARKET_SENHA
echo         - SUPABASE_URL / SUPABASE_KEY
echo         - PRINTER_NAME / GHOSTSCRIPT_PATH
echo         - SHEET_ID_B2C
echo    2. dados\credenciais.json  ^(Google Sheets^)
echo    3. Ghostscript instalado + caminho no config.ini
echo    4. Driver da ELGIN L42PRO FULL instalado
echo    5. PRINTER_NAME = nome EXATO da impressora no Windows
echo.
echo  NAO precisa de Python / Node no PC final.
echo  Precisa de internet ^(Supabase / AnyMarket / Sheets^).
echo.
echo  Se der erro Python.Runtime.dll / pythonnet:
echo    rode release\desbloquear_release.bat e abra o exe de novo.
echo ========================================
goto :fim

:erro
echo.
echo BUILD FALHOU.
cd /d "%~dp0"
exit /b 1

:fim
endlocal
exit /b 0
