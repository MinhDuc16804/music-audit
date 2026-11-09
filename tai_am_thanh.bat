@echo off
chcp 65001 >nul
REM ============================================================
REM  TAI AM THANH VIDEO DE QUET NHAC (chi tai tieng, khong tai hinh)
REM  1. Chay truoc:  python audit.py audio-links
REM     (ghi data\audio\links.txt: video chua quet va chua tai)
REM  2. Chay file nay. Ket qua: data\audio\<video_id>.m4a
REM  3. Chay:  python audit.py submit
REM     (video co file se duoc gui file thay cho link)
REM  Khong can ffmpeg. data\ nam ngoai git, khong gui file ra ngoai.
REM ============================================================

cd /d "%~dp0"

where yt-dlp >nul 2>nul
if errorlevel 1 (
    echo [LOI] Chua cai yt-dlp. Mo PowerShell va chay: winget install yt-dlp.yt-dlp
    pause
    exit /b 1
)

if not exist data\audio\links.txt (
    echo [LOI] Chua co data\audio\links.txt. Chay truoc: python audit.py audio-links
    pause
    exit /b 1
)

REM m4a ban tot nhat (thuong 128 kbps). Khong dung ban 48 kbps (139): chat luong thap de nhan sai bai.
REM Nghi 3-8 giay giua cac video de khong tai don dap.
REM Khong dung --cookies-from-browser: video cong khai khong can, va de tai khoan kenh ra khoi viec tai tu dong.
REM Neu bi bao "not a bot": dung lai, de vai gio sau chay tiep (file da tai se duoc bo qua).
yt-dlp -a data\audio\links.txt --no-playlist ^
    --download-archive data\audio\da_tai.txt --no-overwrites --ignore-errors ^
    --sleep-interval 3 --max-sleep-interval 8 ^
    -f "bestaudio[ext=m4a]" -o "data\audio\%%(id)s.%%(ext)s"

echo.
echo ===== XONG =====
echo Video da tai ghi trong data\audio\da_tai.txt. Chay lai file nay se bo qua video da xong.
echo Buoc tiep: python audit.py submit --limit 1   (thu 1 video truoc)
pause
