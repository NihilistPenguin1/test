@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Pusula Haber baslatiliyor... http://localhost:3000
echo (Durdurmak icin: Ctrl + C)
call npm start
pause
