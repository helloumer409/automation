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

        // Normalize barcode (remove leading zeros) for lookup
        const normalizedBarcode = String(variant.barcode).replace(/^0+/, "").trim();
        let apgItem = apgIndex.get(normalizedBarcode);
        
        // Try original barcode if normalized doesn't match
        if (!apgItem) {
          apgItem = apgIndex.get(String(variant.barcode).trim());
        }
        
        // Try SKU as fallback
        if (!apgItem && variant.sku) {
          apgItem = apgIndex.get(String(variant.sku).trim());
        }

        if (!apgItem) {
          skipped++;
          console.log("⏭ No APG match found for barcode:", variant.barcode, "SKU:", variant.sku);
          continue;
        }

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
