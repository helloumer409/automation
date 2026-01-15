/**
 * Internal helper to fetch one page of products from Shopify.
 * Used by streaming helpers to avoid loading the entire catalog into memory.
 */
async function fetchProductsPage(admin, cursor = null) {
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

  const res = await admin.graphql(query);
  const json = await res.json();

  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join(", "));
  }

  const products = json.data?.products?.nodes || [];
  const pageInfo = json.data?.products?.pageInfo || {};

  return {
    products,
    hasNextPage: pageInfo.hasNextPage || false,
    endCursor: pageInfo.endCursor || null,
  };
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
      console.error(`❌ Error counting products page ${pageCount}:`, error.message);
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
      console.error(`❌ Error streaming products page ${pageCount}:`, error.message);
      break;
    }
  }

  console.log("✅ Finished streaming Shopify products");
}
