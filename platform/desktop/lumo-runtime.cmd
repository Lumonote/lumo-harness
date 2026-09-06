@echo off
setlocal

set "runtime_root=%~dp0"
if "%LUMO_RUNTIME_STATE_DIR%"=="" set "LUMO_RUNTIME_STATE_DIR=%LOCALAPPDATA%\Lumo\dsh\runtime"
if not exist "%LUMO_RUNTIME_STATE_DIR%" mkdir "%LUMO_RUNTIME_STATE_DIR%"

set "LUMO_PACKAGED_RUNTIME=1"
set "LUMO_RUNTIME_ROOT=%runtime_root%"
set "LUMO_RUNTIME_NODE_MODULES=%runtime_root%node_modules"
set "LUMO_BUNDLED_SKILLS_ROOT=%runtime_root%skills"
if "%LUMO_SKILLHUB_COMMAND%"=="" set "LUMO_SKILLHUB_COMMAND=%runtime_root%bin\skillhub.mjs"
set "LUMO_RUFLO_BIN=%runtime_root%node_modules\ruflo\bin\ruflo.js"
if exist "%runtime_root%python\python.exe" (
  if "%LUMO_PPT_PYTHON%"=="" set "LUMO_PPT_PYTHON=%runtime_root%python\python.exe"
  if "%PYTHONHOME%"=="" set "PYTHONHOME=%runtime_root%python"
  set "PYTHONNOUSERSITE=1"
  set "PYTHONDONTWRITEBYTECODE=1"
)
set "LUMO_DSH_ROOT=%runtime_root%"
set "LUMO_DSH_CLI=%runtime_root%node_modules\@deepseek-ai\dsh\lib\bin.js"
if "%LUMO_PATCH_PATH%"=="" set "LUMO_PATCH_PATH=%LUMO_RUNTIME_STATE_DIR%\lumo.patch.yml"
set "LUMO_AUTO_INSTALL_PLUGINS=0"
if "%DSH_HOME%"=="" set "DSH_HOME=%LOCALAPPDATA%\Lumo\dsh"
if "%LUMO_DEPLOYMENT_MODE%"=="" set "LUMO_DEPLOYMENT_MODE=local"
if "%LUMO_DSH_PROFILE%"=="" set "LUMO_DSH_PROFILE=web"
if "%LUMO_WEB_PORT%"=="" set "LUMO_WEB_PORT=3080"
if "%NODE_COMPILE_CACHE%"=="" set "NODE_COMPILE_CACHE=%LUMO_RUNTIME_STATE_DIR%\compile-cache"
if not exist "%NODE_COMPILE_CACHE%" mkdir "%NODE_COMPILE_CACHE%"

set "PATH=%runtime_root%;%runtime_root%bin;%USERPROFILE%\.local\bin;%PATH%"
if "%COREPACK_HOME%"=="" set "COREPACK_HOME=%LUMO_RUNTIME_STATE_DIR%\corepack"
set "COREPACK_ENABLE_PROJECT_SPEC=0"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
if not exist "%COREPACK_HOME%" mkdir "%COREPACK_HOME%"

"%runtime_root%node.exe" --experimental-strip-types "%runtime_root%dsh-node\src\index.ts"
exit /b %ERRORLEVEL%
