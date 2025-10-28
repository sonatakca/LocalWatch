@REM @echo off
@REM cd /d "%~dp0"
@REM start cmd /k "npm run dev"
@REM timeout /t 1 >nul
@REM start "" "http://localhost:3000"

@echo off
cd /d "%~dp0"
start "" cmd /k "npm run dev"
timeout /t 1 >nul
start "" "%~dp0LocalWatch.lnk"