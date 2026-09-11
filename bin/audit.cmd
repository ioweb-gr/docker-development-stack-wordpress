@echo off
node "%~dp0..\src\cli.js" audit --project-root "%CD%" %*
exit /b %ERRORLEVEL%
