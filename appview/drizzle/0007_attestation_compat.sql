-- TN-V2-META-003 — reviewer-declared compatibility tags on
-- attestations.
--
-- Adds a single opt-in `text[]` column. Closed-vocabulary list
-- on the writer side (ios/android/macos/windows/usb-c/lightning/
-- 110v/240v/bluetooth-5/…) — AppView indexes the opaque tags so
-- the vocabulary can expand without redeploying the ingester.
--
-- Cap (15 entries × 50 chars each) enforced by Zod at the gate;
-- broader than compliance/accessibility (10) because devices
-- legitimately check many compatibility boxes simultaneously.
--
-- Empty arrays collapsed to NULL on the ingest path so the GIN
-- index doesn't carry zero-length rows. Subject-level merge into
-- `subjects.metadata.compat.tags` is deferred to META-001's
-- unified reviewer-declared metadata pipeline.

ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "compat" text[];

-- GIN array-overlap index — same pattern as
-- `attestations_compliance_idx` / `attestations_accessibility_idx`.
-- Powers RANK-003's array-OVERLAP search filter ("things
-- compatible with usb-c OR lightning").
CREATE INDEX IF NOT EXISTS "attestations_compat_idx"
  ON "attestations" USING gin ("compat");
