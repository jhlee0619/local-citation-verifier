@echo off
rem Run local-citation-verifier from this folder; optional vLLM reranking through an SSH tunnel (see scriptsun_local.py).
rem See scripts\run_local.py for details.
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  python -u scripts\run_local.py %*
) else (
  py -3 -u scripts\run_local.py %*
)
if errorlevel 1 pause
