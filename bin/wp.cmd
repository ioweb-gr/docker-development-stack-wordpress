@echo off
setlocal
set "PROJECT_ROOT=%~dp0..\..\.."
node "%~dp0..\src\cli.js" --project-root "%PROJECT_ROOT%" wp %*
exit /b %ERRORLEVEL%
