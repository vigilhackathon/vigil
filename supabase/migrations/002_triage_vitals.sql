-- VIGIL — display-only ED triage enrichment. Additive + nullable = safe to apply live.
-- Adds the triage note and vitals captured at ED registration so the mock EMR patient
-- chart shows realistic intake data. Purely for display; the guardrail/protocol logic
-- does not read these columns.

alter table patients add column if not exists triage_note text;
alter table patients add column if not exists vitals jsonb; -- {temp_c, hr, bp, rr, spo2, pain}
