/**
 * Internal helper to fetch one page of products from Shopify.
 * Used by streaming helpers to avoid loading the entire catalog into memory.
 */
async function fetchProductsPage(admin, cursor = null) {
  // Validate admin context before making request
  if (!admin || !admin.graphql) {
    throw new Error("Missing access token when creating GraphQL client - admin context is invalid");
  }

  const query = cursor
    ? `#graphql
      {
        products(first: 250, after: "${cursor}") {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            status
            variants(first: 250) {
              nodes {
                id
                sku
                barcode
                inventoryItem {
                  id
                  tracked
                }
              }
            }
          }
        }
      }
    `
    : `#graphql
      {
        products(first: 250) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            status
            variants(first: 250) {
              nodes {
                id
                sku
                barcode
                inventoryItem {
                  id
                  tracked
                }
              }
            }
          }
        }
      }
    `;

  try {
    const res = await admin.graphql(query);
    
    if (!res) {
      throw new Error("GraphQL response is null - access token may have expired");
    }
    
    const json = await res.json();

    if (json.errors) {
      const errorMessages = json.errors.map((e) => e.message || String(e)).join(", ");
      // Check for authentication errors
      if (errorMessages.includes("401") || 
          errorMessages.includes("Unauthorized") || 
          errorMessages.includes("access token") ||
          errorMessages.includes("Missing access token")) {
        throw new Error("Missing access token when creating GraphQL client - session expired");
      }
      throw new Error(errorMessages);
    }

    const products = json.data?.products?.nodes || [];
    const pageInfo = json.data?.products?.pageInfo || {};

    return {
      products,
      hasNextPage: pageInfo.hasNextPage || false,
      endCursor: pageInfo.endCursor || null,
    };
  } catch (error) {
    // Re-throw with better error message if it's about token
    const errorMsg = error?.message || String(error) || "Unknown error";
    if (errorMsg.includes("access token") || 
        errorMsg.includes("Missing access token") ||
        errorMsg.includes("session expired") ||
        errorMsg.includes("401")) {
      throw new Error("Missing access token when creating GraphQL client - session expired");
    }
    throw error;
  }
}

/**
 * Legacy helper: fetches ALL products into memory.
 * Still used by heavy stats, but sync now uses streaming helpers below.
 */
export async function getShopifyProducts(admin) {
  const allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  let pageCount = 0;

  console.log("🔄 Fetching all products from Shopify (this may take a while for large stores)...");

  while (hasNextPage) {
    pageCount++;
    try {
      const { products, hasNextPage: next, endCursor } = await fetchProductsPage(admin, cursor);
      allProducts.push(...products);
      hasNextPage = next;
      cursor = endCursor;

      console.log(`📦 Fetched page ${pageCount}: ${products.length} products (Total so far: ${allProducts.length})`);

      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`❌ Error fetching products page ${pageCount}:`, error.message);
      break;
    }
  }

  const totalVariants = allProducts.reduce((sum, p) => sum + (p.variants?.nodes?.length || 0), 0);
  console.log(`✅ Total products fetched: ${allProducts.length} (${totalVariants} variants)`);

  return allProducts;
}

/**
 * Counts products and variants without keeping them all in memory.
 */
export async function countShopifyCatalog(admin) {
  let hasNextPage = true;
  let cursor = null;
  let pageCount = 0;
  let totalProducts = 0;
  let totalVariants = 0;

  console.log("🔄 Counting Shopify products/variants (streaming)...");

  while (hasNextPage) {
    pageCount++;
    try {
      const { products, hasNextPage: next, endCursor } = await fetchProductsPage(admin, cursor);
      totalProducts += products.length;
      totalVariants += products.reduce(
        (sum, p) => sum + (p.variants?.nodes?.length || 0),
        0,
      );

      hasNextPage = next;
      cursor = endCursor;

      console.log(`📦 Counted page ${pageCount}: ${products.length} products (Total so far: ${totalProducts})`);

      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      const errorMsg = error?.message || String(error) || "Unknown error";
      const errorStr = JSON.stringify(error);
      
      // Check if it's a token expiration error
      if (errorMsg.includes("access token") || 
          errorMsg.includes("Missing access token") ||
          errorMsg.includes("401") ||
          errorMsg.includes("Unauthorized") ||
          errorStr.includes("access token")) {
        console.error(`❌ Token expired while counting products page ${pageCount}: ${errorMsg}`);
        throw new Error("Admin context lost - access token expired. Please restart the operation.");
      }
      
      console.error(`❌ Error counting products page ${pageCount}: ${errorMsg}`);
      // Don't break on single page errors - continue with next page if possible
      // But throw if it's a critical error (like token expiration)
      if (errorMsg.includes("access token") || errorMsg.includes("Missing access token")) {
        throw error;
      }
      break;
    }
  }

  console.log(`✅ Catalog count complete: ${totalProducts} products (${totalVariants} variants)`);
  return { totalProducts, totalVariants };
}

/**
 * Streams all products and invokes a callback for each product one by one.
 * This avoids holding the entire catalog in memory.
 */
export async function forEachShopifyProduct(admin, callback) {
  let hasNextPage = true;
  let cursor = null;
  let pageCount = 0;

  console.log("🔄 Streaming products from Shopify (page by page)...");

  while (hasNextPage) {
    pageCount++;
    try {
      const { products, hasNextPage: next, endCursor } = await fetchProductsPage(admin, cursor);

      for (const product of products) {
        // eslint-disable-next-line no-await-in-loop
        await callback(product);
      }

      hasNextPage = next;
      cursor = endCursor;

      console.log(`📦 Processed page ${pageCount}: ${products.length} products`);

      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      const errorMsg = error?.message || String(error) || "Unknown error";
      const errorStr = JSON.stringify(error);
      
      // Check if it's a token expiration error
      if (errorMsg.includes("access token") || 
          errorMsg.includes("Missing access token") ||
          errorMsg.includes("401") ||
          errorMsg.includes("Unauthorized") ||
          errorStr.includes("access token")) {
        console.error(`❌ Token expired while streaming products page ${pageCount}: ${errorMsg}`);
        throw new Error("Admin context lost - access token expired. Please restart the operation.");
      }
      
      console.error(`❌ Error streaming products page ${pageCount}: ${errorMsg}`);
      // Don't break on single page errors - continue with next page if possible
      // But throw if it's a critical error (like token expiration)
      if (errorMsg.includes("access token") || errorMsg.includes("Missing access token")) {
        throw error;
      }
      break;
    }
  }

  console.log("✅ Finished streaming Shopify products");
}
