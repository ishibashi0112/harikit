#!/bin/sh
# bin/Patchiri.Server.dll を作る（Windows の build.cmd にあたる。Linux の CI とクラウドのコンテナ向け）。
# .NET SDK 付属の Roslyn の vbc で、VB 11 に限ってビルドする（.NET Framework 付属の vbc と、Web サイトの App_Code でもそのまま通るように）。
# 参照するのは Mono の .NET Framework 4.5 の参照アセンブリ（4.5 にない API を使うとここで止まる）。
# Mono には Microsoft.VisualBasic.dll がないので、VB のランタイムは DLL に埋め込む（-vbruntime*）。build.cmd は埋め込まない。
set -e
cd "$(dirname "$0")"
sdk=$(dotnet --list-sdks | tail -n 1)
version=${sdk%% *}
dir=${sdk#*[}
dir=${dir%]}
api="$(dirname "$(dirname "$(command -v mono)")")/lib/mono/4.5-api"
# テストが並んで同時に呼んでも、書きかけの DLL を読まれないよう、別のフォルダに作ってから置き換える。
mkdir -p bin
out=$(mktemp -d bin/.build.XXXXXX)
trap 'rm -rf "$out"' EXIT
dotnet "$dir/$version/Roslyn/bincore/vbc.dll" -nologo -noconfig -nostdlib -langversion:11 -warnaserror -vbruntime* \
  -target:library -out:"$out/Patchiri.Server.dll" -sdkpath:"$api" \
  -r:"$api/mscorlib.dll" -r:"$api/System.dll" -r:"$api/System.Core.dll" -r:"$api/System.Data.dll" \
  -r:"$api/System.Configuration.dll" -r:"$api/System.Web.dll" -r:"$api/System.Web.Extensions.dll" \
  src/*.vb
mv -f "$out/Patchiri.Server.dll" bin/Patchiri.Server.dll
