@echo off
node "%~dp0..\src\cli.js" benchmark --project-root "%CD%" %*
exit /b %ERRORLEVEL%
