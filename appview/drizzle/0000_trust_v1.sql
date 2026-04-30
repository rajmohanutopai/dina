CREATE TABLE IF NOT EXISTS "amendments" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"target_uri" text NOT NULL,
	"amendment_type" text NOT NULL,
	"text" text,
	"new_values_json" jsonb,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "anomaly_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"involved_dids" text[] NOT NULL,
	"details" jsonb,
	"severity" text NOT NULL,
	"resolved" boolean DEFAULT false,
	"dedup_hash" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "appview_config" (
	"key" text PRIMARY KEY NOT NULL,
	"bool_value" boolean,
	"text_value" text,
	"description" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attestations" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"subject_id" text,
	"subject_ref_raw" jsonb NOT NULL,
	"category" text NOT NULL,
	"sentiment" text NOT NULL,
	"domain" text,
	"confidence" text,
	"is_agent_generated" boolean DEFAULT false,
	"has_cosignature" boolean DEFAULT false,
	"cosigner_did" text,
	"dimensions_json" jsonb,
	"interaction_context_json" jsonb,
	"content_context_json" jsonb,
	"product_context_json" jsonb,
	"evidence_json" jsonb,
	"mentions_json" jsonb,
	"related_attestations_json" jsonb,
	"bilateral_review_json" jsonb,
	"tags" text[],
	"text" text,
	"search_content" text,
	"language" text,
	"namespace" text,
	"trace_id" text,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL,
	"is_revoked" boolean DEFAULT false,
	"revoked_by_uri" text,
	"is_amended" boolean DEFAULT false,
	"latest_amendment_uri" text,
	"is_verified" boolean DEFAULT false,
	"verified_by_uri" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collections" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"items_json" jsonb NOT NULL,
	"is_discoverable" boolean DEFAULT true,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comparisons" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"subjects_json" jsonb NOT NULL,
	"category" text NOT NULL,
	"dimensions_json" jsonb,
	"text" text,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cosig_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"requester_did" text NOT NULL,
	"recipient_did" text NOT NULL,
	"attestation_uri" text NOT NULL,
	"status" text NOT NULL,
	"endorsement_uri" text,
	"reject_reason" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cosig_requests_status_check" CHECK ("cosig_requests"."status" IN ('pending', 'accepted', 'rejected', 'expired'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delegations" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"subject_did" text NOT NULL,
	"scope" text NOT NULL,
	"permissions_json" jsonb NOT NULL,
	"expires_at" timestamp,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "did_profiles" (
	"did" text PRIMARY KEY NOT NULL,
	"score_version" text DEFAULT 'v1' NOT NULL,
	"needs_recalc" boolean DEFAULT true NOT NULL,
	"total_attestations_about" integer DEFAULT 0,
	"positive_about" integer DEFAULT 0,
	"neutral_about" integer DEFAULT 0,
	"negative_about" integer DEFAULT 0,
	"vouch_count" integer DEFAULT 0,
	"vouch_strength" text DEFAULT 'unvouched',
	"high_confidence_vouches" integer DEFAULT 0,
	"endorsement_count" integer DEFAULT 0,
	"top_skills_json" jsonb,
	"active_flag_count" integer DEFAULT 0,
	"total_attestations_by" integer DEFAULT 0,
	"revocation_count" integer DEFAULT 0,
	"deletion_count" integer DEFAULT 0,
	"disputed_then_deleted_count" integer DEFAULT 0,
	"revocation_rate" real DEFAULT 0,
	"deletion_rate" real DEFAULT 0,
	"corroboration_rate" real DEFAULT 0,
	"evidence_rate" real DEFAULT 0,
	"average_helpful_ratio" real DEFAULT 0,
	"active_domains" text[],
	"is_agent" boolean DEFAULT false,
	"account_first_seen" timestamp,
	"last_active" timestamp,
	"coordination_flag_count" integer DEFAULT 0,
	"overall_trust_score" real,
	"computed_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"domain" text NOT NULL,
	"trust_score" real,
	"attestation_count" integer DEFAULT 0,
	"needs_recalc" boolean DEFAULT true NOT NULL,
	"computed_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endorsements" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"subject_did" text NOT NULL,
	"skill" text NOT NULL,
	"endorsement_type" text NOT NULL,
	"relationship" text,
	"text" text,
	"namespace" text,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flags" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"subject_id" text,
	"subject_ref_raw" jsonb NOT NULL,
	"flag_type" text NOT NULL,
	"severity" text NOT NULL,
	"text" text,
	"evidence_json" jsonb,
	"is_active" boolean DEFAULT true,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingest_rejections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at_uri" text NOT NULL,
	"did" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb,
	"rejected_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingester_cursor" (
	"service" text PRIMARY KEY NOT NULL,
	"cursor" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"parent_uri" text NOT NULL,
	"media_type" text NOT NULL,
	"url" text NOT NULL,
	"alt" text,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mention_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"source_uri" text NOT NULL,
	"source_did" text NOT NULL,
	"target_did" text NOT NULL,
	"role" text,
	"record_type" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_prefs" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"enable_mentions" boolean DEFAULT true,
	"enable_reactions" boolean DEFAULT true,
	"enable_replies" boolean DEFAULT true,
	"enable_flags" boolean DEFAULT true,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_author_did_unique" UNIQUE("author_did")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reactions" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"target_uri" text NOT NULL,
	"reaction" text NOT NULL,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "replies" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"root_uri" text NOT NULL,
	"parent_uri" text NOT NULL,
	"intent" text NOT NULL,
	"text" text NOT NULL,
	"evidence_json" jsonb,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_records" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"target_uri" text NOT NULL,
	"report_type" text NOT NULL,
	"text" text,
	"evidence_json" jsonb,
	"related_records_json" jsonb,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_requests" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"subject_id" text,
	"subject_ref_raw" jsonb NOT NULL,
	"request_type" text NOT NULL,
	"text" text,
	"expires_at" timestamp,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reviewer_namespace_scores" (
	"did" text NOT NULL,
	"namespace" text NOT NULL,
	"score_version" text DEFAULT 'v1' NOT NULL,
	"needs_recalc" boolean DEFAULT true NOT NULL,
	"total_attestations_by" integer DEFAULT 0,
	"revocation_count" integer DEFAULT 0,
	"deletion_count" integer DEFAULT 0,
	"disputed_then_deleted_count" integer DEFAULT 0,
	"revocation_rate" real DEFAULT 0,
	"deletion_rate" real DEFAULT 0,
	"corroboration_rate" real DEFAULT 0,
	"evidence_rate" real DEFAULT 0,
	"overall_trust_score" real,
	"computed_at" timestamp NOT NULL,
	"namespace_first_seen" timestamp,
	"last_active" timestamp,
	CONSTRAINT "reviewer_namespace_scores_did_namespace_pk" PRIMARY KEY("did","namespace")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "revocations" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"target_uri" text NOT NULL,
	"reason" text NOT NULL,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "services" (
	"uri" text PRIMARY KEY NOT NULL,
	"operator_did" text NOT NULL,
	"cid" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"capabilities_json" jsonb NOT NULL,
	"lat" numeric,
	"lng" numeric,
	"radius_km" numeric,
	"hours_json" jsonb,
	"response_policy_json" jsonb,
	"capability_schemas_json" jsonb,
	"is_discoverable" boolean DEFAULT true NOT NULL,
	"search_content" text,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_claims" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"source_subject_id" text NOT NULL,
	"target_subject_id" text NOT NULL,
	"claim_type" text NOT NULL,
	"evidence_json" jsonb,
	"text" text,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_scores" (
	"subject_id" text PRIMARY KEY NOT NULL,
	"score_version" text DEFAULT 'v1' NOT NULL,
	"needs_recalc" boolean DEFAULT true NOT NULL,
	"total_attestations" integer DEFAULT 0,
	"positive" integer DEFAULT 0,
	"neutral" integer DEFAULT 0,
	"negative" integer DEFAULT 0,
	"weighted_score" real,
	"confidence" real,
	"dimension_summary_json" jsonb,
	"authenticity_consensus" text,
	"authenticity_confidence" real,
	"would_recommend_rate" real,
	"verified_attestation_count" integer DEFAULT 0,
	"last_attestation_at" timestamp,
	"attestation_velocity" real,
	"computed_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subjects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subject_type" text NOT NULL,
	"did" text,
	"identifiers_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_scoped_did" text,
	"canonical_subject_id" text,
	"needs_recalc" boolean DEFAULT true NOT NULL,
	"category" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language" text,
	"enriched_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suspended_pds_hosts" (
	"host" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"suspended_at" timestamp DEFAULT now() NOT NULL,
	"suspended_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"original_uri" text NOT NULL,
	"author_did" text NOT NULL,
	"record_type" text NOT NULL,
	"subject_id" text,
	"subject_ref_raw" jsonb,
	"category" text,
	"sentiment" text,
	"domain" text,
	"original_created_at" timestamp,
	"deleted_at" timestamp NOT NULL,
	"duration_days" integer,
	"had_evidence" boolean DEFAULT false,
	"had_cosignature" boolean DEFAULT false,
	"report_count" integer DEFAULT 0,
	"dispute_reply_count" integer DEFAULT 0,
	"suspicious_reaction_count" integer DEFAULT 0,
	CONSTRAINT "tombstones_original_uri_unique" UNIQUE("original_uri")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trust_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"from_did" text NOT NULL,
	"to_did" text NOT NULL,
	"edge_type" text NOT NULL,
	"domain" text,
	"weight" real NOT NULL,
	"source_uri" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "trust_edges_source_uri_unique" UNIQUE("source_uri")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trust_policies" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"max_graph_depth" integer,
	"trusted_domains_json" jsonb,
	"blocked_dids_json" jsonb,
	"require_vouch" boolean DEFAULT false,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trust_policies_author_did_unique" UNIQUE("author_did")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trust_v1_params" (
	"key" text PRIMARY KEY NOT NULL,
	"value" numeric NOT NULL,
	"description" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verifications" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"target_uri" text NOT NULL,
	"verification_type" text NOT NULL,
	"evidence_json" jsonb,
	"result" text NOT NULL,
	"text" text,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vouches" (
	"uri" text PRIMARY KEY NOT NULL,
	"author_did" text NOT NULL,
	"cid" text NOT NULL,
	"subject_did" text NOT NULL,
	"vouch_type" text NOT NULL,
	"confidence" text NOT NULL,
	"relationship" text,
	"known_since" text,
	"text" text,
	"record_created_at" timestamp NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attestations_subject_id_subjects_id_fk') THEN
    ALTER TABLE "attestations" ADD CONSTRAINT "attestations_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subject_scores_subject_id_subjects_id_fk') THEN
    ALTER TABLE "subject_scores" ADD CONSTRAINT "subject_scores_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "amendments_author_idx" ON "amendments" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "amendments_target_uri_idx" ON "amendments" USING btree ("target_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "anomaly_events_type_idx" ON "anomaly_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "anomaly_events_detected_idx" ON "anomaly_events" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "anomaly_dedup_idx" ON "anomaly_events" USING btree ("dedup_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_author_idx" ON "attestations" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_subject_idx" ON "attestations" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_sentiment_idx" ON "attestations" USING btree ("sentiment");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_domain_idx" ON "attestations" USING btree ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_category_idx" ON "attestations" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_created_idx" ON "attestations" USING btree ("record_created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_tags_idx" ON "attestations" USING gin ("tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_cosigner_idx" ON "attestations" USING btree ("cosigner_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_subject_sentiment_idx" ON "attestations" USING btree ("subject_id","sentiment");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_author_domain_idx" ON "attestations" USING btree ("author_did","domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_language_idx" ON "attestations" USING btree ("language") WHERE "attestations"."language" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attestations_author_namespace_idx" ON "attestations" USING btree ("author_did","namespace") WHERE "attestations"."namespace" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_author_idx" ON "collections" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comparisons_author_idx" ON "comparisons" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comparisons_category_idx" ON "comparisons" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cosig_requests_unique_tuple_idx" ON "cosig_requests" USING btree ("requester_did","attestation_uri","recipient_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cosig_requests_recipient_status_idx" ON "cosig_requests" USING btree ("recipient_did","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cosig_requests_expiry_idx" ON "cosig_requests" USING btree ("expires_at") WHERE "cosig_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegations_author_idx" ON "delegations" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegations_subject_idx" ON "delegations" USING btree ("subject_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "did_profiles_needs_recalc_idx" ON "did_profiles" USING btree ("needs_recalc") WHERE "did_profiles"."needs_recalc" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_scores_did_idx" ON "domain_scores" USING btree ("did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_scores_domain_idx" ON "domain_scores" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "domain_scores_did_domain_idx" ON "domain_scores" USING btree ("did","domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endorsements_author_idx" ON "endorsements" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endorsements_subject_idx" ON "endorsements" USING btree ("subject_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endorsements_skill_idx" ON "endorsements" USING btree ("skill");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endorsements_author_namespace_idx" ON "endorsements" USING btree ("author_did","namespace") WHERE "endorsements"."namespace" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flags_author_idx" ON "flags" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flags_subject_idx" ON "flags" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flags_severity_idx" ON "flags" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ingest_rejections_at_uri" ON "ingest_rejections" USING btree ("at_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ingest_rejections_purge" ON "ingest_rejections" USING btree ("rejected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_parent_uri_idx" ON "media" USING btree ("parent_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_author_did_idx" ON "media" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mention_edges_source_uri_idx" ON "mention_edges" USING btree ("source_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mention_edges_source_did_idx" ON "mention_edges" USING btree ("source_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mention_edges_target_did_idx" ON "mention_edges" USING btree ("target_did");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mention_edges_source_target_idx" ON "mention_edges" USING btree ("source_uri","target_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reactions_author_idx" ON "reactions" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reactions_target_uri_idx" ON "reactions" USING btree ("target_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reactions_reaction_idx" ON "reactions" USING btree ("reaction");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reactions_author_reaction_idx" ON "reactions" USING btree ("author_did","target_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replies_author_idx" ON "replies" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replies_root_uri_idx" ON "replies" USING btree ("root_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replies_parent_uri_idx" ON "replies" USING btree ("parent_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_records_author_idx" ON "report_records" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_records_target_uri_idx" ON "report_records" USING btree ("target_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_author_idx" ON "review_requests" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_subject_idx" ON "review_requests" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviewer_namespace_scores_needs_recalc_idx" ON "reviewer_namespace_scores" USING btree ("needs_recalc") WHERE "reviewer_namespace_scores"."needs_recalc" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviewer_namespace_scores_did_idx" ON "reviewer_namespace_scores" USING btree ("did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revocations_author_idx" ON "revocations" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revocations_target_uri_idx" ON "revocations" USING btree ("target_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_operator_did_idx" ON "services" USING btree ("operator_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_is_discoverable_idx" ON "services" USING btree ("is_discoverable");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_lat_lng_idx" ON "services" USING btree ("lat","lng");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_capabilities_idx" ON "services" USING gin ("capabilities_json");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_search_content_idx" ON "services" USING btree ("search_content");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subject_claims_source_idx" ON "subject_claims" USING btree ("source_subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subject_claims_target_idx" ON "subject_claims" USING btree ("target_subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subject_claims_author_did_idx" ON "subject_claims" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subject_scores_needs_recalc_idx" ON "subject_scores" USING btree ("needs_recalc") WHERE "subject_scores"."needs_recalc" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_did_idx" ON "subjects" USING btree ("did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_identifiers_idx" ON "subjects" USING gin ("identifiers_json");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_author_scoped_idx" ON "subjects" USING btree ("author_scoped_did") WHERE "subjects"."author_scoped_did" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_canonical_idx" ON "subjects" USING btree ("canonical_subject_id") WHERE "subjects"."canonical_subject_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_category_idx" ON "subjects" USING btree ("category") WHERE "subjects"."category" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_language_idx" ON "subjects" USING btree ("language") WHERE "subjects"."language" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_metadata_idx" ON "subjects" USING gin ("metadata" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_geo_idx" ON "subjects" USING btree (("metadata"->>'lat'),("metadata"->>'lng')) WHERE "subjects"."metadata" ? 'lat' AND "subjects"."metadata" ? 'lng';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tombstones_author_idx" ON "tombstones" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tombstones_subject_idx" ON "tombstones" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tombstones_deleted_idx" ON "tombstones" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trust_edges_from_idx" ON "trust_edges" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trust_edges_to_idx" ON "trust_edges" USING btree ("to_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trust_edges_from_to_idx" ON "trust_edges" USING btree ("from_did","to_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trust_edges_type_idx" ON "trust_edges" USING btree ("edge_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trust_policies_author_idx" ON "trust_policies" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verifications_author_idx" ON "verifications" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verifications_target_uri_idx" ON "verifications" USING btree ("target_uri");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vouches_author_idx" ON "vouches" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vouches_subject_idx" ON "vouches" USING btree ("subject_did");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- TN-DB-009: FTS columns + GIN indexes (mirrors src/db/fts_columns.ts).
-- These are NOT expressed in Drizzle schema (no `GENERATED ALWAYS AS`
-- column-builder support); kept in lockstep with FTS_DDL_STATEMENTS.
-- ---------------------------------------------------------------------------
ALTER TABLE attestations ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_content, ''))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_attestations_search ON attestations USING GIN (search_vector);--> statement-breakpoint
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, ''))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subjects_search ON subjects USING GIN (search_tsv);