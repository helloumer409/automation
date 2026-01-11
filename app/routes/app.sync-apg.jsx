import { authenticate } from "../shopify.server";
import { getAPGIndex } from "../services/apg-lookup.server";
import { getShopifyProducts } from "../services/shopify-products.server";
import { clearLocationCache } from "../services/apg-sync.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    // Clear location cache at start of sync
    clearLocationCache();
    
    const apgIndex = await getAPGIndex();
    const shopifyProducts = await getShopifyProducts(admin);

    let synced = 0;
    let skipped = 0;
    const errors = [];

    for (const product of shopifyProducts) {
      for (const variant of product.variants.nodes) {
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

        if (!apgItem) {
          skipped++;
          console.log(`⏭ No APG match for barcode: "${variant.barcode}" SKU: "${variant.sku}"`);
          continue;
        }
        
        console.log(`✓ Found APG match for ${variant.sku || variant.barcode}`);

        // Import sync function dynamically to avoid circular dependencies if any
        const { syncAPGVariant } = await import("../services/apg-sync.server");
        
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
          console.error("❌ Sync error:", error);
        }
      }
    }

    console.log(`\n📊 Sync Summary: ${synced} synced, ${skipped} skipped${errors.length > 0 ? `, ${errors.length} errors` : ""}`);

    return {
      success: true,
      synced,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      message: `Synced ${synced} products, skipped ${skipped}${errors.length > 0 ? `, ${errors.length} errors` : ""}`,
    };
  } catch (error) {
    console.error("❌ Sync failed:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}
