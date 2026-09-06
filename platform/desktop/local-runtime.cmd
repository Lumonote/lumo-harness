@echo off
setlocal

for %%I in ("%~dp0..") do set "platform_root=%%~fI\"
for %%I in ("%platform_root%..") do set "repo_root=%%~fI\"
set "deepseek_source_root=%repo_root%deepseek-harness"
set "deepseek_root=%platform_root%.build\deepseek-harness"

node "%platform_root%dsh-overrides\prepare-runtime.mjs" "%deepseek_source_root%" "%deepseek_root%"
if errorlevel 1 exit /b %ERRORLEVEL%

set "web_index=%deepseek_root%\apps\web\dist\index.html"
if not exist "%web_index%" (
  if "%LUMO_AUTO_BUILD_WEB%"=="0" (
    echo Lumo: missing DSH Web frontend: %web_index% 1>&2
    exit /b 1
  )
  pushd "%deepseek_root%"
  if errorlevel 1 exit /b 1
  call corepack pnpm --filter @deepseek-ai/dsh-client-ui-conversation run bundle
  if errorlevel 1 exit /b 1
  call corepack pnpm --filter @deepseek-ai/dsh-web-frontend run build
  if errorlevel 1 exit /b 1
  popd
)
node "%platform_root%dsh-overrides\brand-web.mjs" "%deepseek_root%"
if errorlevel 1 exit /b %ERRORLEVEL%
node "%platform_root%dsh-overrides\assert-pristine.mjs" "%deepseek_source_root%"
if errorlevel 1 exit /b %ERRORLEVEL%

set "LUMO_DEPLOYMENT_MODE=local"
set "LUMO_DSH_PROFILE=web"
set "LUMO_DSH_ROOT=%deepseek_root%"
if "%LUMO_WEB_PORT%"=="" set "LUMO_WEB_PORT=3080"
if "%LUMO_BUNDLED_SKILLS_ROOT%"=="" set "LUMO_BUNDLED_SKILLS_ROOT=%platform_root%upstream\skills"
if "%LUMO_RUFLO_BIN%"=="" set "LUMO_RUFLO_BIN=%platform_root%dsh-plugins\ruflo-orchestration\node_modules\ruflo\bin\ruflo.js"
set "ppt_python=%platform_root%upstream\skills\ppt-master\.venv-win-x64\Scripts\python.exe"
if exist "%ppt_python%" if "%LUMO_PPT_PYTHON%"=="" set "LUMO_PPT_PYTHON=%ppt_python%"
if "%LUMO_AUTO_INSTALL_PLUGINS%"=="" set "LUMO_AUTO_INSTALL_PLUGINS=1"
if "%DSH_HOME%"=="" set "DSH_HOME=%LOCALAPPDATA%\Lumo\dsh"

cd /d "%platform_root%data-plane\dsh-node"
node --import tsx src\index.ts
exit /b %ERRORLEVEL%
