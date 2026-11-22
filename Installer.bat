@echo off
setlocal
cd /d "%~dp0"
echo ==============================================
echo   Installation de TikTok Repost Studio
echo ==============================================
echo.
where winget >nul 2>nul || (
  echo winget est introuvable : installez "App Installer" depuis le Microsoft Store, puis relancez ce fichier.
  pause
  exit /b 1
)
where node >nul 2>nul && (echo Node.js : deja installe) || (
  echo Installation de Node.js...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
)
where ffmpeg >nul 2>nul && (echo FFmpeg : deja installe) || (
  echo Installation de FFmpeg...
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
)
where yt-dlp >nul 2>nul && (echo yt-dlp : deja installe) || (
  echo Installation de yt-dlp...
  winget install -e --id yt-dlp.yt-dlp --accept-source-agreements --accept-package-agreements
)
if not exist ".env" copy ".env.example" ".env" >nul
echo.
echo Installation terminee.
echo 1. Redemarrez l'ordinateur si un outil vient d'etre installe.
echo 2. Double-cliquez sur "Lancer Repost Studio.bat".
echo 3. Dans l'app, ouvrez "Parametres et integrations API" et collez VOS propres cles.
echo.
pause
