[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

$cli = Join-Path $PSScriptRoot '..\src\cli.js'
& node $cli audit --project-root (Get-Location).Path @Arguments
exit $LASTEXITCODE
