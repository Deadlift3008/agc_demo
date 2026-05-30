CREATE TABLE repos (
    id                    SERIAL PRIMARY KEY,
    owner                 TEXT NOT NULL,
    name                  TEXT NOT NULL,
    default_branch        TEXT,
    description           TEXT,
    stars                 INT,
    forks                 INT,
    open_issues           INT,
    pushed_at             TIMESTAMPTZ,
    last_fetched_at       TIMESTAMPTZ,
    commits_deepest_page  INT NOT NULL DEFAULT 0,
    pulls_deepest_page    INT NOT NULL DEFAULT 0,
    issues_deepest_page   INT NOT NULL DEFAULT 0,
    releases_deepest_page INT NOT NULL DEFAULT 0,
    UNIQUE (owner, name)
);

CREATE TABLE commits (
    sha           TEXT PRIMARY KEY,
    repo_id       INT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    message       TEXT,
    author_login  TEXT,
    author_name   TEXT,
    committed_at  TIMESTAMPTZ,
    url           TEXT
);
CREATE INDEX commits_repo_ts ON commits (repo_id, committed_at DESC);

CREATE TABLE pulls (
    repo_id       INT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    number        INT NOT NULL,
    title         TEXT,
    state         TEXT,
    author_login  TEXT,
    created_at    TIMESTAMPTZ,
    closed_at     TIMESTAMPTZ,
    merged_at     TIMESTAMPTZ,
    url           TEXT,
    PRIMARY KEY (repo_id, number)
);

CREATE TABLE issues (
    repo_id       INT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    number        INT NOT NULL,
    title         TEXT,
    state         TEXT,
    author_login  TEXT,
    created_at    TIMESTAMPTZ,
    closed_at     TIMESTAMPTZ,
    url           TEXT,
    PRIMARY KEY (repo_id, number)
);

CREATE TABLE releases (
    repo_id       INT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    id            BIGINT NOT NULL,
    tag_name      TEXT,
    name          TEXT,
    published_at  TIMESTAMPTZ,
    url           TEXT,
    PRIMARY KEY (repo_id, id)
);

CREATE TABLE events (
    id       UUID PRIMARY KEY,
    ts       TIMESTAMPTZ NOT NULL,
    lesson   TEXT NOT NULL,
    channel  TEXT NOT NULL,
    kind     TEXT NOT NULL,
    role     TEXT,
    title    TEXT,
    body     TEXT,
    data     JSONB
);
CREATE INDEX events_channel_ts_idx ON events (channel, ts DESC);
CREATE INDEX events_lesson_ts_idx  ON events (lesson,  ts DESC);

-- Единственный репозиторий: https://github.com/daksha-dev/openclaw
INSERT INTO repos (owner, name, default_branch, description, stars, forks, open_issues, pushed_at)
VALUES (
    'daksha-dev',
    'openclaw',
    'main',
    'Your own personal AI assistant. Any OS. Any Platform. The lobster way. 🦞',
    0, 0, 0,
    '2026-03-23T06:02:02Z'
);
