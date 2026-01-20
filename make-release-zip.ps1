# make-release-zip.ps1
# Erstellt eine saubere Release-ZIP ohne Build/Cache/Secrets
# Output: calendar-mvp-release.zip

$ErrorActionPreference = "Stop"
$zipName = "calendar-mvp-release.zip"

if (Test-Path $zipName) { Remove-Item $zipName -Force }

# Alles zippen, aber diese Pfade ausschließen:
$exclude = @(
  "*/node_modules/*",
  "*/android/.gradle/*",
  "*/android/.idea/*",
  "*/android/app/build/*",
  "*/android/build/*",
  "*/android/caches/*",
  "*/.git/*",
  "*/.vscode/*",
  "*/dist/*",
  "*/build/*",
  "*/coverage/*",
  "*/tmp/*",
  "*/.DS_Store",
  "*/Thumbs.db",

  # Secrets / Tokens NICHT in ZIP
  "*/server/.env",
  "*/server/google-tokens.json"
)

# Zip aus dem aktuellen Ordner
Compress-Archive -Path .\* -DestinationPath $zipName -Force -CompressionLevel Optimal

# Danach die ausgeschlossenen Muster wieder rauswerfen (PowerShell kann nicht direkt exclude beim Zippen)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temp = "._tmp_zip_work"
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp | Out-Null
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipName, $temp)
Remove-Item $zipName -Force

# Excludes anwenden
foreach ($pattern in $exclude) {
  Get-ChildItem -Path $temp -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like (Join-Path (Resolve-Path $temp) ($pattern -replace "\*/","*\" -replace "/","\")) } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

Compress-Archive -Path (Join-Path $temp "*") -DestinationPath $zipName -Force -CompressionLevel Optimal
Remove-Item $temp -Recurse -Force

Write-Host "✅ Fertig: $zipName"
