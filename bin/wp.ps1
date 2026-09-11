[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
node (Join-Path $PSScriptRoot '..\src\cli.js') wp --project-root $projectRoot @Arguments
exit $LASTEXITCODE
