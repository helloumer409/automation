# Auto-Sync Configuration

## ✅ Auto-Sync is Enabled by Default

The app now runs automatic sync **every 6 hours by default**. No configuration needed!

## How It Works

1. **Automatic Sync**: Runs every 6 hours automatically
   - Updates MAP pricing from CSV
   - Updates inventory from "USA Item Availability" column
   - Updates cost prices
   - Sets product status (ACTIVE for matched, DRAFT for unmatched)
   - Applies Jobber price when MAP=0

2. **Manual Sync**: You can still trigger sync manually anytime using the "Sync APG Inventory & Pricing" button on the dashboard

## Configuration Options

### Option 1: Use Default (Recommended)
**No configuration needed!** Auto-sync runs every 6 hours automatically.

### Option 2: Custom Schedule
Set `AUTO_SYNC_SCHEDULE` environment variable in Railway:
- `"0 * * * *"` = Every hour
- `"0 */2 * * *"` = Every 2 hours
- `"0 */6 * * *"` = Every 6 hours (default)
- `"0 9 * * *"` = Daily at 9 AM
- `"*/30 * * * *"` = Every 30 minutes (use with caution)

### Option 3: Disable Auto-Sync
Set `AUTO_SYNC_DISABLED=true` in Railway environment variables to disable automatic syncing.

## Railway Environment Variables

**To customize schedule:**
```
AUTO_SYNC_SCHEDULE="0 */4 * * *"  # Every 4 hours
```

**To disable auto-sync:**
```
AUTO_SYNC_DISABLED=true
```

**Default behavior (no env vars needed):**
- Auto-sync enabled
- Runs every 6 hours
- Manual sync always available

## Dashboard Display

The dashboard will show:
- ✅ **Auto-sync: Enabled** (by default)
- **Schedule:** Shows your custom schedule or default "every 6 hours"
- Manual sync button always available

## Notes

- Auto-sync runs in the background and won't block your app
- Manual sync can be triggered anytime, even while auto-sync is running
- Sync statistics are saved to the database and displayed on the dashboard
- Last sync time/date is shown on the dashboard
