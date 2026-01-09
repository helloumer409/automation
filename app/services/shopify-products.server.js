export async function getShopifyProducts(admin) {
  const res = await admin.graphql(`#graphql
    {
      products(first: 250) {
        nodes {
          id
          title
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
  `);

  const json = await res.json();
  return json.data.products.nodes;
}
