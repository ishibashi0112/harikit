#!/bin/sh
# Mono の mcs で bin/Patchiri.Server.dll を作る（Windows の build.cmd にあたる）。
# C# 5 に限ってビルドする（.NET Framework 付属の csc と、Web サイトの App_Code でもそのまま通るように）。
set -e
cd "$(dirname "$0")"
# テストが並んで同時に呼んでも、書きかけの DLL を読まれないよう、別のフォルダに作ってから置き換える。
mkdir -p bin
out=$(mktemp -d bin/.build.XXXXXX)
trap 'rm -rf "$out"' EXIT
mcs -nologo -langversion:5 -warnaserror -target:library -out:"$out/Patchiri.Server.dll" \
  -r:System.dll -r:System.Data.dll -r:System.Configuration.dll -r:System.Web.dll -r:System.Web.Extensions.dll \
  src/*.cs
mv -f "$out/Patchiri.Server.dll" bin/Patchiri.Server.dll
