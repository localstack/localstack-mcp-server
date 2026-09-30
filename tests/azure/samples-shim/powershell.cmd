@echo off
rem Samples replay, Windows (see README.md, "Windows"): a sample step may not start the machine's
rem PowerShell. An SDK credential chain that falls through to AzurePowerShellCredential would load
rem the Az module, which keeps its profile in the REAL user folder (%USERPROFILE%\.Azure: .NET
rem ignores the step's private USERPROFILE).
echo localstack samples replay: `%~n0` is blocked for sample steps, so no credential chain reaches the machine's own Azure profile 1>&2
exit /b 1
