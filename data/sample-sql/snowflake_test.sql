CREATE DATABASE IF NOT EXISTS demo_db;
CREATE SCHEMA IF NOT EXISTS demo_db.public;

DROP TABLE IF EXISTS demo_db.public.customers;

CREATE TABLE demo_db.public.customers (
  id INTEGER,
  name VARCHAR,
  email VARCHAR,
  created_at TIMESTAMP
);
