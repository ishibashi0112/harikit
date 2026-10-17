import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { readXlsx, serialToIso, parseCsv, cellRef } from "../src/index.js";

/** テスト用の最小の zip（deflate）を作る。CRC は読む側が見ないので 0 にする。 */
function zip(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(Buffer.byteLength(text), 22);
    h.writeUInt16LE(nameBuf.length, 26);
    local.push(h, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(Buffer.byteLength(text), 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

test("共有文字列（ふりがなは除く）、日付書式、インライン文字列、真偽、エラー値", async () => {
  const book = zip({
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="商品" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>ProductCode</t></si><si><r><t>商品</t></r><r><t>名</t></r><rPh sb="0" eb="2"><t>ショウヒン</t></rPh></si><si><t xml:space="preserve"> A&amp;B </t></si></sst>`,
    "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3" s="1"><v>45582</v></c><c r="D3" t="inlineStr"><is><t>直接</t></is></c><c r="E3" t="b"><v>1</v></c><c r="F3" t="e"><v>#N/A</v></c><c r="G3"><v>130.5</v></c></row>
    </sheetData></worksheet>`,
  });
  const [sheet] = await readXlsx(book);
  assert.equal(sheet!.name, "商品");
  assert.deepEqual(sheet!.rows[0], ["ProductCode", "商品名"]);
  assert.deepEqual(sheet!.rows[1], []);
  assert.deepEqual(sheet!.rows[2], [" A&B ", null, { kind: "date", iso: "2024-10-17T00:00:00.000" }, "直接", true, { kind: "error", text: "#N/A" }, 130.5]);
});

test("openpyxl で作った例のファイルを読める", async () => {
  const data = await readFile(new URL("../../../../examples/sqlserver/price-update.xlsx", import.meta.url));
  const [sheet] = await readXlsx(data);
  assert.equal(sheet!.name, "価格改定");
  assert.deepEqual(sheet!.rows[0], ["ProductCode", "ProductName", "UnitPrice", "CategoryCode", "ReleaseDate"]);
  assert.deepEqual(sheet!.rows[1], ["A001", "ボールペン黒", 130, "C01", { kind: "date", iso: "2024-04-01T00:00:00.000" }]);
});

test("シリアル値（1900 年方式と 1904 年方式）", () => {
  assert.equal(serialToIso(1), "1900-01-01T00:00:00.000");
  assert.equal(serialToIso(61), "1900-03-01T00:00:00.000");
  assert.equal(serialToIso(45582.5), "2024-10-17T12:00:00.000");
  assert.equal(serialToIso(0, true), "1904-01-01T00:00:00.000");
});

test("CSV", () => {
  const s = parseCsv('﻿a,b,c\r\n"x,1","say ""hi""",\n"",,z');
  assert.deepEqual(s.rows, [["a", "b", "c"], ["x,1", 'say "hi"', null], ["", null, "z"]]);
  assert.equal(cellRef(2, 27), "AB3");
});
