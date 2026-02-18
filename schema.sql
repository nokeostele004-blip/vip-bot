
CREATE TABLE groups (
  telegram_group_id TEXT PRIMARY KEY,
  name TEXT,
  price_1d INTEGER,
  price_7d INTEGER,
  price_30d INTEGER
);

CREATE TABLE subscriptions (
  telegram_user_id TEXT,
  telegram_group_id TEXT,
  expire_at INTEGER,
  PRIMARY KEY (telegram_user_id, telegram_group_id)
);

CREATE TABLE transactions (
  order_id TEXT PRIMARY KEY,
  telegram_user_id TEXT,
  telegram_group_id TEXT,
  duration TEXT,
  amount INTEGER,
  status TEXT
);
