@echo off
cd /d "%~dp0"
echo Demarrage de Repost Studio... (laissez cette fenetre ouverte)
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:4300"
node server.js
pause
