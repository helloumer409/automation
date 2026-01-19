import { getAPGIndex, wasCSVJustDownloaded, getLastCSVDownloadTime } from "./apg-lookup.server";
import { countShopifyCatalog, forEachShopifyProduct } from "./shopify-products.server";
import { syncAPGVariant, clearLocationCache, updateProductStatus } from "./apg-sync.server";
import { createSyncStatsRun, updateSyncStatsRun, completeSyncStatsRun, getLatestSyncStats } from "./sync-stats.server";

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
  const csvWasDownloaded = wasCSVJustDownloaded();
  const csvDownloadTime = getLastCSVDownloadTime();
  console.log(`✅ APG index loaded: ${apgIndex.size} items`);
  
  // Determine if this should be a full sync or incremental sync
  // Full sync if: CSV was just downloaded (24h+ old), or this is the first sync
  // Incremental sync if: CSV is fresh (<24h old) - only sync new/unsynced products
  const lastSyncStats = shop ? await getLatestSyncStats(shop) : null;
  const isFullSync = csvWasDownloaded || !lastSyncStats || lastSyncStats.status !== "completed";
  
  if (isFullSync) {
    console.log("🔄 FULL SYNC: CSV was just downloaded or first sync - syncing all products");
  } else {
    console.log("🔄 INCREMENTAL SYNC: CSV is fresh - only syncing new/unsynced products");
  }
  
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
  let lastDbUpdateVariants = 0;
  const progressInterval = Math.max(1, Math.floor(totalVariants / 20)); // Log every 5%

  // Create a running stats record so UI can show progress
  let syncStatsId = null;
  if (shop) {
    const run = await createSyncStatsRun({
      shop,
      totalProducts,
      totalVariants,
      csvDownloadedAt: csvWasDownloaded ? new Date(csvDownloadTime) : null,
      isFullSync,
    });
    syncStatsId = run?.id || null;
  }

  // Track which products we've already updated status for (to avoid duplicate updates)
  const productsStatusUpdated = new Set(); // Track products set to ACTIVE
  const productsSetToDraft = new Set(); // Track products set to DRAFT

  console.log(`🚀 Starting sync for ${totalProducts} products (${totalVariants} variants)...`);
  
  // Helper function to update progress in DB (with throttling)
  const updateProgress = async (force = false) => {
    if (!syncStatsId) return;
    
    // Update DB more frequently at the beginning (every 100 variants for first 1000), then less frequently
    const variantsSinceLastUpdate = processedVariants - lastDbUpdateVariants;
    const shouldUpdate = force || 
      (processedVariants <= 1000 && variantsSinceLastUpdate >= 100) || // First 1000: every 100 variants
      (processedVariants <= 10000 && variantsSinceLastUpdate >= 500) || // Next 9000: every 500 variants
      (variantsSinceLastUpdate >= 1000); // After 10000: every 1000 variants
    
    if (shouldUpdate) {
      try {
        await updateSyncStatsRun(syncStatsId, {
          synced,
          skipped,
          errors: errors.length,
          mapStats,
        });
        lastDbUpdateVariants = processedVariants;
      } catch (err) {
        console.error("Failed to update sync progress:", err.message);
      }
    }
  };

  // Stream products one-by-one to avoid holding entire catalog in memory
  await forEachShopifyProduct(admin, async (product) => {
    let productHasMatch = false; // Track if ANY variant in this product matches APG
    
    for (const variant of product.variants.nodes) {
      processedVariants++;
      
      // Log progress less frequently to reduce console spam (every 20%)
      const progressInterval20 = Math.max(1, Math.floor(totalVariants / 5));
      if (processedVariants % progressInterval20 === 0 || processedVariants === totalVariants) {
        const progress = ((processedVariants / totalVariants) * 100).toFixed(1);
        console.log(`📊 Progress: ${processedVariants}/${totalVariants} (${progress}%) - Synced: ${synced}, Skipped: ${skipped}`);
      }
      // In incremental sync mode, only sync variants that don't have barcode/SKU (new products)
      // OR variants that might have been skipped in the last sync
      // We skip variants that already have barcode/SKU and were successfully synced
      if (!isFullSync && variant.barcode && variant.sku) {
        // In incremental mode, skip variants that have both barcode and SKU
        // These were likely synced in previous full sync
        // We'll only sync new products (no barcode/SKU) or check if they match APG
        // But we still need to check if they match APG to catch newly added APG items
        // So we'll continue processing but mark as "already synced" if they match
      }
      
      if (!variant.barcode && !variant.sku) {
        // No barcode or SKU - skip (can't match)
        skipped++;
        await updateProgress(); // Update progress after skip
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
      
      // Try matching by SKU format variations (e.g., BHXS-ZT2-XTG6 vs ACTZT2-XTG6)
      if (!apgItem && variant.sku) {
        const skuStr = String(variant.sku).trim();
        const skuParts = skuStr.split(/[-_\s]/); // Split on dash, underscore, or space
        
        // Strategy 1: Try full SKU match first (case-insensitive)
        apgItem = apgIndex.get(skuStr) || apgIndex.get(skuStr.toUpperCase());
        
        // Helper function to normalize strings for matching (remove dashes/underscores for comparison)
        const normalizeForMatch = (str) => str.replace(/[-_\s]/g, "").toUpperCase();
        
        // Strategy 2: Try matching by part number substring (more aggressive)
        // Example: SKU "BHXS-ZT2-XTG6" should match "ACTZT2-XTG6" or "ACT-ZT2-XTG6"
        if (!apgItem) {
          // Try matching the last part(s) of SKU against Premier Part Number
          // For "BHXS-ZT2-XTG6", try "ZT2-XTG6", then "XTG6"
          for (let i = skuParts.length - 1; i >= 0 && i >= skuParts.length - 3; i--) {
            const partialSku = skuParts.slice(i).join("-");
            const partialUpper = partialSku.toUpperCase();
            const partialNormalized = normalizeForMatch(partialSku);
            
            // Try direct match in index (already indexed uppercase)
            apgItem = apgIndex.get(partialUpper);
            if (apgItem) break;
            
            // Try substring matching against part numbers (with and without dashes)
            // This handles cases like "ZT2-XTG6" matching "ACTZT2-XTG6"
            for (const [key, item] of apgIndex.entries()) {
              const partNum = String(item["Premier Part Number"] || "").trim().toUpperCase();
              const mfgPartNum = String(item["Mfg Part Number"] || "").trim().toUpperCase();
              
              // Check if part number contains the SKU fragment (with dash variations)
              const partNumNormalized = normalizeForMatch(partNum);
              const mfgPartNumNormalized = normalizeForMatch(mfgPartNum);
              
              // Match if: part number contains SKU fragment (with or without dashes)
              if (partNum && (
                  partNum.includes(partialUpper) || 
                  partialUpper.includes(partNum) ||
                  partNumNormalized.includes(partialNormalized) ||
                  partialNormalized.includes(partNumNormalized) ||
                  // Check if part number ends with the SKU fragment (handles "ACTZT2-XTG6" ending with "ZT2-XTG6")
                  partNum.endsWith(partialUpper) ||
                  partNumNormalized.endsWith(partialNormalized)
              )) {
                apgItem = item;
                break;
              }
              
              // Same check for Mfg Part Number
              if (mfgPartNum && (
                  mfgPartNum.includes(partialUpper) || 
                  partialUpper.includes(mfgPartNum) ||
                  mfgPartNumNormalized.includes(partialNormalized) ||
                  partialNormalized.includes(mfgPartNumNormalized) ||
                  mfgPartNum.endsWith(partialUpper) ||
                  mfgPartNumNormalized.endsWith(partialNormalized)
              )) {
                apgItem = item;
                break;
              }
            }
            if (apgItem) break;
          }
        }
        
        // Strategy 3: Try matching by extracting suffix (skip first prefix)
        // For "BHXS-ZT2-XTG6", extract "ZT2-XTG6" and try to match
        if (!apgItem && skuParts.length > 1) {
          const suffixParts = skuParts.slice(1); // Skip first prefix (e.g., "BHXS")
          const suffix = suffixParts.join("-");
          const suffixUpper = suffix.toUpperCase();
          const suffixNormalized = normalizeForMatch(suffix);
          
          // Try direct match
          apgItem = apgIndex.get(suffixUpper);
          if (!apgItem) {
            // Try substring matching with normalized comparison
            for (const [key, item] of apgIndex.entries()) {
              const partNum = String(item["Premier Part Number"] || "").trim().toUpperCase();
              const mfgPartNum = String(item["Mfg Part Number"] || "").trim().toUpperCase();
              const partNumNormalized = normalizeForMatch(partNum);
              const mfgPartNumNormalized = normalizeForMatch(mfgPartNum);
              
              if (partNum && (
                  partNum.includes(suffixUpper) || 
                  suffixUpper.includes(partNum) ||
                  partNumNormalized.includes(suffixNormalized) ||
                  suffixNormalized.includes(partNumNormalized) ||
                  partNum.endsWith(suffixUpper) ||
                  partNumNormalized.endsWith(suffixNormalized)
              )) {
                apgItem = item;
                break;
              }
              
              if (mfgPartNum && (
                  mfgPartNum.includes(suffixUpper) || 
                  suffixUpper.includes(mfgPartNum) ||
                  mfgPartNumNormalized.includes(suffixNormalized) ||
                  suffixNormalized.includes(mfgPartNumNormalized) ||
                  mfgPartNum.endsWith(suffixUpper) ||
                  mfgPartNumNormalized.endsWith(suffixNormalized)
              )) {
                apgItem = item;
                break;
              }
            }
          }
        }
        
        // Strategy 4: Try removing common prefixes from both SKU and part number
        // Common prefixes: BHXS, ACT, etc.
        if (!apgItem && skuParts.length > 1) {
          // Remove first part and try matching remaining parts
          const withoutPrefix = skuParts.slice(1).join("");
          const withoutPrefixUpper = withoutPrefix.toUpperCase();
          
          for (const [key, item] of apgIndex.entries()) {
            const partNum = String(item["Premier Part Number"] || "").trim().toUpperCase();
            const mfgPartNum = String(item["Mfg Part Number"] || "").trim().toUpperCase();
            
            // Try to find if part number contains the suffix without prefix
            // e.g., "ACTZT2-XTG6" should match "ZT2XTG6" (from "BHXS-ZT2-XTG6")
            const partNumNoDashes = normalizeForMatch(partNum);
            const mfgPartNumNoDashes = normalizeForMatch(mfgPartNum);
            
            if ((partNumNoDashes.includes(withoutPrefixUpper) || withoutPrefixUpper.includes(partNumNoDashes)) ||
                (mfgPartNumNoDashes.includes(withoutPrefixUpper) || withoutPrefixUpper.includes(mfgPartNumNoDashes))) {
              apgItem = item;
              break;
            }
          }
        }
      }

      if (!apgItem) {
        skipped++;
        await updateProgress(); // Update progress after skip
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
        await updateProgress(); // Update progress after sync
      } catch (error) {
        const errorMsg = error.message || String(error);
        const isTokenError = errorMsg.includes("access token") || 
                            errorMsg.includes("expired") || 
                            errorMsg.includes("invalid") ||
                            errorMsg.includes("Missing access token");
        
        errors.push({
          product: product.title,
          variant: variant.sku || variant.barcode,
          error: errorMsg,
          isTokenError // Flag token expiration errors
        });
        
        // Log token errors more prominently, other errors less frequently
        if (isTokenError) {
          // Log first few token errors, then every 50th
          if (errors.filter(e => e.isTokenError).length <= 5 || errors.filter(e => e.isTokenError).length % 50 === 0) {
            console.error(`⚠️ Token expiration error for ${variant.sku || variant.barcode} - sync will continue but this variant failed`);
          }
        } else {
          // Only log critical errors, not every sync error (reduces log spam)
          if (errors.length <= 10 || errors.length % 100 === 0) {
            console.error(`❌ Sync error for ${variant.sku || variant.barcode}: ${errorMsg}`);
          }
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
  
  // Count token expiration errors separately
  const tokenErrors = errors.filter(e => e.isTokenError).length;
  
  // Reduced logging to prevent Railway rate limits - single line summary
  let summaryMsg = `✅ SYNC COMPLETE: ${synced}/${totalProcessed} synced (${successRate}%), ${skipped} skipped, ${errors.length} errors`;
  if (tokenErrors > 0) {
    summaryMsg += ` (${tokenErrors} token expiration errors - run sync again to retry)`;
  }
  summaryMsg += ` | MAP:${mapStats.mapMatched} Jobber:${mapStats.mapUsedJobber} Retail:${mapStats.mapUsedRetail} Skipped:${mapStats.mapSkipped}`;
  console.log(summaryMsg);
  
  if (tokenErrors > 0) {
    console.warn(`⚠️ WARNING: ${tokenErrors} variants failed due to access token expiration. Run sync again to retry these variants.`);
  }

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
    message: (() => {
      const tokenErrorCount = errors.filter(e => e.isTokenError).length;
      return tokenErrorCount > 0 
        ? `✅ Sync complete! ${synced} products updated (MAP: ${mapStats.mapMatched}, Jobber: ${mapStats.mapUsedJobber}), ${skipped} skipped, ${errors.length} errors (${tokenErrorCount} due to token expiration - run sync again to retry)`
        : `✅ Sync complete! ${synced} products updated (MAP: ${mapStats.mapMatched}, Jobber: ${mapStats.mapUsedJobber}), ${skipped} skipped, ${errors.length} errors`;
    })(),
  };
}
