-- VIGIL v4 — initial schema. Reproducible record of the SQL run in the Supabase dashboard.
-- Patient channel = SMS; protocol is CDS-authored and cached per visit in patients.protocol.

create table patients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  dob date,
  age int,
  sex text,
  phone text,                          -- E.164; inbound SMS maps From -> patient
  channel text not null default 'sms' check (channel in ('sms','voice')),
  complaint text,
  esi int not null check (esi between 3 and 5),
  protocol jsonb,                      -- CdsProtocol, authored once per visit then frozen
  baseline jsonb,                      -- {complete, answers, severityBaseline}
  tier text not null default 'routine' check (tier in ('routine','watch','escalate')),
  review_now boolean not null default false,
  tier_reason text,
  trend text,
  suggested_action text,
  stable_cycles int not null default 0,
  ack_at timestamptz,
  ack_by text,
  cadence_minutes int not null default 30,
  next_checkin_due timestamptz,
  last_response_at timestamptz,
  is_demo_seed boolean not null default false,
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  role text not null check (role in ('agent','patient','system')),
  content text not null,
  trace jsonb,                         -- CheckinTrace, or {kind:'alert', ...} for alert rows
  created_at timestamptz not null default now()
);

create index messages_patient_id_created_at on messages (patient_id, created_at);
create index patients_phone on patients (phone);

alter publication supabase_realtime add table patients;

-- Light hardening (public deployed URL; anon key is public by design).
alter table patients enable row level security;
alter table messages enable row level security;
create policy "anon read patients" on patients for select using (true);
-- No anon policy on messages: transcripts are fetched via server routes only.
-- All writes go through server routes using the secret key (bypasses RLS).
