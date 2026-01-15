import { getAPGIndex } from "./apg-lookup.server";
import { countShopifyCatalog, forEachShopifyProduct } from "./shopify-products.server";
import { syncAPGVariant, clearLocationCache, updateProductStatus } from "./apg-sync.server";
import { createSyncStatsRun, updateSyncStatsRun, completeSyncStatsRun } from "./sync-stats.server";

/**
 * Internal function that performs the actual sync (shared by manual and automated sync)
 * Moved to server-only file to avoid React Router client bundling issues
 */
export async function performSync(admin, shop) {
  const syncStartTime = new Date();

  // Clear location cache at start of sync
  clearLocationCache();
  
  console.log("📥 Loading APG data from CSV...");
  const apgIndex = await getAPGIndex();
  console.log(`✅ APG index loaded: ${apgIndex.size} items`);
  
  console.log("📦 Counting Shopify products/variants for sync...");
  const { totalProducts, totalVariants } = await countShopifyCatalog(admin);
  console.log(`✅ Catalog count: ${totalProducts} products (${totalVariants} variants)`);

  let synced = 0;
  let skipped = 0;
  const errors = [];
  
  // Track MAP pricing statistics
  const mapStats = {
    mapMatched: 0,
    mapUsedJobber: 0,
    mapUsedRetail: 0,
    mapSkipped: 0,
    mapSkippedReasons: []
  };

  let processedVariants = 0;
  const progressInterval = Math.max(1, Math.floor(totalVariants / 20)); // Log every 5%

  // Create a running stats record so UI can show progress
  let syncStatsId = null;
  if (shop) {
    const run = await createSyncStatsRun({
      shop,
      totalProducts,
      totalVariants,
    });
    syncStatsId = run?.id || null;
  }

  // Track which products we've already updated status for (to avoid duplicate updates)
  const productsStatusUpdated = new Set(); // Track products set to ACTIVE
  const productsSetToDraft = new Set(); // Track products set to DRAFT

  console.log(`🚀 Starting sync for ${shopifyProducts.length} products (${totalVariants} variants)...`);

  // Stream products one-by-one to avoid holding entire catalog in memory
  await forEachShopifyProduct(admin, async (product) => {
    let productHasMatch = false; // Track if ANY variant in this product matches APG
    
    for (const variant of product.variants.nodes) {
      processedVariants++;
      
      // Log progress much less frequently to reduce Railway rate limits (every 20% instead of 10%)
      const progressInterval20 = Math.max(1, Math.floor(totalVariants / 5));
      if (processedVariants % progressInterval20 === 0 || processedVariants === totalVariants) {
        const progress = ((processedVariants / totalVariants) * 100).toFixed(1);
        console.log(`📊 Progress: ${processedVariants}/${totalVariants} (${progress}%) - Synced: ${synced}, Skipped: ${skipped}`);

        // Update DB progress for UI if we have a stats record
        if (syncStatsId) {
          await updateSyncStatsRun(syncStatsId, {
            synced,
            skipped,
            errors: errors.length,
            mapStats,
          });
        }
      }
      if (!variant.barcode) {
        skipped++;
        continue;
      }

      // Try multiple barcode formats for matching
      const barcodeStr = String(variant.barcode).trim();
      const normalizedBarcode = barcodeStr.replace(/^0+/, ""); // Remove leading zeros
      const padded12 = normalizedBarcode.padStart(12, "0");
      const padded13 = normalizedBarcode.padStart(13, "0");
      const padded14 = normalizedBarcode.padStart(14, "0");
      
      let apgItem = null;
      
      // Try multiple formats
      const lookupKeys = [
        barcodeStr,              // Original format: "00012748802600"
        normalizedBarcode,       // Without leading zeros: "12748802600"
        padded12,                // 12-digit
        padded13,                // 13-digit
        padded14                 // 14-digit
      ];
      
      for (const key of lookupKeys) {
        apgItem = apgIndex.get(key);
        if (apgItem) break;
      }
      
      // Try SKU as fallback (before UPC variations)
      if (!apgItem && variant.sku) {
        apgItem = apgIndex.get(String(variant.sku).trim());
      }

      // Try matching by UPC variations if SKU/barcode didn't match
      if (!apgItem && variant.barcode) {
        // More aggressive UPC matching - try removing ALL leading zeros, try with different lengths
        const barcodeClean = String(variant.barcode).replace(/^0+/g, "");
        const variations = [
          barcodeClean,
          barcodeClean.padStart(11, "0"),
          barcodeClean.padStart(12, "0"),
          barcodeClean.padStart(13, "0"),
          barcodeClean.padStart(14, "0"),
        ];
        for (const variation of variations) {
          apgItem = apgIndex.get(variation);
          if (apgItem) break;
        }
      }
      
      // Try matching by SKU format variations (e.g., BCSQ-100971 vs WRN100971)
      if (!apgItem && variant.sku) {
        const skuStr = String(variant.sku).trim();
        // Try SKU without prefix (e.g., "BCSQ-100971" -> "100971")
        const skuParts = skuStr.split("-");
        if (skuParts.length > 1) {
          const skuNumber = skuParts[skuParts.length - 1];
          // Try to match by part number in CSV (Premier Part Number often matches SKU number)
          for (const [key, item] of apgIndex.entries()) {
            const partNum = item["Premier Part Number"] || "";
            if (partNum && partNum.includes(skuNumber)) {
              apgItem = item;
              break;
            }
          }
        }
        // Also try full SKU match (already tried above, but keep for safety)
        if (!apgItem) {
          apgItem = apgIndex.get(skuStr);
        }
      }

      if (!apgItem) {
        skipped++;
        // Only log missing matches much less frequently to reduce Railway rate limits
        if (skipped % 5000 === 0) {
          console.log(`⏭ ${skipped} products skipped (no APG match so far)`);
        }
        continue; // This variant doesn't match, but product might have other matching variants
      }
      
      // This variant matches APG - mark product as having a match
      productHasMatch = true;
    
      // Sync the variant - use static import to preserve admin context
      try {
        await syncAPGVariant({
          admin,
          productId: product.id,
          variant: variant,
          apgRow: apgItem,
        }, mapStats);
        synced++;
      } catch (error) {
        errors.push({
          product: product.title,
          variant: variant.sku || variant.barcode,
          error: error.message
        });
        // Only log critical errors, not every sync error (reduces log spam)
        if (errors.length <= 10 || errors.length % 100 === 0) {
          console.error(`❌ Sync error for ${variant.sku || variant.barcode}: ${error.message}`);
        }
      }
    }
    // After processing all variants, set product status based on whether ANY variant matched
    // Products with ANY matching variant → ACTIVE
    // Products with NO matching variants → DRAFT
    const hasAnyMatch = productHasMatch;
    
    // Update product status: ACTIVE if matched, DRAFT if unmatched
    if (!productsStatusUpdated.has(product.id) && !productsSetToDraft.has(product.id)) {
      try {
        await updateProductStatus(admin, product.id, product.status, hasAnyMatch);
        if (hasAnyMatch) {
          productsStatusUpdated.add(product.id);
        } else {
          productsSetToDraft.add(product.id);
        }
      } catch (error) {
        // Silent fail - status update is optional
      }
    }
  });

  const totalProcessed = synced + skipped;
  const successRate = totalProcessed > 0 ? ((synced / totalProcessed) * 100).toFixed(1) : 0;
  
  // Reduced logging to prevent Railway rate limits - single line summary
  console.log(`✅ SYNC COMPLETE: ${synced}/${totalProcessed} synced (${successRate}%), ${skipped} skipped, ${errors.length} errors | MAP:${mapStats.mapMatched} Jobber:${mapStats.mapUsedJobber} Retail:${mapStats.mapUsedRetail} Skipped:${mapStats.mapSkipped}`);

  // Save final stats to database / mark run completed
  if (shop && syncStatsId) {
    await completeSyncStatsRun(syncStatsId, {
      synced,
      skipped,
      errors: errors.length,
      successRate: `${successRate}%`,
      mapStats,
      status: "completed",
      errorMessage: null,
    });
  }

  return {
    success: true,
    synced,
    skipped,
    total: totalProcessed,
    successRate: `${successRate}%`,
    mapStats: {
      mapMatched: mapStats.mapMatched,
      mapUsedJobber: mapStats.mapUsedJobber,
      mapUsedRetail: mapStats.mapUsedRetail,
      mapSkipped: mapStats.mapSkipped,
      mapSkippedReasons: mapStats.mapSkippedReasons.slice(0, 20) // Limit to 20 for response size
    },
    errors: errors.length > 0 ? errors.slice(0, 50) : undefined, // Limit errors to prevent large responses
    message: `✅ Sync complete! ${synced} products updated (MAP: ${mapStats.mapMatched}, Jobber: ${mapStats.mapUsedJobber}), ${skipped} skipped, ${errors.length} errors`,
  };
}
