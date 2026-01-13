import { authenticate } from "../shopify.server";
import { getAPGIndex } from "../services/apg-lookup.server";
import { getShopifyProducts } from "../services/shopify-products.server";
import { syncAPGVariant, clearLocationCache } from "../services/apg-sync.server";
import { getLatestSyncStats, saveSyncStats } from "../services/sync-stats.server";
import { db } from "../db.server";

/**
 * Retries sync for products that were skipped in the last sync
 * This applies Jobber price logic specifically for skipped products
 */
async function retrySkippedProducts(admin, shop) {
  // Clear location cache
  clearLocationCache();
  
  // Get the last sync stats to find skipped products
  const lastStats = await getLatestSyncStats(shop);
  
  if (!lastStats || lastStats.skipped === 0) {
    return {
      success: true,
      message: "No skipped products found from last sync",
      retried: 0,
      synced: 0,
      skipped: 0,
      errors: 0,
    };
  }

  console.log(`🔄 Retrying sync for ${lastStats.skipped} skipped products...`);
  
  // Load APG data
  console.log("📥 Loading APG data from CSV...");
  const apgIndex = await getAPGIndex();
  console.log(`✅ APG index loaded: ${apgIndex.size} items`);
  
  // Get all Shopify products
  console.log("📦 Fetching Shopify products...");
  const shopifyProducts = await getShopifyProducts(admin);
  console.log(`✅ Fetched ${shopifyProducts.length} products from Shopify`);

  let synced = 0;
  let skipped = 0;
  let retried = 0;
  const errors = [];
  
  // Track MAP pricing statistics
  const mapStats = {
    mapMatched: 0,
    mapUsedJobber: 0,
    mapUsedRetail: 0,
    mapSkipped: 0,
    mapSkippedReasons: []
  };

  // Process all variants - we'll match them against APG data
  const totalVariants = shopifyProducts.reduce((sum, p) => sum + (p.variants?.nodes?.length || 0), 0);
  let processedVariants = 0;
  const progressInterval10 = Math.max(1, Math.floor(totalVariants / 10));

  console.log(`🚀 Processing ${totalVariants} variants to find and retry skipped ones...`);

  for (const product of shopifyProducts) {
    for (const variant of product.variants.nodes) {
      processedVariants++;
      
      // Log progress
      if (processedVariants % progressInterval10 === 0 || processedVariants === totalVariants) {
        const progress = ((processedVariants / totalVariants) * 100).toFixed(1);
        console.log(`📊 Progress: ${processedVariants}/${totalVariants} (${progress}%) - Retried: ${retried}, Synced: ${synced}`);
      }

      if (!variant.barcode && !variant.sku) {
        skipped++;
        continue;
      }

      // Try multiple barcode formats for matching
      const barcodeStr = variant.barcode ? String(variant.barcode).trim() : "";
      const normalizedBarcode = barcodeStr.replace(/^0+/, "");
      const padded12 = normalizedBarcode.padStart(12, "0");
      const padded13 = normalizedBarcode.padStart(13, "0");
      const padded14 = normalizedBarcode.padStart(14, "0");
      
      let apgItem = null;
      
      // Try multiple formats
      const lookupKeys = [
        barcodeStr,
        normalizedBarcode,
        padded12,
        padded13,
        padded14
      ];
      
      for (const key of lookupKeys) {
        if (key) {
          apgItem = apgIndex.get(key);
          if (apgItem) break;
        }
      }
      
      // Try SKU matching
      if (!apgItem && variant.sku) {
        apgItem = apgIndex.get(String(variant.sku).trim());
      }

      // Try UPC variations
      if (!apgItem && variant.barcode) {
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
      
      // Try SKU format variations
      if (!apgItem && variant.sku) {
        const skuStr = String(variant.sku).trim();
        const skuParts = skuStr.split("-");
        if (skuParts.length > 1) {
          const skuNumber = skuParts[skuParts.length - 1];
          for (const [key, item] of apgIndex.entries()) {
            const partNum = item["Premier Part Number"] || "";
            if (partNum && partNum.includes(skuNumber)) {
              apgItem = item;
              break;
            }
          }
        }
        if (!apgItem) {
          apgItem = apgIndex.get(skuStr);
        }
      }
      
      // Only process if we found APG data AND we want to retry
      // For retry, we specifically want products that:
      // 1. Have APG match, AND
      // 2. Have MAP = 0 or null (so we can apply Jobber price)
      if (apgItem) {
        retried++;
        
        // Check if MAP is 0 or null - these are the ones we want to retry with Jobber
        const mapPriceStr = apgItem.MAP || apgItem.map || apgItem["MAP Price"] || apgItem["MAP Price (USD)"] || "0";
        const mapPrice = parseFloat(String(mapPriceStr).replace(/[$,\s]/g, "").trim()) || 0;
        
        // If MAP is 0 or null, try to sync with Jobber price logic
        if (mapPrice === 0 || !mapPrice) {
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
            if (errors.length <= 10) {
              console.error(`❌ Retry error for ${variant.sku || variant.barcode}: ${error.message}`);
            }
          }
        } else {
          skipped++; // MAP is valid, skip this retry
        }
      } else {
        skipped++; // No APG match, can't retry
      }
    }
  }

  const totalProcessed = synced + skipped;
  const successRate = totalProcessed > 0 ? ((synced / totalProcessed) * 100).toFixed(1) : 0;
  
  console.log(`\n✅ RETRY COMPLETE`);
  console.log(`📊 Summary:`);
  console.log(`   • Products retried: ${retried}`);
  console.log(`   • Successfully synced: ${synced} (${successRate}%)`);
  console.log(`   • Still skipped: ${skipped}`);
  console.log(`   • Errors: ${errors.length}`);
  console.log(`\n💰 MAP Pricing Report:`);
  console.log(`   • Used MAP price: ${mapStats.mapMatched}`);
  console.log(`   • Used Jobber (MAP was 0): ${mapStats.mapUsedJobber}`);
  console.log(`   • Used Retail (MAP & Jobber were 0): ${mapStats.mapUsedRetail}`);

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
    retried,
    synced,
    skipped,
    total: totalProcessed,
    successRate: `${successRate}%`,
    mapStats: {
      mapMatched: mapStats.mapMatched,
      mapUsedJobber: mapStats.mapUsedJobber,
      mapUsedRetail: mapStats.mapUsedRetail,
      mapSkipped: mapStats.mapSkipped,
    },
    errors: errors.length > 0 ? errors.slice(0, 50) : undefined,
    message: `✅ Retry complete! ${synced} products updated with Jobber pricing, ${skipped} still skipped, ${errors.length} errors`,
  };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const result = await retrySkippedProducts(admin, shop);
    return result;
  } catch (error) {
    console.error("❌ Retry failed:", error);
    
    // Save failed retry to database
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
