export const RUN_CONTRACT_VERSION = "nisenprints_v1";

export type NisenPrintsContractMode = "nisenprints_etsy_sync" | "nisenprints_printify_recovery" | "nisenprints_full_publish_run";

export type RunContract = {
  workflow: "NisenPrints";
  mode: NisenPrintsContractMode;
  beginnerLabel: string;
  beginnerDescription: string;
  sourceOfTruth: string[];
  allowedScope: string[];
  forbiddenActions: string[];
  requiredProofs: string[];
  visibleSteps: string[];
};

export const nisenPrintsRunContracts: Record<NisenPrintsContractMode, RunContract> = {
  nisenprints_etsy_sync: {
    workflow: "NisenPrints",
    mode: "nisenprints_etsy_sync",
    beginnerLabel: "Etsy同期",
    beginnerDescription: "Etsyの現在公開リストを正本にして、ローカルのqueue/listingsを揃えます。",
    sourceOfTruth: ["etsy_current_listings", "pinterest_queue.tsv", "listings.json", "nisenprints_shop_snapshot.json"],
    allowedScope: ["full_sync_pruning", "current_source_wins", "remove_stale_local_rows", "no_new_listing"],
    forbiddenActions: ["incremental_append", "printify_product_creation", "etsy_listing_publish", "pinterest_pin_publish"],
    requiredProofs: ["etsy_current_listings_snapshot", "local_queue_synced", "stale_rows_pruned"],
    visibleSteps: ["Etsyの現在公開リストを読む", "ローカルqueueを同期する", "古い行が消えたことを確認する"]
  },
  nisenprints_printify_recovery: {
    workflow: "NisenPrints",
    mode: "nisenprints_printify_recovery",
    beginnerLabel: "Printify復旧",
    beginnerDescription: "途中の同じ商品を再開し、重複商品を作らずに復旧します。",
    sourceOfTruth: ["STATE.md", "latest_generation_manifest", "latest_publish_manifest", "Printify same product id"],
    allowedScope: ["same_product_id_required", "resume_unfinished_stage", "hydrate_current_manifests", "no_duplicate_listing"],
    forbiddenActions: ["new_product_creation", "new_topic_selection", "completed_product_repost", "full_sync_pruning"],
    requiredProofs: ["same_product_id_verified", "resume_stage_verified", "printify_status_checked"],
    visibleSteps: ["同じ商品を見つける", "未完了の段階から再開する", "Printifyの状態を確認する"]
  },
  nisenprints_full_publish_run: {
    workflow: "NisenPrints",
    mode: "nisenprints_full_publish_run",
    beginnerLabel: "新規公開",
    beginnerDescription: "新規商品を作成し、Etsy公開からPinterest検証まで最後まで進めます。",
    sourceOfTruth: ["daily_product_creation_flow.md", "generation_manifest.json", "publish_manifest.json", "Pinterest strict pin URL"],
    allowedScope: ["new_product_creation", "incremental_append", "etsy_listing_publish", "pinterest_pin_publish"],
    forbiddenActions: ["full_sync_pruning", "reuse_completed_product", "skip_pinterest_link_verification", "silent_partial_completion"],
    requiredProofs: ["generation_manifest_verified", "etsy_listing_published", "pinterest_pin_url_verified", "etsy_visit_site_match_verified"],
    visibleSteps: ["商品素材を作る", "Etsyリストを公開する", "Pinterestリンクを確認する"]
  }
};

const nisenPrintsIntent = /nisenprints|nisen prints/i;
const codeMaintenanceIntent = /contract routing|workerengine|runcontracts|コード|実装|修正|設計|docs?|ドキュメント|テスト|test/i;

export function resolveRunContract(command: string): RunContract | undefined {
  if (!nisenPrintsIntent.test(command)) return undefined;
  if (codeMaintenanceIntent.test(command)) return undefined;

  if (/etsy sync|同期|正本|current listings|stale row|stale rows|prune|remove stale|queue|listings|pinterest_queue\.tsv/i.test(command)) {
    return nisenPrintsRunContracts.nisenprints_etsy_sync;
  }
  if (/printify|復旧|recovery|途中/i.test(command)) {
    return nisenPrintsRunContracts.nisenprints_printify_recovery;
  }
  if (/full publish|最後まで|新規|公開/i.test(command)) {
    return nisenPrintsRunContracts.nisenprints_full_publish_run;
  }
  return nisenPrintsRunContracts.nisenprints_printify_recovery;
}
