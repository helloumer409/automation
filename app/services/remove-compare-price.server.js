/**
 * Remove all compareAtPrice from all products and variants
 */
export async function removeAllCompareAtPrices(admin) {
  let removed = 0;
  let errors = [];
  let hasMore = true;
  let cursor = null;

  while (hasMore) {
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
              variants(first: 250) {
                nodes {
                  id
                  compareAtPrice
                  price
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
              variants(first: 250) {
                nodes {
                  id
                  compareAtPrice
                  price
                }
              }
            }
          }
        }
      `;

    const response = await admin.graphql(query);
    const result = await response.json();

    if (result.errors) {
      errors.push(...result.errors);
      break;
    }

    const products = result.data?.products?.nodes || [];
    const pageInfo = result.data?.products?.pageInfo || {};

    for (const product of products) {
      const variantsWithComparePrice = product.variants.nodes.filter(
        v => v.compareAtPrice && v.compareAtPrice !== null
      );

      if (variantsWithComparePrice.length > 0) {
        try {
          const updateResponse = await admin.graphql(`#graphql
            mutation {
              productVariantsBulkUpdate(
                productId: "${product.id}",
                variants: [${variantsWithComparePrice.map(v => `{
                  id: "${v.id}",
                  compareAtPrice: null
                }`).join(",")}]
              ) {
                userErrors {
                  message
                  field
                }
                productVariants {
                  id
                  compareAtPrice
                }
              }
            }
          `);

          const updateResult = await updateResponse.json();

          if (updateResult.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
            errors.push({
              product: product.title,
              errors: updateResult.data.productVariantsBulkUpdate.userErrors,
            });
          } else {
            removed += variantsWithComparePrice.length;
            console.log(`✅ Removed compareAtPrice from ${variantsWithComparePrice.length} variants in ${product.title}`);
          }
        } catch (error) {
          errors.push({
            product: product.title,
            error: error.message,
          });
        }
      }
    }

    hasMore = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return {
    removed,
    errors,
    success: errors.length === 0,
  };
}
