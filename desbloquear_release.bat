@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo Desbloqueando DLLs/EXEs nesta pasta (corrige erro do pythonnet/webview)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -Include *.dll,*.exe -ErrorAction SilentlyContinue | Unblock-File"
if errorlevel 1 (
  echo Falhou. Tente clicar com o botao direito em ConferenciaPedidos.exe -^> Propriedades -^> Desbloquear.
  pause
  exit /b 1
)
echo OK. Agora rode ConferenciaPedidos.exe novamente.
pause
