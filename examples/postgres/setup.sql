-- patchiri の例で使うテーブル。PostgreSQL 用（14 以降）。
--   psql -h localhost -U patchiri -d patchiri -f setup.sql
-- 名前は "" で囲まないので小文字になる（m_product、productcode など）。patchiri は列名の大文字小文字を区別しないので、
-- SQL Server の例と同じ Excel（見出しが ProductCode など）がそのまま使える。
SET client_encoding = 'UTF8';
DROP TABLE IF EXISTS M_Product, M_Category;
CREATE TABLE M_Category (
  CategoryCode varchar(4) NOT NULL PRIMARY KEY,
  CategoryName varchar(20) NOT NULL
);
CREATE TABLE M_Product (
  ProductCode varchar(10) NOT NULL PRIMARY KEY,
  ProductName varchar(50) NOT NULL,
  CategoryCode varchar(4) NOT NULL CONSTRAINT FK_M_Product_Category REFERENCES M_Category (CategoryCode),
  UnitPrice numeric(9,2),
  ReleaseDate date,
  UpdatedAt timestamp(3) NOT NULL DEFAULT localtimestamp(3)
);
INSERT INTO M_Category VALUES ('C01', '筆記具'), ('C02', 'ノート'), ('C03', 'ファイル');
INSERT INTO M_Product (ProductCode, ProductName, CategoryCode, UnitPrice, ReleaseDate) VALUES
  ('A001', 'ボールペン黒', 'C01', 120.00, '2024-04-01'),
  ('A002', 'ボールペン赤', 'C01', NULL, '2024-04-01'),
  ('A003', 'シャープペン', 'C01', 300.00, NULL),
  ('B001', '大学ノート A4', 'C02', 180.00, '2023-10-01'),
  ('B002', '方眼ノート', 'C02', 220.00, '2023-10-01');
