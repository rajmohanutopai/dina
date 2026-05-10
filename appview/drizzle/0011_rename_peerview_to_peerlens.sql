-- Rename peerview_* tables and indexes to peerlens_*

ALTER TABLE "peerview_edges" RENAME TO "peerlens_edges";
--> statement-breakpoint
ALTER TABLE "peerview_policies" RENAME TO "peerlens_policies";
--> statement-breakpoint
ALTER TABLE "peerview_v1_params" RENAME TO "peerlens_v1_params";
--> statement-breakpoint

-- Rename constraints
ALTER TABLE "peerlens_edges" RENAME CONSTRAINT "peerview_edges_source_uri_unique" TO "peerlens_edges_source_uri_unique";
--> statement-breakpoint
ALTER TABLE "peerlens_policies" RENAME CONSTRAINT "peerview_policies_author_did_unique" TO "peerlens_policies_author_did_unique";
--> statement-breakpoint

-- Rename indexes
ALTER INDEX "peerview_edges_from_idx" RENAME TO "peerlens_edges_from_idx";
--> statement-breakpoint
ALTER INDEX "peerview_edges_to_idx" RENAME TO "peerlens_edges_to_idx";
--> statement-breakpoint
ALTER INDEX "peerview_edges_from_to_idx" RENAME TO "peerlens_edges_from_to_idx";
--> statement-breakpoint
ALTER INDEX "peerview_edges_type_idx" RENAME TO "peerlens_edges_type_idx";
--> statement-breakpoint
ALTER INDEX "peerview_policies_author_idx" RENAME TO "peerlens_policies_author_idx";
