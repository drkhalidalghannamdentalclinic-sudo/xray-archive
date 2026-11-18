# Reads the text written on images using the OCR that is built into Windows 10/11 (no install needed).
# Usage: powershell -File ocr_windows.ps1 -Out result.txt image1.png image2.png ...
# Writes one line per recognized text line:  <language><TAB><text>   (UTF-8)
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Images
)
$ErrorActionPreference = 'Stop'
$lines = New-Object System.Collections.Generic.List[string]
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, [Type]$type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $null = $task.Wait(-1)
    $task.Result
  }

  # one engine per installed OCR language we care about (English always; Arabic if its language pack is installed)
  $engines = @()
  $avail = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
  foreach ($want in @('en', 'ar')) {
    $lang = $avail | Where-Object { $_.LanguageTag -like "$want*" } | Select-Object -First 1
    if ($lang) {
      $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      if ($e) { $engines += , @($want, $e) }
    }
  }
  if ($engines.Count -eq 0) {
    $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($e) { $engines += , @('user', $e) }
  }
  if ($engines.Count -eq 0) { throw 'No Windows OCR language is installed' }

  foreach ($img in $Images) {
    if (-not (Test-Path -LiteralPath $img)) { continue }
    $full = (Resolve-Path -LiteralPath $img).Path
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      foreach ($pair in $engines) {
        $engine = $pair[1]
        if ($bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or
            $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { continue }
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        foreach ($l in $result.Lines) { $lines.Add($pair[0] + "`t" + $l.Text) }
      }
    } finally { $stream.Dispose() }
  }
} catch {
  $lines.Add("error`t" + $_.Exception.Message)
  [IO.File]::WriteAllLines($Out, $lines, (New-Object System.Text.UTF8Encoding $false))
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
[IO.File]::WriteAllLines($Out, $lines, (New-Object System.Text.UTF8Encoding $false))
exit 0
