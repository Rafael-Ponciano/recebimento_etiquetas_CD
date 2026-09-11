@echo off
setlocal
cd /d "%~dp0\.."

if exist "backend\.venv\Scripts\activate.bat" (
    call "backend\.venv\Scripts\activate.bat"
) else (
    echo [gerar_schema_supabase] Aviso: backend\.venv nao encontrado. Rodando com o Python do PATH.
)

python scripts\gerar_schema_supabase.py
endlocal
