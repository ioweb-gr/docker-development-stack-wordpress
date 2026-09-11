@echo off
setlocal
set "PROJECT_ROOT=%~dp0..\..\.."
node "%~dp0..\src\cli.js" import --project-root "%PROJECT_ROOT%" %*
exit /b %ERRORLEVEL%
