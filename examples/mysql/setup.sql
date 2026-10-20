-- harikit の例で使うテーブル。MySQL 8.0 以降、MariaDB 10.11 以降。
--   mysql -h 127.0.0.1 -u harikit -p --default-character-set=utf8mb4 harikit < setup.sql
SET NAMES utf8mb4;
DROP TABLE IF EXISTS M_Product, M_Category;
CREATE TABLE M_Category (
  CategoryCode varchar(4) NOT NULL PRIMARY KEY,
  CategoryName varchar(20) NOT NULL
) DEFAULT CHARSET utf8mb4;
CREATE TABLE M_Product (
  ProductCode varchar(10) NOT NULL PRIMARY KEY,
  ProductName varchar(50) NOT NULL,
  CategoryCode varchar(4) NOT NULL,
  UnitPrice decimal(9,2),
  ReleaseDate date,
  UpdatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT FK_M_Product_Category FOREIGN KEY (CategoryCode) REFERENCES M_Category (CategoryCode)
) DEFAULT CHARSET utf8mb4;
INSERT INTO M_Category VALUES ('C01', '筆記具'), ('C02', 'ノート'), ('C03', 'ファイル');
INSERT INTO M_Product (ProductCode, ProductName, CategoryCode, UnitPrice, ReleaseDate) VALUES
  ('A001', 'ボールペン黒', 'C01', 120.00, '2024-04-01'),
  ('A002', 'ボールペン赤', 'C01', NULL, '2024-04-01'),
  ('A003', 'シャープペン', 'C01', 300.00, NULL),
  ('B001', '大学ノート A4', 'C02', 180.00, '2023-10-01'),
  ('B002', '方眼ノート', 'C02', 220.00, '2023-10-01');
