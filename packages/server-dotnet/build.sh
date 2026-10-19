#!/bin/sh
# Mono の mcs で bin/Harikit.Server.dll を作る（Windows の build.cmd にあたる）。
# C# 5 に限ってビルドする（.NET Framework 付属の csc と、Web サイトの App_Code でもそのまま通るように）。
set -e
cd "$(dirname "$0")"
mkdir -p bin
mcs -nologo -langversion:5 -warnaserror -target:library -out:bin/Harikit.Server.dll \
  -r:System.dll -r:System.Data.dll -r:System.Configuration.dll -r:System.Web.dll -r:System.Web.Extensions.dll \
  src/*.cs
