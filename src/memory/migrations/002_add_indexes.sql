CREATE INDEX IF NOT EXISTS idx_panels_name ON panels(name);
CREATE INDEX IF NOT EXISTS idx_debates_panel_id ON debates(panel_id);
