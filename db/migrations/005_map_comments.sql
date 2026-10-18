CREATE TABLE community_profiles (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE community_sessions (
  token_hash text PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES community_profiles(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX community_sessions_expiry_idx ON community_sessions(expires_at);
CREATE TABLE community_friendships (
  profile_low uuid NOT NULL REFERENCES community_profiles(id) ON DELETE CASCADE,
  profile_high uuid NOT NULL REFERENCES community_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(profile_low, profile_high), CHECK (profile_low < profile_high)
);
CREATE INDEX community_friendships_high_idx ON community_friendships(profile_high);
CREATE TABLE community_invites (
  profile_id uuid PRIMARY KEY REFERENCES community_profiles(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE map_comments (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES community_profiles(id) ON DELETE CASCADE,
  poi_id text NOT NULL CHECK (poi_id ~ '^(node|way|relation)/[0-9]+$'),
  body text NOT NULL CHECK (char_length(body) BETWEEN 3 AND 1000),
  visibility text NOT NULL CHECK (visibility IN ('public', 'friends')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);
-- POI identity survives dataset imports. Reads join only the currently published POIs.
CREATE INDEX map_comments_place_expiry_idx ON map_comments(poi_id, expires_at);
CREATE INDEX map_comments_author_idx ON map_comments(author_id, created_at);
ALTER TABLE community_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_comments ENABLE ROW LEVEL SECURITY;
