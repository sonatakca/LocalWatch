@REM @echo off
@REM cd /d "%~dp0"
@REM start cmd /k "npm run dev"
@REM timeout /t 1 >nul
@REM start "" "http://localhost:3000"

REM @echo off
REM cd /d "%~dp0"
REM start "" cmd /k "npm run dev"
REM timeout /t 1 >nul
REM start "" "%~dp0LocalWatch.lnk"

@echo off
cd /d "%~dp0"
start "" cmd /k "npm run dev"
