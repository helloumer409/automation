import { getAPGIndex } from "./apg-lookup.server";
import { getShopifyProducts } from "./shopify-products.server";

/**
 * Gets comprehensive product statistics
 */
export async function getProductStats(admin) {
  try {
    // Validate admin context
    if (!admin || !admin.graphql) {
      throw new Error("Admin context is missing - cannot fetch product stats");
    }
    
    // Get all Shopify products
    const shopifyProducts = await getShopifyProducts(admin);
    
    // Get APG index for matching
    const apgIndex = await getAPGIndex();
    
    let totalProducts = shopifyProducts.length;
    let totalVariants = 0;
    let activeProducts = 0;
    let draftProducts = 0;
    let archivedProducts = 0;
    let productsWithInventory = 0;
    let productsWithInventoryCount = 0;
    let matchedWithAPG = 0;
    let unmatchedWithAPG = 0;
    let mapZeroProducts = 0;
    
    // Track inventory status
    const inventoryStats = {
      withInventory: 0,
      withoutInventory: 0,
      totalInventoryQuantity: 0,
    };
    
    for (const product of shopifyProducts) {
      // Count product status
      if (product.status === "ACTIVE") {
        activeProducts++;
      } else if (product.status === "DRAFT") {
        draftProducts++;
      } else if (product.status === "ARCHIVED") {
        archivedProducts++;
      }
      
      // Count variants
      const variants = product.variants?.nodes || [];
      totalVariants += variants.length;
      
      // Check if product has inventory
      let productHasInventory = false;
      let productInventoryTotal = 0;
      
      for (const variant of variants) {
        // Check inventory - query inventory levels if available
        // Note: inventoryQuantity might not be in the query, so we check inventoryItem
        if (variant.inventoryItem?.id) {
          // Product has inventory tracking enabled - assume it might have inventory
          // Full inventory check would require additional queries per variant (too slow)
          productHasInventory = true;
        }
        
        // Check if variant matches APG
        let matched = false;
        if (variant.barcode || variant.sku) {
          const barcodeStr = variant.barcode ? String(variant.barcode).trim() : "";
          const normalizedBarcode = barcodeStr.replace(/^0+/, "");
          const padded12 = normalizedBarcode.padStart(12, "0");
          const padded13 = normalizedBarcode.padStart(13, "0");
          const padded14 = normalizedBarcode.padStart(14, "0");
          
          const lookupKeys = [barcodeStr, normalizedBarcode, padded12, padded13, padded14];
          
          for (const key of lookupKeys) {
            if (key && apgIndex.has(key)) {
              matched = true;
              break;
            }
          }
          
          // Try SKU matching
          if (!matched && variant.sku) {
            matched = apgIndex.has(String(variant.sku).trim());
          }
          
          // Check if MAP is 0 for matched products
          if (matched) {
            const apgItem = apgIndex.get(lookupKeys.find(k => k && apgIndex.has(k)) || String(variant.sku).trim());
            if (apgItem) {
              const mapPriceStr = apgItem.MAP || apgItem.map || apgItem["MAP Price"] || "0";
              const mapPrice = parseFloat(String(mapPriceStr).replace(/[$,\s]/g, "").trim()) || 0;
              if (mapPrice === 0) {
                mapZeroProducts++;
              }
            }
          }
        }
        
        if (matched) {
          matchedWithAPG++;
        } else {
          unmatchedWithAPG++;
        }
      }
      
      if (productHasInventory) {
        productsWithInventory++;
        productsWithInventoryCount += productInventoryTotal;
      } else {
        inventoryStats.withoutInventory++;
      }
    }
    
    return {
      totalProducts,
      totalVariants,
      activeProducts,
      draftProducts,
      archivedProducts,
      productsWithInventory,
      productsWithInventoryCount,
      matchedWithAPG,
      unmatchedWithAPG,
      mapZeroProducts,
      inventoryStats: {
        withInventory: inventoryStats.withInventory,
        withoutInventory: inventoryStats.withoutInventory,
        totalQuantity: inventoryStats.totalInventoryQuantity,
      },
    };
  } catch (error) {
    console.error("❌ Error fetching product stats:", error);
    throw error;
  }
}
