-- Rename trust_* tables and indexes to peerview_* (pre-release clean-slate rename)
-- No data migration needed — tables are empty on all environments.

ALTER TABLE "trust_edges" RENAME TO "peerview_edges";
--> statement-breakpoint
ALTER TABLE "trust_policies" RENAME TO "peerview_policies";
--> statement-breakpoint
ALTER TABLE "trust_v1_params" RENAME TO "peerview_v1_params";
--> statement-breakpoint

-- Rename constraints
ALTER TABLE "peerview_edges" RENAME CONSTRAINT "trust_edges_source_uri_unique" TO "peerview_edges_source_uri_unique";
--> statement-breakpoint
ALTER TABLE "peerview_policies" RENAME CONSTRAINT "trust_policies_author_did_unique" TO "peerview_policies_author_did_unique";
--> statement-breakpoint

-- Rename indexes
ALTER INDEX "trust_edges_from_idx" RENAME TO "peerview_edges_from_idx";
--> statement-breakpoint
ALTER INDEX "trust_edges_to_idx" RENAME TO "peerview_edges_to_idx";
--> statement-breakpoint
ALTER INDEX "trust_edges_from_to_idx" RENAME TO "peerview_edges_from_to_idx";
--> statement-breakpoint
ALTER INDEX "trust_edges_type_idx" RENAME TO "peerview_edges_type_idx";
--> statement-breakpoint
ALTER INDEX "trust_policies_author_idx" RENAME TO "peerview_policies_author_idx";
