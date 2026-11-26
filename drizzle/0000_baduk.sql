CREATE TABLE IF NOT EXISTS baduk_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS baduk_entities (
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  ref_one TEXT,
  ref_two TEXT,
  body TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id, part)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS baduk_receipts (
  account_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  PRIMARY KEY (account_id, command_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS baduk_events (
  account_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (account_id, cursor)
);
