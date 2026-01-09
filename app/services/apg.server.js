import { authenticate } from "../shopify.server";
import { syncAPGVariant } from "../services/apg-sync.server";
import { getAPGIndex } from "../services/apg-lookup.server";
import { getShopifyProducts } from "../services/shopify-products.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const apgIndex = await getAPGIndex();
  const shopifyProducts = await getShopifyProducts(admin);

  let synced = 0;
  let skipped = 0;

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

      if (!apgItem) {
        skipped++;
        continue;
      }

      await syncAPGVariant({
        admin,
        productId: product.id,
        variant: variant,
        apgRow: apgItem,
      });

      synced++;
    }
  }

  return {
    success: true,
    synced,
    skipped,
  };
};
