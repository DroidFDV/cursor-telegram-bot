create table if not exists inbox_rate (
  id integer primary key,
  window_start timestamptz not null,
  hits integer not null,
  constraint inbox_rate_id_chk check (id = 1)
);
