@echo off
rem ===== Add X-Ray tool: drag new X-rays, the name is read and the file is filed in the archive =====
cd /d "%~dp0"
set "PY="
where py >/dev/null 2>/dev/null && set "PY=py -3"
if not defined PY (where python >/dev/null 2>/dev/null && set "PY=python")
if not defined PY (
  echo.
  echo  Python is not installed on this computer.
  echo  Install it from https://www.python.org/downloads/  then run this file again.
  echo.
  pause
  exit /b 1
)
%PY% -c "import PIL" >/dev/null 2>/dev/null || (
  echo Installing Pillow ^(one time only, for better name reading^)...
  %PY% -m pip install --quiet --disable-pip-version-check pillow
)
title Add X-Ray
%PY% "%~dp0add_xray.py"
if errorlevel 1 pause
