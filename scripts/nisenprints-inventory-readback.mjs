import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const NISEN_INVENTORY_WORKFLOW = "nisenprints-existing-product-audit";
const COMPANY = "company_2560580981cedfd106b66245";
const SHOP = "21066723";
const SOURCE = "2026-06-25-224048-3da7-fuji-firefly-river-onsen-gray-tabby-cat.json";
const PRODUCT = "6a4a09f08295538b61036f1b";
const LISTING = "4532823269";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function credential() {
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", "nisenprints.printify.api_token", "-a", "nichikatanaka", "-w"],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { throw new Error("printify_auth_required"); }
}

async function readProvider(route, token) {
  const response = await fetch(`https://api.printify.com/v1${route}`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? "printify_auth_required" : `printify_read_http_${response.status}`);
  return response.json();
}

/** A separate existing-product audit, never a publishing/resume decision. */
export async function runNisenInventory({ runId, companyId, projectRoot = "/Users/nichikatanaka/Documents/Etsy", readCredential = credential, requestJson = readProvider }) {
  const base = { workflow_id: NISEN_INVENTORY_WORKFLOW, run_id: runId, external_action_executed: false,
    new_generation_completed: false, new_publication_completed: false, full_publish_workflow_completed: false };
  try {
    if (companyId !== COMPANY) throw new Error("nisen_inventory_company_not_allowed");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(runId || "")) throw new Error("nisen_inventory_run_id_invalid");
    const sourcePath = path.join(projectRoot, "artifacts", "publish_manifests", SOURCE);
    const sourceBytes = readFileSync(sourcePath);
    const source = JSON.parse(sourceBytes.toString("utf8"));
    const sourceHash = hash(sourceBytes);
    const productId = String(source.printify_product_id ?? source.automation_health?.printify_product_id ?? "");
    const listingId = String(source.etsy_listing_id ?? source.automation_health?.etsy_listing_id ?? "");
    if (productId !== PRODUCT || listingId !== LISTING || source.final_status !== "pinterest_posted" || source.resume_stage !== "completed") {
      throw new Error("nisen_inventory_source_target_changed");
    }
    const targetDir = path.join(projectRoot, "artifacts", "inventory-readbacks");
    const targetFile = path.join(targetDir, `${runId}.json`);
    if (existsSync(targetFile)) {
      const previous = JSON.parse(readFileSync(targetFile, "utf8"));
      if (previous.run_id !== runId || previous.company_id !== companyId || previous.source_sha256 !== sourceHash
        || previous.shop_id !== SHOP || previous.product?.id !== PRODUCT || previous.product?.etsy_listing_id !== LISTING
        || previous.status !== "complete" || previous.external_action_executed !== false) throw new Error("nisen_inventory_receipt_conflict");
      return { ...previous, artifact_path: targetFile, artifact_sha256: hash(readFileSync(targetFile)), same_run_source_sync: true, readback_verified: true, cleanup_verified: true };
    }
    const token = readCredential();
    if (!token) throw new Error("printify_auth_required");
    const shops = await requestJson("/shops.json", token);
    const shop = Array.isArray(shops) ? shops.find((item) => String(item.id) === SHOP) : null;
    if (!shop || shop.sales_channel !== "etsy") throw new Error("nisen_inventory_shop_mismatch");
    const productRoute = `/shops/${SHOP}/products/${PRODUCT}.json`;
    const product = await requestJson(productRoute, token);
    let listingUrl;
    try { listingUrl = new URL(product.external?.handle); } catch { throw new Error("nisen_inventory_listing_mismatch"); }
    if (product.id !== PRODUCT || String(product.external?.id) !== LISTING || listingUrl.protocol !== "https:"
      || !["etsy.com", "www.etsy.com"].includes(listingUrl.hostname) || !listingUrl.pathname.startsWith(`/listing/${LISTING}/`)) {
      throw new Error("nisen_inventory_listing_mismatch");
    }
    if (product.visible !== true) throw new Error("nisen_inventory_product_not_visible");
    if (hash(readFileSync(sourcePath)) !== sourceHash) throw new Error("nisen_inventory_source_changed_during_read");
    const record = { schema: "aos.nisenprints_existing_product_audit.v1", ...base, status: "complete", exact_blocker: null,
      company_id: companyId, checked_at: new Date().toISOString(), source_path: sourcePath, source_sha256: sourceHash,
      historical_publish_status: source.final_status, shop_id: SHOP,
      product: { id: PRODUCT, title: String(product.title || ""), visible: true, is_locked: product.is_locked === true,
        updated_at: product.updated_at ?? null, etsy_listing_id: LISTING, etsy_listing_url: listingUrl.href,
        etsy_visibility_evidence: "printify_sales_channel_metadata_only" },
      provider_receipts: [{ method: "GET", route: "/shops.json", status: 200 }, { method: "GET", route: productRoute, status: 200 }],
      source_sync_scope: "run_owned_local_inventory_snapshot", source_manifest_modified: false,
      browser_used: false, same_run_receipt: true };
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    writeFileSync(targetFile, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (readFileSync(targetFile, "utf8") !== bytes) throw new Error("nisen_inventory_source_sync_mismatch");
    return { ...record, artifact_path: targetFile, artifact_sha256: hash(bytes), same_run_source_sync: true, readback_verified: true, cleanup_verified: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const blocker = /^(?:nisen_inventory_[a-z_]+|printify_auth_required|printify_read_http_\d{3})$/u.test(message)
      ? message : "nisen_inventory_read_failed";
    return { ...base, status: "blocked", exact_blocker: blocker, same_run_source_sync: false, readback_verified: false, cleanup_verified: true };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runNisenInventory({ runId: process.argv[2], companyId: process.argv[3] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "complete" ? 0 : 1;
}
