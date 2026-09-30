<#
.SYNOPSIS
  Makes test speech: one 16-bit mono WAV per line of a text file, with the Windows built-in synthesizer.

.DESCRIPTION
  The WAV files feed the stage soak test (npm run replay -w @animatus/orchestrator). They only need to be
  speech-like audio of realistic length, not good speech.

  The text file is read as UTF-8, one sentence per line (blank lines are skipped). Output files are named
  line-001.wav, line-002.wav, ... in -OutDir. Generated WAV files are git-ignored: do not commit them.

  Voice choice: -Voice wins. Otherwise a line that contains CJK characters is read by a Chinese voice
  (zh-CN first) when one is installed, and every other line by the first installed voice.

.PARAMETER TextFile
  UTF-8 text file, one sentence per line.

.PARAMETER OutDir
  Folder for the WAV files (created when missing).

.PARAMETER Voice
  Name of an installed voice (see -ListVoices). Used for every line.

.PARAMETER Rate
  Speaking rate from -10 (slow) to 10 (fast). Default 0.

.PARAMETER SampleRate
  Sample rate of the WAV files in Hz. Default 32000, the rate the speech engine of the stage pipeline uses.

.PARAMETER ListVoices
  Prints the installed voices and exits.

.EXAMPLE
  powershell -File tools\make-test-speech.ps1 -TextFile lines.txt -OutDir data\test-speech

.EXAMPLE
  powershell -File tools\make-test-speech.ps1 -ListVoices
#>
[CmdletBinding()]
param(
  [string]$TextFile,
  [string]$OutDir,
  [string]$Voice = '',
  [ValidateRange(-10, 10)]
  [int]$Rate = 0,
  [ValidateRange(8000, 48000)]
  [int]$SampleRate = 32000,
  [switch]$ListVoices
)

$ErrorActionPreference = 'Stop'

# CJK text: Han ideographs (also extension A and the compatibility block) and the CJK punctuation block.
# Checked by code point so that this file can stay pure ASCII.
$cjkRanges = @(@(0x3000, 0x303f), @(0x3400, 0x4dbf), @(0x4e00, 0x9fff), @(0xf900, 0xfaff))
function Test-Cjk([string]$Text) {
  foreach ($ch in $Text.ToCharArray()) {
    $code = [int]$ch
    foreach ($range in $cjkRanges) {
      if ($code -ge $range[0] -and $code -le $range[1]) { return $true }
    }
  }
  return $false
}

$synth = $null
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

  $installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })

  if ($ListVoices) {
    if ($installed.Count -eq 0) { Write-Output '(no voices installed)' }
    foreach ($v in $installed) {
      Write-Output ('{0}  [{1}, {2}]' -f $v.Name, $v.Culture.Name, $v.Gender)
    }
    return
  }

  if (-not $TextFile) { throw '-TextFile is required: a UTF-8 text file with one sentence per line' }
  if (-not $OutDir) { throw '-OutDir is required: the folder for the WAV files' }
  if ($installed.Count -eq 0) { throw 'no speech voices are installed; add one in Windows settings (Time and language > Speech)' }

  # .NET resolves relative paths against the process directory, not the PowerShell location.
  $textPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($TextFile)
  $outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)
  if (-not (Test-Path -LiteralPath $textPath -PathType Leaf)) { throw "text file not found: $textPath" }

  $lines = @(Get-Content -LiteralPath $textPath -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  if ($lines.Count -eq 0) { throw "the text file has no text: $textPath" }

  if ($Voice -ne '') {
    $known = @($installed | ForEach-Object { $_.Name })
    if ($known -notcontains $Voice) {
      throw ("voice '{0}' is not installed. Installed voices: {1}" -f $Voice, ($known -join ', '))
    }
  }

  $chineseVoice = $installed | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  if (-not $chineseVoice) {
    $chineseVoice = $installed | Where-Object { $_.Culture.Name -like 'zh-*' } | Select-Object -First 1
  }
  $defaultVoice = $installed[0]

  New-Item -ItemType Directory -Force -Path $outPath | Out-Null
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    $SampleRate,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.Rate = $Rate

  $index = 0
  foreach ($text in $lines) {
    $index++
    if ($Voice -ne '') { $voiceName = $Voice }
    elseif ((Test-Cjk $text) -and $chineseVoice) { $voiceName = $chineseVoice.Name }
    else { $voiceName = $defaultVoice.Name }

    $file = Join-Path $outPath ('line-{0:D3}.wav' -f $index)
    $synth.SelectVoice($voiceName)
    $synth.SetOutputToWaveFile($file, $format)
    try {
      $synth.Speak($text)
    } finally {
      # the WAV header is only finished when the output is closed
      $synth.SetOutputToNull()
    }
    # A voice that cannot read the text (for example an English voice given Chinese text) writes a WAV
    # without any audio. That must not pass as a success.
    $written = (Get-Item -LiteralPath $file).Length
    if ($written -lt 1000) {
      Remove-Item -LiteralPath $file -Force
      throw ("line {0} produced no audio: voice '{1}' cannot read this text. Use -Voice with another voice (see -ListVoices) or leave it out." -f $index, $voiceName)
    }
    Write-Host ('{0}  voice "{1}", {2} characters' -f $file, $voiceName, $text.Length)
  }
  Write-Host ('Wrote {0} file(s) to {1}' -f $lines.Count, $outPath)
} catch {
  [Console]::Error.WriteLine('make-test-speech: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($synth) { $synth.Dispose() }
}
