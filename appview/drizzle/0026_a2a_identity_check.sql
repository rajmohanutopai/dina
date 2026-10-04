-- A2A directory (design §8.3): `signature_state = 'verified'` never outlives
-- the key that justified it. An identity event (the DID document changed: a
-- key may have rotated) withholds the card until a check against the new
-- document lands a verdict; a PLC directory that does not answer keeps it
-- withheld. The routine daily recheck does not withhold.
ALTER TABLE a2a_cards ADD COLUMN IF NOT EXISTS identity_check_pending boolean NOT NULL DEFAULT false;
