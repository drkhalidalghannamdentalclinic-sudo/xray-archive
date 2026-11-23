@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Add X-Ray (keep this window open)
rem ---- find Python the same way rebuild.bat does ----
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (where py >nul 2>nul && set "PY=py")
if not defined PY (
  for /d %%D in ("%LocalAppData%\Programs\Python\Python3*") do if exist "%%D\python.exe" set "PY="%%D\python.exe""
)
if not defined PY (
  for /d %%D in ("%ProgramFiles%\Python3*") do if exist "%%D\python.exe" set "PY="%%D\python.exe""
)
if not defined PY (
  echo.
  echo [ERROR] Python was not found on this computer.
  echo.
  pause
  exit /b 1
)
echo Python: %PY%
%PY% -c "import PIL" >nul 2>nul || (
  echo Installing Pillow - one time only...
  %PY% -m pip install --quiet --disable-pip-version-check pillow
)
%PY% "%~dp0files\add_xray.py"
echo.
echo The tool has stopped. If you see an error above, send a photo of this window.
pause
