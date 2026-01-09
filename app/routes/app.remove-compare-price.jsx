import { authenticate } from "../shopify.server";
import { removeAllCompareAtPrices } from "../services/remove-compare-price.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    console.log("🧹 Starting removal of all compareAtPrice values...");
    const result = await removeAllCompareAtPrices(admin);

    return {
      success: result.success,
      removed: result.removed,
      errors: result.errors.length > 0 ? result.errors : undefined,
      message: `Removed compareAtPrice from ${result.removed} variants${result.errors.length > 0 ? `, ${result.errors.length} errors` : ""}`,
    };
  } catch (error) {
    console.error("❌ Remove compare price failed:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}
