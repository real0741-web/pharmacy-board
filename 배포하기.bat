@echo off
cd /d "%~dp0"

echo [1] 잠금 파일 정리 중...
del /f /q .git\HEAD.lock 2>nul
del /f /q .git\index.lock 2>nul
del /f /q .git\config.lock 2>nul

echo [2] git 설정...
git config user.email "aispeed0324@gmail.com"
git config user.name "real0741-web"

echo [3] 파일 스테이징...
git add -A

echo [4] 커밋...
git commit -m "update: %date% %time%" 2>nul || echo (변경사항 없음 - 그냥 push 진행)

echo [5] remote 설정...
git remote remove origin 2>nul
git remote add origin https://github.com/real0741-web/pharmacy-board.git

echo [6] GitHub 배포 중...
git push --force --set-upstream origin main

echo.
echo 완료! GitHub Pages 반영까지 1-2분 소요됩니다.
pause
