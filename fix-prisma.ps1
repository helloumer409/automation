# PowerShell script to fix Prisma file lock issue on Windows
# Run this script if you encounter EPERM errors with Prisma

Write-Host "🔧 Fixing Prisma file lock issue..." -ForegroundColor Yellow

# Stop any running Node processes
Write-Host "⏹️  Stopping Node processes..." -ForegroundColor Cyan
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Delete .prisma folder in node_modules
$prismaClientPath = "node_modules\.prisma"
if (Test-Path $prismaClientPath) {
    Write-Host "🗑️  Removing .prisma folder..." -ForegroundColor Cyan
    Remove-Item -Path $prismaClientPath -Recurse -Force -ErrorAction SilentlyContinue
}

# Delete Prisma query engine files if they exist
$queryEnginePath = "node_modules\@prisma\engines"
if (Test-Path $queryEnginePath) {
    Write-Host "🗑️  Cleaning Prisma engines..." -ForegroundColor Cyan
    Get-ChildItem -Path $queryEnginePath -Filter "query-engine-windows.exe*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-Host "✅ Cleanup complete!" -ForegroundColor Green
Write-Host "📦 Now run: npx prisma generate" -ForegroundColor Yellow
