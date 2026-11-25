create table if not exists webhook_ingest (
  id integer primary key,
  window_start timestamptz not null,
  hits integer not null,
  constraint webhook_ingest_id_chk check (id = 1)
);
