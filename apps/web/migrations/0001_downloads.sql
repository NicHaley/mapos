-- Download counts, bucketed by UTC day and coarse client kind (mac | other | bot).
CREATE TABLE IF NOT EXISTS downloads (
  day TEXT NOT NULL,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, platform)
);
