@echo off
rem `az` shim for cmd.exe callers on Windows (see README.md, "Windows"). SDK credential chains
rem (AzureCliCredential runs `cmd /c az account get-access-token ...`) and Go tools such as
rem Terraform (PATHEXT lookup) never see the bash shim `az`, so without this file they reach the
rem machine's real az. It hands its arguments to az-shim.cjs on the command line: these callers
rem pass plain arguments; bash callers use `az`, which keeps every byte.
setlocal
set "AZ_SHIM_NODE_EXE=node"
if defined AZ_SHIM_NODE set "AZ_SHIM_NODE_EXE=%AZ_SHIM_NODE%"
"%AZ_SHIM_NODE_EXE%" "%~dp0az-shim.cjs" %*
exit /b %ERRORLEVEL%
