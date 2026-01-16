import { getAPGIndex } from "./apg-lookup.server";
import { forEachShopifyProduct } from "./shopify-products.server";

/**
 * Gets comprehensive product statistics using streaming to avoid memory issues
 */
export async function getProductStats(admin) {
  try {
    // Validate admin context
    if (!admin || !admin.graphql) {
      throw new Error("Admin context is missing - cannot fetch product stats");
    }
    
    // Get APG index for matching (cache this to speed up)
    const apgIndex = await getAPGIndex();
    
    // Use streaming approach instead of loading all products into memory
    let totalProducts = 0;
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
    
    // Stream products one by one to calculate stats
    await forEachShopifyProduct(admin, (product) => {
      totalProducts++;
      
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
        if (variant.inventoryItem?.id) {
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
            matched = apgIndex.has(String(variant.sku).trim()) || apgIndex.has(String(variant.sku).trim().toUpperCase());
          }
          
          // Check if MAP is 0 for matched products
          if (matched) {
            const matchedKey = lookupKeys.find(k => k && apgIndex.has(k)) || (variant.sku ? String(variant.sku).trim().toUpperCase() : null);
            const apgItem = matchedKey ? apgIndex.get(matchedKey) : null;
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
    });
    
    // Early return if no products
    if (totalProducts === 0) {
      return {
        totalProducts: 0,
        totalVariants: 0,
        activeProducts: 0,
        draftProducts: 0,
        archivedProducts: 0,
        productsWithInventory: 0,
        productsWithInventoryCount: 0,
        matchedWithAPG: 0,
        unmatchedWithAPG: 0,
        mapZeroProducts: 0,
        inventoryStats: {
          withInventory: 0,
          withoutInventory: 0,
          totalQuantity: 0,
        },
      };
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
