@echo off
rem Builds bin\Harikit.Server.dll with the C# 5 compiler that ships with .NET Framework. See README.md.
rem (ASCII only: cmd.exe reads this file in the OEM code page.)
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
cd /d "%~dp0"
if not exist bin mkdir bin
"%CSC%" /nologo /warnaserror+ /target:library /out:bin\Harikit.Server.dll /r:System.dll /r:System.Data.dll /r:System.Configuration.dll /r:System.Web.dll /r:System.Web.Extensions.dll src\*.cs
exit /b %ERRORLEVEL%
