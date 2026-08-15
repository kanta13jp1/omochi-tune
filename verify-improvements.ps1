$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$indexPath = Join-Path $root 'index.html'
$html = Get-Content -Raw -Encoding UTF8 $indexPath
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
  param([int]$Number, [string]$Hypothesis, [bool]$Passed, [string]$Evidence)
  $results.Add([pscustomobject]@{
    No = $Number
    Result = if ($Passed) { 'PASS' } else { 'FAIL' }
    Hypothesis = $Hypothesis
    Evidence = $Evidence
  })
}

$contentPaths = @('columns', 'gallery', 'tarot', 'settings', 'instagram') |
  ForEach-Object { Join-Path $root "content/$_.json" }
$contentExternal = @($contentPaths | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 5 -and
  -not $html.Contains("localStorage.getItem('omochi_columns')")
Add-Result 1 'Publishing data can live outside index.html' $contentExternal 'Five JSON files; content LocalStorage override removed'

$cmsConfig = Join-Path $root 'admin/config.yml'
$cmsReady = (Test-Path -LiteralPath (Join-Path $root 'admin/index.html')) -and
  (Test-Path -LiteralPath $cmsConfig) -and
  (Get-Content -Raw -Encoding UTF8 $cmsConfig).Contains('repo: kanta13jp1/omochi-tune')
Add-Result 2 'A Git-based CMS can manage the existing site' $cmsReady 'Pinned Sveltia admin and GitHub backend config'

$columns = Get-Content -Raw -Encoding UTF8 $contentPaths[0] | ConvertFrom-Json
$gallery = Get-Content -Raw -Encoding UTF8 $contentPaths[1] | ConvertFrom-Json
$tarot = Get-Content -Raw -Encoding UTF8 $contentPaths[2] | ConvertFrom-Json
$jsonModel = $columns.Count -ge 3 -and $gallery.Count -ge 5 -and $tarot.Count -ge 6
Add-Result 3 'Current content maps cleanly to JSON lists' $jsonModel "Columns=$($columns.Count), Gallery=$($gallery.Count), Tarot=$($tarot.Count)"

$noFrameworkRewrite = $html.Contains('<!doctype html>') -and
  -not (Test-Path -LiteralPath (Join-Path $root 'src')) -and
  -not ((Get-Content -Raw -Encoding UTF8 (Join-Path $root 'package.json')).Contains('astro'))
Add-Result 4 'A full framework migration is unnecessary' $noFrameworkRewrite 'Original static entry point and structure retained'

$sveltiaPinned = (Get-Content -Raw -Encoding UTF8 (Join-Path $root 'admin/index.html')).Contains('@sveltia/cms@0.191.1')
Add-Result 5 'Sveltia is the focused CMS extension' $sveltiaPinned 'Exact CMS version is pinned'

$accessibleDialogs = $html.Contains('vendor/a11y-dialog-8.1.5.min.js') -and
  ([regex]::Matches($html, 'role="dialog"')).Count -eq 3 -and
  ([regex]::Matches($html, 'aria-modal="true"')).Count -eq 3
Add-Result 6 'Dialogs can meet keyboard accessibility needs' $accessibleDialogs 'a11y-dialog plus three labelled modal dialogs'

$sanitized = $html.Contains('vendor/dompurify-3.4.13.min.js') -and
  $html.Contains('DOMPurify.sanitize') -and
  $html.Contains('sanitizeRichHtml(article.content)')
Add-Result 7 'CMS rich text can be rendered safely' $sanitized 'Pinned DOMPurify and allow-listed article rendering'

$browserTests = (Test-Path -LiteralPath (Join-Path $root 'playwright.config.mjs')) -and
  (Test-Path -LiteralPath (Join-Path $root 'tests/site.spec.mjs')) -and
  (Test-Path -LiteralPath (Join-Path $root '.github/workflows/pages.yml'))
Add-Result 8 'Real browser tests can prevent interaction regressions' $browserTests 'Playwright suite and Pages workflow present'

$instagramData = Get-Content -Raw -Encoding UTF8 $contentPaths[4] | ConvertFrom-Json
$instagramDriven = $instagramData.Count -eq 6 -and
  $html.Contains('id="instagramPreviewGrid"') -and
  $html.Contains('OMOCHI_INSTAGRAM.forEach')
Add-Result 9 'Instagram previews can be managed per entry' $instagramDriven "Six CMS-managed preview entries"

$discovery = (Test-Path -LiteralPath (Join-Path $root 'dist/feed.xml')) -and
  (Test-Path -LiteralPath (Join-Path $root 'dist/sitemap.xml')) -and
  (Test-Path -LiteralPath (Join-Path $root 'dist/robots.txt')) -and
  $html.Contains('href="feed.xml"')
Add-Result 10 'RSS and search discovery files can be generated' $discovery 'Feed, sitemap, robots and visible RSS link'

$ids = [regex]::Matches($html, '\sid="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
$duplicateIds = @($ids | Group-Object | Where-Object Count -gt 1)

$results | Format-Table -AutoSize -Wrap
Write-Host ''
Write-Host "Structural check: duplicate ids = $($duplicateIds.Count)"

$failed = @($results | Where-Object Result -eq 'FAIL')
if ($failed.Count -gt 0 -or $duplicateIds.Count -gt 0) {
  Write-Error "Verification failed: $($failed.Count) hypothesis checks failed."
  exit 1
}

Write-Host 'All 10 hypotheses passed.' -ForegroundColor Green
