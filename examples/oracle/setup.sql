-- harikit の例で使うテーブル。Oracle 用（12c 以降）。
--   sqlplus harikit/パスワード@localhost:1521/FREEPDB1 @setup.sql
-- 列名は "" で囲まないので大文字になる（PRODUCTCODE など）。harikit は列名の大文字小文字を区別しないので、
-- SQL Server の例と同じ Excel（見出しが ProductCode など）がそのまま使える。
-- SQL*Plus で日本語を入れるときは、端末の文字コードに NLS_LANG を合わせる（例 Japanese_Japan.AL32UTF8）。
SET DEFINE OFF
BEGIN
  FOR t IN (SELECT table_name FROM user_tables WHERE table_name IN ('M_PRODUCT', 'M_CATEGORY')) LOOP
    EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS PURGE';
  END LOOP;
END;
/
CREATE TABLE M_Category (
  CategoryCode VARCHAR2(4) NOT NULL PRIMARY KEY,
  CategoryName NVARCHAR2(20) NOT NULL
);
CREATE TABLE M_Product (
  ProductCode VARCHAR2(10) NOT NULL PRIMARY KEY,
  ProductName NVARCHAR2(50) NOT NULL,
  CategoryCode VARCHAR2(4) NOT NULL CONSTRAINT FK_M_Product_Category REFERENCES M_Category (CategoryCode),
  UnitPrice NUMBER(9,2),
  ReleaseDate DATE,
  UpdatedAt TIMESTAMP(3) DEFAULT SYSTIMESTAMP NOT NULL
);
INSERT INTO M_Category VALUES ('C01', N'筆記具');
INSERT INTO M_Category VALUES ('C02', N'ノート');
INSERT INTO M_Category VALUES ('C03', N'ファイル');
INSERT INTO M_Product (ProductCode, ProductName, CategoryCode, UnitPrice, ReleaseDate) VALUES ('A001', N'ボールペン黒', 'C01', 120.00, DATE '2024-04-01');
INSERT INTO M_Product (ProductCode, ProductName, CategoryCode, UnitPrice, ReleaseDate) VALUES ('A002', N'ボールペン赤', 'C01', NULL, DATE '2024-04-01');
INSERT INTO M_Product (ProductCode, ProductName, CategoryCode, UnitPrice, ReleaseDate) VALUES ('A003', N'シャープペン', 'C01', 300.00, NULL);
INSERT INTO M_Product (ProductCode, ProductName, CategoryCode, UnitPrice, ReleaseDate) VALUES ('B001', N'大学ノート A4', 'C02', 180.00, DATE '2023-10-01');
INSERT INTO M_Product (ProductCode, ProductName, CategoryCode, UnitPrice, ReleaseDate) VALUES ('B002', N'方眼ノート', 'C02', 220.00, DATE '2023-10-01');
COMMIT;
