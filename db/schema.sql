-- D1 schema for the product catalog (optional durable backend).
--
-- The Worker uses the in-memory store unless a D1 binding named `DB` is present.
-- To use D1:
--   1. wrangler d1 create ucp-mock-merchants
--   2. uncomment the [[d1_databases]] block in wrangler.toml and set database_id
--   3. wrangler d1 execute ucp-mock-merchants --file db/schema.sql
--   4. seed via the API: POST /:id/products/import  (or per-product POST /:id/products)
--
-- One row per (merchant, sku); the full Product is stored as JSON so the rich
-- model (variants, dimensions, shipping, …) needs no column-per-field migration.

CREATE TABLE IF NOT EXISTS products (
  merchant TEXT NOT NULL,
  sku      TEXT NOT NULL,
  json     TEXT NOT NULL,
  PRIMARY KEY (merchant, sku)
);

CREATE INDEX IF NOT EXISTS idx_products_merchant ON products (merchant);
