@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo    PUSULA HABER - GUNCELLEME
echo ============================================
echo.
echo [1/2] Depo guncelleniyor (git pull)...
git pull
if errorlevel 1 (
    echo.
    echo HATA: git pull basarisiz oldu! Baglantiyi ve GitHub yetkisini kontrol edin.
    pause
    exit /b 1
)
echo.
echo [2/2] Bagimliliklar kuruluyor (npm install)...
call npm install
if errorlevel 1 (
    echo.
    echo HATA: npm install basarisiz oldu!
    pause
    exit /b 1
)
echo.
echo ============================================
echo    Guncelleme TAMAM!
echo    Sunucuyu baslatmak icin: calistir.bat
echo    Tarayicida acin: http://localhost:3000
echo ============================================
pause
