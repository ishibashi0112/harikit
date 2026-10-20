-- patchiri の例で使うテーブル。SQL Server 用。
IF DB_ID(N'PatchiriSample') IS NULL CREATE DATABASE PatchiriSample;
GO
USE PatchiriSample;
GO
DROP TABLE IF EXISTS dbo.M_Product;
DROP TABLE IF EXISTS dbo.M_Category;
GO
CREATE TABLE dbo.M_Category (
  CategoryCode varchar(4) NOT NULL PRIMARY KEY,
  CategoryName nvarchar(20) NOT NULL
);
CREATE TABLE dbo.M_Product (
  ProductCode varchar(10) NOT NULL PRIMARY KEY,
  ProductName nvarchar(50) NOT NULL,
  CategoryCode varchar(4) NOT NULL CONSTRAINT FK_M_Product_Category REFERENCES dbo.M_Category (CategoryCode),
  UnitPrice decimal(9,2) NULL,
  ReleaseDate date NULL,
  UpdatedAt datetime2(3) NOT NULL DEFAULT SYSDATETIME()
);
GO
INSERT INTO dbo.M_Category VALUES ('C01', N'筆記具'), ('C02', N'ノート'), ('C03', N'ファイル');
INSERT INTO dbo.M_Product (ProductCode, ProductName, CategoryCode, UnitPrice, ReleaseDate) VALUES
  ('A001', N'ボールペン黒', 'C01', 120.00, '2024-04-01'),
  ('A002', N'ボールペン赤', 'C01', NULL, '2024-04-01'),
  ('A003', N'シャープペン', 'C01', 300.00, NULL),
  ('B001', N'大学ノート A4', 'C02', 180.00, '2023-10-01'),
  ('B002', N'方眼ノート', 'C02', 220.00, '2023-10-01');
GO
