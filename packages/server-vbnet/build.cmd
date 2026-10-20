@echo off
rem Builds bin\Patchiri.Server.dll with the VB 11 compiler that ships with .NET Framework. See README.md.
rem (ASCII only: cmd.exe reads this file in the OEM code page.)
setlocal
set VBC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\vbc.exe
if not exist "%VBC%" set VBC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\vbc.exe
cd /d "%~dp0"
if not exist bin mkdir bin
"%VBC%" /nologo /noconfig /warnaserror+ /target:library /out:bin\Patchiri.Server.dll /r:System.dll /r:System.Core.dll /r:System.Data.dll /r:System.Configuration.dll /r:System.Web.dll /r:System.Web.Extensions.dll src\*.vb
exit /b %ERRORLEVEL%
