# Generates synthetic 16 kHz mono 16-bit WAVs from phrases.json with the installed Windows SAPI voices.
# Synthetic speech is clean and evenly paced, so results are a best case; real recordings are still needed (S8-11).
param([string]$Out = "$PSScriptRoot\audio")

Add-Type -AssemblyName System.Speech
$phrases = Get-Content "$PSScriptRoot\phrases.json" -Raw | ConvertFrom-Json
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | ForEach-Object { $_.VoiceInfo.Name }
$rates = @(-2, 0, 2)

$manifest = @()
foreach ($set in @('wake', 'otherUses', 'negative', 'requests')) {
  New-Item -ItemType Directory -Force "$Out\$set" | Out-Null
  $i = 0
  foreach ($text in $phrases.$set) {
    foreach ($voice in $voices) {
      # Requests use only the normal rate: they measure recognition, not robustness to pace.
      $setRates = if ($set -eq 'requests') { @(0) } else { $rates }
      foreach ($rate in $setRates) {
        $name = '{0:D2}-{1}-r{2}.wav' -f $i, ($voice -replace '^Microsoft (\w+).*', '$1'), $rate
        $synth.SelectVoice($voice)
        $synth.Rate = $rate
        $synth.SetOutputToWaveFile("$Out\$set\$name", $fmt)
        $synth.Speak($text)
        $synth.SetOutputToNull()
        $manifest += [pscustomobject]@{ set = $set; file = "$set/$name"; text = $text; voice = $voice; rate = $rate }
      }
    }
    $i++
  }
}
$manifest | ConvertTo-Json | Out-File -Encoding utf8 "$Out\manifest.json"
"Wrote $($manifest.Count) files to $Out"
