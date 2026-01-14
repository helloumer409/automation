/**
 * Fetches ALL products from Shopify with pagination
 * Handles stores with 22,000+ products
 */
export async function getShopifyProducts(admin) {
  const allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  let pageCount = 0;

  console.log("🔄 Fetching all products from Shopify (this may take a while for large stores)...");

  while (hasNextPage) {
    pageCount++;
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
      const json = await res.json();

      if (json.errors) {
        console.error("❌ GraphQL errors:", json.errors);
        break;
      }

      const products = json.data?.products?.nodes || [];
      const pageInfo = json.data?.products?.pageInfo || {};

      allProducts.push(...products);
      hasNextPage = pageInfo.hasNextPage || false;
      cursor = pageInfo.endCursor || null;

      console.log(`📦 Fetched page ${pageCount}: ${products.length} products (Total so far: ${allProducts.length})`);

      // Small delay to avoid rate limiting
      if (hasNextPage) {
        await new Promise(resolve => setTimeout(resolve, 100));
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
