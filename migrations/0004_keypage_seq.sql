-- Key page version: an upload must carry a seq higher than the stored one, so an old signed pair can't be
-- replayed to bring back a revoked key.
ALTER TABLE keypages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
