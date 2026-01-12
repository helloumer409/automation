import { authenticate } from "../shopify.server";
import { getAPGIndex } from "../services/apg-lookup.server";
import { getShopifyProducts } from "../services/shopify-products.server";
import { syncAPGVariant, clearLocationCache } from "../services/apg-sync.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
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
    
    // Calculate total variants for progress tracking
    const totalVariants = shopifyProducts.reduce((sum, p) => sum + (p.variants?.nodes?.length || 0), 0);
    let processedVariants = 0;
    const progressInterval = Math.max(1, Math.floor(totalVariants / 20)); // Log every 5%

    console.log(`🚀 Starting sync for ${shopifyProducts.length} products (${totalVariants} variants)...`);

    for (const product of shopifyProducts) {
      for (const variant of product.variants.nodes) {
        processedVariants++;
        
        // Log progress for large syncs
        if (processedVariants % progressInterval === 0 || processedVariants === totalVariants) {
          const progress = ((processedVariants / totalVariants) * 100).toFixed(1);
          console.log(`📊 Progress: ${processedVariants}/${totalVariants} variants (${progress}%) - Synced: ${synced}, Skipped: ${skipped}`);
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
        
        // Try SKU as fallback
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
        
        if (!apgItem) {
          skipped++;
          // Only log missing matches occasionally to reduce log spam
          if (skipped % 500 === 0) {
            console.log(`⏭ ${skipped} products skipped (no APG match so far)`);
          }
          continue;
        }
        
        // Sync the variant - use static import to preserve admin context
        try {
          await syncAPGVariant({
            admin,
            productId: product.id,
            variant: variant,
            apgRow: apgItem,
          });
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
    }

    const totalProcessed = synced + skipped;
    const successRate = totalProcessed > 0 ? ((synced / totalProcessed) * 100).toFixed(1) : 0;
    
    console.log(`\n✅ SYNC COMPLETE`);
    console.log(`📊 Summary:`);
    console.log(`   • Total variants processed: ${totalProcessed}`);
    console.log(`   • Successfully synced: ${synced} (${successRate}%)`);
    console.log(`   • Skipped (no match): ${skipped}`);
    console.log(`   • Errors: ${errors.length}`);

    return {
      success: true,
      synced,
      skipped,
      total: totalProcessed,
      successRate: `${successRate}%`,
      errors: errors.length > 0 ? errors.slice(0, 50) : undefined, // Limit errors to prevent large responses
      message: `✅ Sync complete! ${synced} products updated, ${skipped} skipped, ${errors.length} errors`,
    };
  } catch (error) {
    console.error("❌ Sync failed:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}
