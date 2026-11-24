create table if not exists webhook_state (
  id integer primary key,
  status text not null,
  error text,
  next_attempt_at timestamptz,
  constraint webhook_state_id_chk check (id = 1),
  constraint webhook_state_status_chk check (status in ('pending', 'registered', 'failed'))
);
