@echo off
rem Samples replay, Windows (see README.md, "Windows"): a sample step may not start the machine's
rem Azure Developer CLI, the last tool an SDK credential chain tries (AzureDeveloperCliCredential):
rem azd keeps its login under the REAL user folder, whatever the step's private USERPROFILE says.
echo localstack samples replay: `%~n0` is blocked for sample steps, so no credential chain reaches the machine's own Azure profile 1>&2
exit /b 1
