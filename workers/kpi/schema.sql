CREATE TABLE IF NOT EXISTS kpi_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  event TEXT NOT NULL CHECK (event IN ('lp_view', 'tarot_draw', 'booking_dm_click', 'tarot_share_click')),
  page TEXT NOT NULL DEFAULT 'lp' CHECK (page = 'lp'),
  mode TEXT CHECK (mode IS NULL OR mode IN ('daily', 'love')),
  placement TEXT CHECK (placement IS NULL OR placement IN ('hero', 'instagram_card', 'sticky_mobile')),
  channel TEXT CHECK (channel IS NULL OR channel IN ('x', 'line', 'copy', 'native')),
  event_date_jst TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (event <> 'lp_view' OR (mode IS NULL AND placement IS NULL AND channel IS NULL)),
  CHECK (event <> 'tarot_draw' OR (mode IS NOT NULL AND placement IS NULL AND channel IS NULL)),
  CHECK (event <> 'booking_dm_click' OR (placement IS NOT NULL AND mode IS NULL AND channel IS NULL)),
  CHECK (event <> 'tarot_share_click' OR (channel IS NOT NULL AND mode IS NULL AND placement IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_kpi_events_date_event ON kpi_events (event_date_jst, event);
CREATE INDEX IF NOT EXISTS idx_kpi_events_created_at ON kpi_events (created_at);
