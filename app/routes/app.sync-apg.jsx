import { authenticate } from "../shopify.server";
import { getAPGIndex } from "../services/apg-lookup.server";
import { getShopifyProducts } from "../services/shopify-products.server";
import { syncAPGVariant, clearLocationCache, updateProductStatus } from "../services/apg-sync.server";
import { saveSyncStats } from "../services/sync-stats.server";

// Internal function that performs the actual sync (shared by manual and automated sync)
async function performSync(admin, shop) {
  const syncStartTime = new Date();

    // Clear location cache at start of sync
    clearLocationCache();
    
  console.log("📥 Loading APG data from CSV...");
    const apgIndex = await getAPGIndex();
  console.log(`✅ APG index loaded: ${apgIndex.size} items`);
  
  console.log("📦 Fetching Shopify products...");
    const shopifyProducts = await getShopifyProducts(admin);
  console.log(`✅ Fetched ${shopifyProducts.length} products from Shopify`);

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

  // Calculate total variants for progress tracking
  const totalVariants = shopifyProducts.reduce((sum, p) => sum + (p.variants?.nodes?.length || 0), 0);
  let processedVariants = 0;
  const progressInterval = Math.max(1, Math.floor(totalVariants / 20)); // Log every 5%

  // Track which products we've already updated status for (to avoid duplicate updates)
  const productsStatusUpdated = new Set(); // Track products set to ACTIVE
  const productsSetToDraft = new Set(); // Track products set to DRAFT

  console.log(`🚀 Starting sync for ${shopifyProducts.length} products (${totalVariants} variants)...`);

    for (const product of shopifyProducts) {
      for (const variant of product.variants.nodes) {
      processedVariants++;
      
      // Log progress much less frequently to reduce Railway rate limits (every 20% instead of 10%)
      const progressInterval20 = Math.max(1, Math.floor(totalVariants / 5));
      if (processedVariants % progressInterval20 === 0 || processedVariants === totalVariants) {
        const progress = ((processedVariants / totalVariants) * 100).toFixed(1);
        console.log(`📊 Progress: ${processedVariants}/${totalVariants} (${progress}%) - Synced: ${synced}, Skipped: ${skipped}`);
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
        
        // Set unmatched products to DRAFT (user requirement)
        // Only update once per product (not per variant) - track which products we've already updated
        if (!productsSetToDraft.has(product.id) && product.status && product.status !== "DRAFT") {
          try {
            await updateProductStatus(admin, product.id, product.status, false); // false = set to DRAFT
            productsSetToDraft.add(product.id);
          } catch (error) {
            // Silent fail - status update is optional
          }
        }
        continue;
      }
      
      // Sync the variant - use static import to preserve admin context
        try {
          await syncAPGVariant({
            admin,
            productId: product.id,
          productStatus: product.status, // Pass status for ACTIVE update (matched products)
            variant: variant,
            apgRow: apgItem,
        }, mapStats);
          synced++;
        
        // Mark this product as matched (will be set to ACTIVE)
        // Status update happens inside syncAPGVariant, but we track it here to avoid duplicate updates
        productsStatusUpdated.add(product.id);
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
  }

  const totalProcessed = synced + skipped;
  const successRate = totalProcessed > 0 ? ((synced / totalProcessed) * 100).toFixed(1) : 0;
  
  // Reduced logging to prevent Railway rate limits - single line summary
  console.log(`✅ SYNC COMPLETE: ${synced}/${totalProcessed} synced (${successRate}%), ${skipped} skipped, ${errors.length} errors | MAP:${mapStats.mapMatched} Jobber:${mapStats.mapUsedJobber} Retail:${mapStats.mapUsedRetail} Skipped:${mapStats.mapSkipped}`);

  // Save stats to database
  if (shop) {
    await saveSyncStats({
      shop,
      totalProducts: shopifyProducts.length,
      totalVariants,
      synced,
      skipped,
      errors: errors.length,
      successRate: `${successRate}%`,
      mapStats,
      status: "completed",
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

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const result = await performSync(admin, shop);
    return result;
  } catch (error) {
    console.error("❌ Sync failed:", error);
    
    // Save failed sync to database
    if (shop) {
      await saveSyncStats({
        shop,
        totalProducts: 0,
        totalVariants: 0,
        synced: 0,
        skipped: 0,
        errors: 1,
        successRate: "0%",
        mapStats: {},
        status: "failed",
        errorMessage: error.message,
      });
    }
    
    return {
      success: false,
      error: error.message,
    };
  }
}

// Export performSync for use by automated sync endpoint
export { performSync };

// Export performSync for use by automated sync endpoint
export { performSync };
