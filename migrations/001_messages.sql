create table if not exists messages (
  update_id bigint primary key,
  message_id bigint not null,
  "date" bigint not null,
  chat_id bigint not null,
  chat_title text,
  from_username text,
  "text" text,
  caption text,
  media_kind text,
  received_at timestamptz not null default now(),
  constraint messages_media_kind_chk check (
    media_kind is null or media_kind in ('photo', 'document', 'voice')
  )
);
