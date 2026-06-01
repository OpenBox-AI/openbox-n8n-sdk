-- Demo schema for the OpenBox n8n hosted example.
-- Runs automatically on first Postgres container start via /docker-entrypoint-initdb.d/
-- Idempotent — safe to re-run.

CREATE SCHEMA IF NOT EXISTS demo;

CREATE TABLE IF NOT EXISTS demo.customers (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER UNIQUE NOT NULL,
  name         TEXT,
  email        TEXT,
  company      TEXT,
  city         TEXT,
  website      TEXT,
  account_tier TEXT,
  risk_note    TEXT
);

INSERT INTO demo.customers
  (customer_id, name, email, company, city, website, account_tier, risk_note)
VALUES
  (1, 'Alice Johnson', 'alice@example.com', 'Acme Corp',   'New York',      'acme.example.com',    'pro',        'Long-time customer, no flags'),
  (2, 'Bob Smith',     'bob@example.com',   'Globex Inc',  'San Francisco', 'globex.example.com',  'free',       'Trial user, monitor for abuse'),
  (3, 'Carol White',   'carol@example.com', 'Initech Ltd', 'Austin',        'initech.example.com', 'enterprise', 'Key account, escalate billing issues')
ON CONFLICT (customer_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS demo.triage_events (
  event_id   SERIAL PRIMARY KEY,
  ticket_id  TEXT,
  route      TEXT,
  severity   TEXT,
  review     TEXT,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
