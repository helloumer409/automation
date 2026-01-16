import { authenticate } from "../shopify.server";
import { getProductStats, getBasicProductStats } from "../services/product-stats.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  
  try {
    // Try to load full stats (with APG matching)
    const productStats = await getProductStats(admin);
    return {
      success: true,
      productStats,
    };
  } catch (error) {
    console.error("❌ Error loading product stats:", error);
    // Fallback to basic stats
    try {
      const productStats = await getBasicProductStats(admin);
      return {
        success: true,
        productStats,
      };
    } catch (basicError) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
