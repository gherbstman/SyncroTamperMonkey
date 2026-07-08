#Requires -Version 7.0

<#
.SYNOPSIS
Creates or reuses Microsoft Bookings shared businesses for engineers and exports booking links for Tampermonkey.

.DESCRIPTION
For each target user, this script:
1) Gets or creates a booking business named with DisplayNameFormat.
2) Gets or creates a staff member for that user.
3) Gets or creates 3 standard services (15/30/60 minutes by default).
4) Optionally publishes the booking business.
5) Exports CSV rows in Tampermonkey-friendly format:
    - userPrincipalName
   - engineerName
   - pullDownDescription
   - linkTextHtml
   - bookingLink

.AUTHENTICATION
Modes are supported:
- AccessToken: Provide a delegated bearer token explicitly.
- DeviceCodeDelegated: Uses OAuth device code flow via REST (no modules/CLI required).
#>

param(
    [Parameter()]
    [ValidateSet('AccessToken', 'DeviceCodeDelegated')]
    [string]$AuthMode = 'AccessToken',

    [Parameter()]
    [string]$AccessToken = '',

    [Parameter()]
    [string]$TenantId = '',

    [Parameter()]
    [string]$ClientId = '',

    [Parameter()]
    [string[]]$TargetUserPrincipalNames = @(),

    [Parameter()]
    [string[]]$ExcludeUserPrincipalNames = @(),

    [Parameter()]
    [string]$OutputCsvPath = '',

    [Parameter()]
    [string[]]$BookingAdminUpns = @(),

    [Parameter()]
    [switch]$SkipPublish
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ============================================================================
# USER-MANAGEABLE SETTINGS
# ============================================================================

$ScriptSettings = @{
    OutputCsvPath           = '.\bookings-links.csv'
    AccessAuditCsvPath      = '.\bookings-access-audit.csv'
    UseUserMailboxWorkingHours = $true
    UseDeviceCodeTokenCache = $true
    DeviceCodeTokenCachePath = '.\bookings-token-cache.json'
    AddSharedAccessMembers  = $true
    BookingAdminUpns        = @(
        # 'admin1@contoso.com'
    )
    BookingEditorUpns       = @(
        # 'editor1@contoso.com'
    )
    BookingViewerUpns       = @(
        # 'viewer1@contoso.com'
    )
    IncludeProvisionedUsersAsEditors = $true
    IncludeAllGlobalAdminsAsAdmins   = $true
    BusinessTimeZone        = 'Eastern Standard Time'
    BusinessLanguageTag     = 'en-US'
    BusinessHours           = @(
        @{ Day = 'monday';    StartTime = '07:00:00.0000000'; EndTime = '19:00:00.0000000' }
        @{ Day = 'tuesday';   StartTime = '07:00:00.0000000'; EndTime = '19:00:00.0000000' }
        @{ Day = 'wednesday'; StartTime = '07:00:00.0000000'; EndTime = '19:00:00.0000000' }
        @{ Day = 'thursday';  StartTime = '07:00:00.0000000'; EndTime = '19:00:00.0000000' }
        @{ Day = 'friday';    StartTime = '07:00:00.0000000'; EndTime = '19:00:00.0000000' }
        @{ Day = 'saturday';  StartTime = $null;               EndTime = $null }
        @{ Day = 'sunday';    StartTime = $null;               EndTime = $null }
    )
}

function Resolve-OutputPath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if ([IO.Path]::IsPathRooted($Path)) {
        return $Path
    }

    return (Join-Path -Path $PSScriptRoot -ChildPath $Path)
}

$OutputCsvPath = if ([string]::IsNullOrWhiteSpace($OutputCsvPath)) { $ScriptSettings.OutputCsvPath } else { $OutputCsvPath }

$OutputCsvPath = Resolve-OutputPath -Path $OutputCsvPath
$AccessAuditCsvPath = Resolve-OutputPath -Path $ScriptSettings.AccessAuditCsvPath
$DeviceCodeTokenCachePath = Resolve-OutputPath -Path $ScriptSettings.DeviceCodeTokenCachePath

# ============================================================================
# CONFIGURATION
# ============================================================================

$GraphBaseUrl = 'https://graph.microsoft.com/v1.0'
$GraphTokenScope = 'https://graph.microsoft.com/.default'
$GraphDelegatedScopesBase = 'https://graph.microsoft.com/Bookings.Manage.All https://graph.microsoft.com/User.Read.All https://graph.microsoft.com/MailboxSettings.Read offline_access openid profile'
$GraphDirectoryReadScope = 'https://graph.microsoft.com/Directory.Read.All'

$ProvisioningTemplate = @{
    Business = @{
        DisplayNameFormat = '{0} Scheduling'
        Phone             = $null
        WebSiteUrl        = $null
        DefaultCurrencyIso = 'USD'
        Address           = $null
        LanguageTag       = $ScriptSettings.BusinessLanguageTag
        BusinessHours     = $ScriptSettings.BusinessHours
    }

    Staff = @{
        Role                                     = 'administrator'
        UseBusinessHours                         = (-not $ScriptSettings.UseUserMailboxWorkingHours)
        AvailabilityIsAffectedByPersonalCalendar = $true
        IsEmailNotificationEnabled               = $true
        TimeZone                                 = $ScriptSettings.BusinessTimeZone
    }

    Services = @(
        @{
            DisplayName                      = 'Support - 15 Minutes'
            Description                      = 'Quick clarification or brief troubleshooting call.'
            DefaultDuration                  = 'PT15M'
            PreBuffer                        = 'PT0S'
            PostBuffer                       = 'PT0S'
            IsLocationOnline                 = $true
            IsCustomerAllowedToManageBooking = $true
            IsHiddenFromCustomers            = $false
            SmsNotificationsEnabled          = $false
            IsAnonymousJoinEnabled           = $false
            SchedulingPolicy                 = @{
                AllowStaffSelection               = $false
                MaximumAdvance                   = 'P30D'
                MinimumLeadTime                  = 'PT1H'
                SendConfirmationsToOwner         = $true
                TimeSlotInterval                 = 'PT15M'
                IsMeetingInviteToCustomersEnabled = $true
            }
        }
        @{
            DisplayName                      = 'Support - 30 Minutes'
            Description                      = 'Standard troubleshooting or review call.'
            DefaultDuration                  = 'PT30M'
            PreBuffer                        = 'PT0S'
            PostBuffer                       = 'PT0S'
            IsLocationOnline                 = $true
            IsCustomerAllowedToManageBooking = $true
            IsHiddenFromCustomers            = $false
            SmsNotificationsEnabled          = $false
            IsAnonymousJoinEnabled           = $false
            SchedulingPolicy                 = @{
                AllowStaffSelection               = $false
                MaximumAdvance                   = 'P30D'
                MinimumLeadTime                  = 'PT1H'
                SendConfirmationsToOwner         = $true
                TimeSlotInterval                 = 'PT30M'
                IsMeetingInviteToCustomersEnabled = $true
            }
        }
        @{
            DisplayName                      = 'Support - 60 Minutes'
            Description                      = 'Deep-dive troubleshooting, planning, or working session.'
            DefaultDuration                  = 'PT1H'
            PreBuffer                        = 'PT0S'
            PostBuffer                       = 'PT0S'
            IsLocationOnline                 = $true
            IsCustomerAllowedToManageBooking = $true
            IsHiddenFromCustomers            = $false
            SmsNotificationsEnabled          = $false
            IsAnonymousJoinEnabled           = $false
            SchedulingPolicy                 = @{
                AllowStaffSelection               = $false
                MaximumAdvance                   = 'P30D'
                MinimumLeadTime                  = 'PT1H'
                SendConfirmationsToOwner         = $true
                TimeSlotInterval                 = 'PT1H'
                IsMeetingInviteToCustomersEnabled = $true
            }
        }
    )
}

$TamperMonkeyTemplate = @{
    PullDownDescriptionFormat = '{0}'
    LinkTextHtmlFormat        = 'Book {0} with {1}'
}

# ============================================================================
# HELPERS
# ============================================================================

function Write-LogEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('INFO', 'WARN', 'ERROR', 'SUCCESS')]
        [string]$Level,

        [Parameter(Mandatory)]
        [string]$Message
    )

    $color = switch ($Level) {
        'INFO' { 'Cyan' }
        'WARN' { 'Yellow' }
        'ERROR' { 'Red' }
        'SUCCESS' { 'Green' }
    }

    Write-Host "[$Level] $Message" -ForegroundColor $color
}

function ConvertTo-Base64Url {
    [CmdletBinding()]
    param([Parameter(Mandatory)][byte[]]$Bytes)

    $base64 = [Convert]::ToBase64String($Bytes)
    $base64 = $base64.TrimEnd('=').Replace('+', '-').Replace('/', '_')
    return $base64
}

function Protect-LocalSecret {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Value)

    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Convert]::ToBase64String($protected)
}

function Unprotect-LocalSecret {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Value)

    $bytes = [Convert]::FromBase64String($Value)
    $unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Text.Encoding]::UTF8.GetString($unprotected)
}

function Get-JwtExpiryUtc {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$AccessToken)

    try {
        $parts = $AccessToken.Split('.')
        if ($parts.Count -lt 2) {
            return $null
        }

        $payload = $parts[1].Replace('-', '+').Replace('_', '/')
        switch ($payload.Length % 4) {
            2 { $payload += '==' }
            3 { $payload += '=' }
            0 { }
            default { return $null }
        }

        $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
        $payloadObj = $payloadJson | ConvertFrom-Json -ErrorAction Stop
        $expRaw = Get-ObjectPropertyValue -InputObject $payloadObj -PropertyName 'exp' -DefaultValue $null
        if ($null -eq $expRaw) {
            return $null
        }

        $expSeconds = [double]$expRaw
        return [DateTimeOffset]::FromUnixTimeSeconds([long][Math]::Floor($expSeconds)).UtcDateTime
    }
    catch {
        return $null
    }
}

function Read-DeviceCodeTokenCache {
    [CmdletBinding()]
    param()

    if (-not $ScriptSettings.UseDeviceCodeTokenCache) {
        return $null
    }

    if (-not (Test-Path -LiteralPath $DeviceCodeTokenCachePath)) {
        return $null
    }

    try {
        $raw = Get-Content -LiteralPath $DeviceCodeTokenCachePath -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) {
            return $null
        }

        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        Write-LogEntry -Level WARN -Message "Ignoring unreadable token cache '$DeviceCodeTokenCachePath'. $($_.Exception.Message)"
        return $null
    }
}

function Save-DeviceCodeTokenCache {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Tenant,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Scope,
        [Parameter(Mandatory)][object]$TokenResponse
    )

    if (-not $ScriptSettings.UseDeviceCodeTokenCache) {
        return
    }

    $accessToken = [string](Get-ObjectPropertyValue -InputObject $TokenResponse -PropertyName 'access_token' -DefaultValue '')
    if ([string]::IsNullOrWhiteSpace($accessToken)) {
        return
    }

    $refreshToken = [string](Get-ObjectPropertyValue -InputObject $TokenResponse -PropertyName 'refresh_token' -DefaultValue '')
    $expiresIn = [int](Get-ObjectPropertyValue -InputObject $TokenResponse -PropertyName 'expires_in' -DefaultValue 3600)
    if ($expiresIn -le 0) {
        $expiresIn = 3600
    }

    $payload = [pscustomobject]@{
        tenant       = $Tenant
        clientId     = $AppId
        scope        = $Scope
        cachedAtUtc  = [DateTime]::UtcNow.ToString('o')
        expiresAtUtc = [DateTime]::UtcNow.AddSeconds($expiresIn).ToString('o')
        accessToken  = Protect-LocalSecret -Value $accessToken
        refreshToken = if ([string]::IsNullOrWhiteSpace($refreshToken)) { '' } else { Protect-LocalSecret -Value $refreshToken }
    }

    try {
        New-ParentDirectory -Path $DeviceCodeTokenCachePath
        $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $DeviceCodeTokenCachePath -Encoding UTF8
    }
    catch {
        Write-LogEntry -Level WARN -Message "Unable to write token cache '$DeviceCodeTokenCachePath'. $($_.Exception.Message)"
    }
}

function Get-CachedDeviceCodeAccessToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Tenant,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Scope
    )

    $cache = Read-DeviceCodeTokenCache
    if ($null -eq $cache) {
        return $null
    }

    if ([string]$cache.tenant -ne $Tenant -or [string]$cache.clientId -ne $AppId -or [string]$cache.scope -ne $Scope) {
        return $null
    }

    $expiresAtUtcRaw = [string](Get-ObjectPropertyValue -InputObject $cache -PropertyName 'expiresAtUtc' -DefaultValue '')
    $accessTokenProtected = [string](Get-ObjectPropertyValue -InputObject $cache -PropertyName 'accessToken' -DefaultValue '')
    $refreshTokenProtected = [string](Get-ObjectPropertyValue -InputObject $cache -PropertyName 'refreshToken' -DefaultValue '')

    if (-not [string]::IsNullOrWhiteSpace($expiresAtUtcRaw) -and -not [string]::IsNullOrWhiteSpace($accessTokenProtected)) {
        try {
            $expiresAtUtc = [DateTime]::Parse($expiresAtUtcRaw).ToUniversalTime()
            if ($expiresAtUtc -gt [DateTime]::UtcNow.AddMinutes(5)) {
                $accessToken = Unprotect-LocalSecret -Value $accessTokenProtected
                if (-not [string]::IsNullOrWhiteSpace($accessToken)) {
                    $jwtExpiryUtc = Get-JwtExpiryUtc -AccessToken $accessToken
                    $minValidUntilUtc = [DateTime]::UtcNow.AddMinutes(5)
                    if ($jwtExpiryUtc -and $jwtExpiryUtc -le $minValidUntilUtc) {
                        Write-LogEntry -Level WARN -Message 'Cached delegated access token is already expired/near expiry based on JWT claims; forcing refresh.'
                    }
                    else {
                    Write-LogEntry -Level INFO -Message 'Using cached delegated Graph access token.'
                    return $accessToken
                    }
                }
            }
        }
        catch {
            Write-LogEntry -Level WARN -Message "Existing access-token cache could not be reused. $($_.Exception.Message)"
        }
    }

    if ([string]::IsNullOrWhiteSpace($refreshTokenProtected)) {
        return $null
    }

    try {
        $refreshToken = Unprotect-LocalSecret -Value $refreshTokenProtected
        if ([string]::IsNullOrWhiteSpace($refreshToken)) {
            return $null
        }

        $tokenEndpoint = "https://login.microsoftonline.com/$Tenant/oauth2/v2.0/token"
        $refreshBody = @{
            client_id = $AppId
            grant_type = 'refresh_token'
            refresh_token = $refreshToken
            scope = $Scope
        }

        $response = Invoke-RestMethod -Method POST -Uri $tokenEndpoint -ContentType 'application/x-www-form-urlencoded' -Body $refreshBody -ErrorAction Stop
        if ($response.access_token) {
            Save-DeviceCodeTokenCache -Tenant $Tenant -AppId $AppId -Scope $Scope -TokenResponse $response
            Write-LogEntry -Level INFO -Message 'Refreshed delegated Graph access token from local cache.'
            return [string]$response.access_token
        }
    }
    catch {
        Write-LogEntry -Level WARN -Message "Cached refresh token could not be used. Falling back to interactive login. $($_.Exception.Message)"
    }

    return $null
}

function Get-GraphDelegatedScopes {
    [CmdletBinding()]
    param()

    $scope = $GraphDelegatedScopesBase
    if ($ScriptSettings.IncludeAllGlobalAdminsAsAdmins) {
        $scope = "$scope $GraphDirectoryReadScope"
    }

    return $scope
}

function Get-AccessTokenFromDeviceCode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Tenant,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Scope
    )

    $cachedToken = Get-CachedDeviceCodeAccessToken -Tenant $Tenant -AppId $AppId -Scope $Scope
    if (-not [string]::IsNullOrWhiteSpace($cachedToken)) {
        return $cachedToken
    }

    $deviceCodeEndpoint = "https://login.microsoftonline.com/$Tenant/oauth2/v2.0/devicecode"
    $tokenEndpoint = "https://login.microsoftonline.com/$Tenant/oauth2/v2.0/token"

    $deviceBody = @{
        client_id = $AppId
        scope = $Scope
    }

    $deviceResponse = Invoke-RestMethod -Method POST -Uri $deviceCodeEndpoint -ContentType 'application/x-www-form-urlencoded' -Body $deviceBody -ErrorAction Stop

    if (-not $deviceResponse.device_code) {
        throw 'Device code flow did not return a device_code.'
    }

    if ($deviceResponse.message) {
        Write-Host ''
        Write-Host $deviceResponse.message -ForegroundColor Yellow
        Write-Host ''
    }

    $intervalSec = 5
    if ($deviceResponse.interval -and [int]$deviceResponse.interval -gt 0) {
        $intervalSec = [int]$deviceResponse.interval
    }

    $expiresIn = 900
    if ($deviceResponse.expires_in -and [int]$deviceResponse.expires_in -gt 0) {
        $expiresIn = [int]$deviceResponse.expires_in
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($expiresIn)

    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds $intervalSec

        $tokenBody = @{
            grant_type = 'urn:ietf:params:oauth:grant-type:device_code'
            client_id = $AppId
            device_code = [string]$deviceResponse.device_code
        }

        try {
            $tokenResponse = Invoke-RestMethod -Method POST -Uri $tokenEndpoint -ContentType 'application/x-www-form-urlencoded' -Body $tokenBody -ErrorAction Stop
            if ($tokenResponse.access_token) {
                Save-DeviceCodeTokenCache -Tenant $Tenant -AppId $AppId -Scope $Scope -TokenResponse $tokenResponse
                return [string]$tokenResponse.access_token
            }
        }
        catch {
            $raw = ''
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $raw = [string]$_.ErrorDetails.Message
            }

            $errorCode = ''
            if ($raw) {
                try {
                    $json = $raw | ConvertFrom-Json -ErrorAction Stop
                    $errorCode = [string]$json.error
                }
                catch {
                    $errorCode = ''
                }
            }

            switch ($errorCode) {
                'authorization_pending' { continue }
                'slow_down' {
                    $intervalSec = [Math]::Min($intervalSec + 5, 30)
                    continue
                }
                'authorization_declined' { throw 'Device code sign-in was declined.' }
                'expired_token' { throw 'Device code expired before sign-in completed.' }
                'bad_verification_code' { throw 'Invalid device verification code flow state.' }
                default {
                    $msg = $_.Exception.Message
                    if ($raw) { $msg = $raw }
                    throw "Device code token request failed: $msg"
                }
            }
        }
    }

    throw 'Device code sign-in timed out before token acquisition.'
}

function Resolve-AccessToken {
    [CmdletBinding()]
    param()

    if ($AuthMode -eq 'AccessToken') {
        if ([string]::IsNullOrWhiteSpace($AccessToken) -or $AccessToken -eq 'YOUR_ACCESS_TOKEN_HERE') {
            throw 'AccessToken mode selected, but no valid AccessToken was provided.'
        }

        Write-LogEntry -Level INFO -Message 'Using provided access token.'
        return $AccessToken
    }

    if ($AuthMode -eq 'DeviceCodeDelegated') {
        if ([string]::IsNullOrWhiteSpace($TenantId)) {
            throw 'DeviceCodeDelegated mode requires TenantId.'
        }
        if ([string]::IsNullOrWhiteSpace($ClientId)) {
            throw 'DeviceCodeDelegated mode requires ClientId for a public client app registration with delegated Graph permissions.'
        }

        Write-LogEntry -Level INFO -Message 'Starting REST-only device code sign-in for delegated Graph access token...'
        return Get-AccessTokenFromDeviceCode -Tenant $TenantId -AppId $ClientId -Scope (Get-GraphDelegatedScopes)
    }

    throw "Unsupported AuthMode '$AuthMode'."
}

function Get-GraphHeaders {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Token)

    return @{
        Authorization = "Bearer $Token"
        'Content-Type' = 'application/json'
    }
}

function Invoke-GraphRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'POST', 'PATCH', 'DELETE')][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][hashtable]$Headers,
        [Parameter()][object]$Body
    )

    try {
        if ($PSBoundParameters.ContainsKey('Body')) {
            $json = $Body | ConvertTo-Json -Depth 20
            return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -Body $json -ErrorAction Stop
        }

        return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -ErrorAction Stop
    }
    catch {
        $message = $_.Exception.Message
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $message = $_.ErrorDetails.Message
        }

        throw "Graph call failed. Method=$Method Uri=$Uri Error=$message"
    }
}

function Test-GraphTransientBookingError {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ErrorText)

    if ([string]::IsNullOrWhiteSpace($ErrorText)) {
        return $false
    }

    $t = $ErrorText.ToLowerInvariant()
    if ($t.Contains('"code": "unknownerror"')) { return $true }
    if ($t.Contains('temporarily unavailable')) { return $true }
    if ($t.Contains('timeout')) { return $true }
    if ($t.Contains('429')) { return $true }
    if ($t.Contains('too many requests')) { return $true }
    if ($t.Contains('503')) { return $true }
    if ($t.Contains('504')) { return $true }
    if ($t.Contains('bookings mailbox was not found')) { return $true }
    if ($t.Contains('"code": "notfound"') -and $t.Contains('bookings mailbox')) { return $true }
    return $false
}

function Invoke-GraphRequestWithRetry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'POST', 'PATCH', 'DELETE')][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][hashtable]$Headers,
        [Parameter()][object]$Body,
        [Parameter()][int]$MaxAttempts = 6,
        [Parameter()][int]$InitialDelaySeconds = 2
    )

    if ($MaxAttempts -lt 1) { $MaxAttempts = 1 }
    if ($InitialDelaySeconds -lt 1) { $InitialDelaySeconds = 1 }

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            if ($PSBoundParameters.ContainsKey('Body')) {
                return Invoke-GraphRequest -Method $Method -Uri $Uri -Headers $Headers -Body $Body
            }
            return Invoke-GraphRequest -Method $Method -Uri $Uri -Headers $Headers
        }
        catch {
            $message = [string]$_.Exception.Message
            $isTransient = Test-GraphTransientBookingError -ErrorText $message
            $isLastAttempt = $attempt -ge $MaxAttempts

            if (-not $isTransient -or $isLastAttempt) {
                throw
            }

            $delay = [Math]::Min(($InitialDelaySeconds * [Math]::Pow(2, $attempt - 1)), 20)
            Write-LogEntry -Level WARN -Message "Transient Graph error. Retry $attempt/$MaxAttempts in $delay sec."
            Start-Sleep -Seconds ([int]$delay)
        }
    }
}

function Get-ObjectPropertyValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$InputObject,
        [Parameter(Mandatory)][string]$PropertyName,
        [Parameter()][AllowNull()][object]$DefaultValue = $null
    )

    if ($null -eq $InputObject) {
        return $DefaultValue
    }

    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Contains($PropertyName)) {
            return $InputObject[$PropertyName]
        }
        return $DefaultValue
    }

    $prop = $null
    $matches = @($InputObject.PSObject.Properties.Match($PropertyName))
    if ($matches.Count -gt 0) {
        $prop = $matches[0]
    }

    if ($null -eq $prop) {
        return $DefaultValue
    }

    return $prop.Value
}

function Get-GraphCollection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $results = @()
    $next = $Uri

    while (-not [string]::IsNullOrWhiteSpace($next)) {
        $response = Invoke-GraphRequest -Method GET -Uri $next -Headers $Headers

        $items = Get-ObjectPropertyValue -InputObject $response -PropertyName 'value' -DefaultValue @()
        if ($items) {
            $results += @($items)
        }

        $nextLink = Get-ObjectPropertyValue -InputObject $response -PropertyName '@odata.nextLink' -DefaultValue ''
        $next = [string]$nextLink
    }

    return @($results)
}

function New-BookingBusinessHoursPayload {
    [CmdletBinding()]
    param([Parameter(Mandatory)][array]$BusinessHours)

    $hours = @()
    foreach ($entry in $BusinessHours) {
        $day = [string](Get-ObjectPropertyValue -InputObject $entry -PropertyName 'Day' -DefaultValue '')
        if ([string]::IsNullOrWhiteSpace($day)) {
            continue
        }

        $startTime = Get-ObjectPropertyValue -InputObject $entry -PropertyName 'StartTime' -DefaultValue $null
        $endTime = Get-ObjectPropertyValue -InputObject $entry -PropertyName 'EndTime' -DefaultValue $null
        $timeSlots = @()

        if (-not [string]::IsNullOrWhiteSpace([string]$startTime) -and -not [string]::IsNullOrWhiteSpace([string]$endTime)) {
            $timeSlots += @{
                startTime = [string]$startTime
                endTime   = [string]$endTime
            }
        }

        $hours += @{
            day       = $day.ToLowerInvariant()
            timeSlots = @($timeSlots)
        }
    }

    return @($hours)
}

function Sync-BookingBusinessConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BusinessId,
        [Parameter(Mandatory)][hashtable]$Template,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $body = @{
        defaultCurrencyIso = $Template.Business.DefaultCurrencyIso
        languageTag        = $Template.Business.LanguageTag
        businessHours      = New-BookingBusinessHoursPayload -BusinessHours $Template.Business.BusinessHours
    }

    if ($Template.Business.Phone) { $body.phone = $Template.Business.Phone }
    if ($Template.Business.WebSiteUrl) { $body.webSiteUrl = $Template.Business.WebSiteUrl }
    if ($Template.Business.Address) { $body.address = $Template.Business.Address }

    $encoded = [uri]::EscapeDataString($BusinessId)
    $uri = "$GraphBaseUrl/solutions/bookingBusinesses/$encoded"
    [void](Invoke-GraphRequestWithRetry -Method PATCH -Uri $uri -Headers $Headers -Body $body -MaxAttempts 7 -InitialDelaySeconds 2)
}

function Sync-BookingStaffMemberConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BusinessId,
        [Parameter(Mandatory)][string]$StaffMemberId,
        [Parameter(Mandatory)][hashtable]$Template,
        [Parameter(Mandatory)][hashtable]$Headers,
        [Parameter()][AllowNull()][hashtable]$WorkingHours = $null,
        [Parameter()][AllowNull()][string]$StaffTimeZone = $null
    )

    $body = @{
        role                                     = $Template.Staff.Role
        availabilityIsAffectedByPersonalCalendar = $Template.Staff.AvailabilityIsAffectedByPersonalCalendar
        isEmailNotificationEnabled               = $Template.Staff.IsEmailNotificationEnabled
    }

    if ($WorkingHours -and $WorkingHours.ContainsKey('WorkingHours') -and $WorkingHours.WorkingHours) {
        $body.useBusinessHours = $false
        $body.workingHours = @($WorkingHours.WorkingHours)
    }
    else {
        $body.useBusinessHours = $Template.Staff.UseBusinessHours
    }

    $resolvedTimeZone = if (-not [string]::IsNullOrWhiteSpace($StaffTimeZone)) { $StaffTimeZone } else { $Template.Staff.TimeZone }
    if ($resolvedTimeZone) {
        $body.timeZone = $resolvedTimeZone
    }

    $encodedBusinessId = [uri]::EscapeDataString($BusinessId)
    $encodedStaffId = [uri]::EscapeDataString($StaffMemberId)
    $uri = "$GraphBaseUrl/solutions/bookingBusinesses/$encodedBusinessId/staffMembers/$encodedStaffId"
    [void](Invoke-GraphRequestWithRetry -Method PATCH -Uri $uri -Headers $Headers -Body $body -MaxAttempts 7 -InitialDelaySeconds 2)
}

function Convert-MailboxWorkingHoursToBookingWorkHours {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$WorkingHours)

    if ($null -eq $WorkingHours) {
        return $null
    }

    $daysOfWeek = @(Get-ObjectPropertyValue -InputObject $WorkingHours -PropertyName 'daysOfWeek' -DefaultValue @())
    $startTime = [string](Get-ObjectPropertyValue -InputObject $WorkingHours -PropertyName 'startTime' -DefaultValue '')
    $endTime = [string](Get-ObjectPropertyValue -InputObject $WorkingHours -PropertyName 'endTime' -DefaultValue '')
    $timeZoneObject = Get-ObjectPropertyValue -InputObject $WorkingHours -PropertyName 'timeZone' -DefaultValue $null
    $timeZoneName = [string](Get-ObjectPropertyValue -InputObject $timeZoneObject -PropertyName 'name' -DefaultValue '')

    if ($daysOfWeek.Count -eq 0 -or [string]::IsNullOrWhiteSpace($startTime) -or [string]::IsNullOrWhiteSpace($endTime)) {
        return $null
    }

    $dayLookup = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($day in $daysOfWeek) {
        if (-not [string]::IsNullOrWhiteSpace([string]$day)) {
            [void]$dayLookup.Add(([string]$day).ToLowerInvariant())
        }
    }

    $allDays = @('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')
    $bookingHours = @()
    foreach ($dayName in $allDays) {
        $timeSlots = @()
        if ($dayLookup.Contains($dayName)) {
            $timeSlots += @{
                startTime = $startTime
                endTime   = $endTime
            }
        }

        $bookingHours += @{
            day       = $dayName
            timeSlots = @($timeSlots)
        }
    }

    return @{
        WorkingHours = @($bookingHours)
        TimeZone     = $timeZoneName
    }
}

function Get-UserMailboxWorkingHours {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][psobject]$User,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    if (-not $ScriptSettings.UseUserMailboxWorkingHours) {
        return $null
    }

    $userId = [string](Get-ObjectPropertyValue -InputObject $User -PropertyName 'id' -DefaultValue '')
    if ([string]::IsNullOrWhiteSpace($userId)) {
        return $null
    }

    $encodedUserId = [uri]::EscapeDataString($userId)
    $uri = "$GraphBaseUrl/users/$encodedUserId/mailboxSettings/workingHours"

    try {
        $response = Invoke-GraphRequestWithRetry -Method GET -Uri $uri -Headers $Headers -MaxAttempts 4 -InitialDelaySeconds 2
        $converted = Convert-MailboxWorkingHoursToBookingWorkHours -WorkingHours $response
        if ($converted -and $converted.WorkingHours) {
            return $converted
        }
    }
    catch {
        Write-LogEntry -Level WARN -Message "Could not read mailbox working hours for '$($User.userPrincipalName)'. Falling back to business hours. $($_.Exception.Message)"
    }

    return $null
}

function Get-EligibleUsers {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Headers)

    Write-LogEntry -Level INFO -Message 'Fetching active licensed users from Microsoft Graph...'

    $uri = "$GraphBaseUrl/users?`$select=id,displayName,userPrincipalName,mail,accountEnabled,assignedLicenses&`$top=999"
    $users = Get-GraphCollection -Uri $uri -Headers $Headers

    $eligible = $users | Where-Object {
        $_.accountEnabled -eq $true -and
        $_.assignedLicenses -and
        $_.assignedLicenses.Count -gt 0
    }

    if ($TargetUserPrincipalNames.Count -gt 0) {
        $lookup = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($upn in $TargetUserPrincipalNames) {
            if (-not [string]::IsNullOrWhiteSpace($upn)) {
                [void]$lookup.Add($upn.Trim())
            }
        }

        $eligible = $eligible | Where-Object { $lookup.Contains($_.userPrincipalName) }
    }

    if ($ExcludeUserPrincipalNames.Count -gt 0) {
        $excludeLookup = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($upn in $ExcludeUserPrincipalNames) {
            if (-not [string]::IsNullOrWhiteSpace($upn)) {
                [void]$excludeLookup.Add($upn.Trim())
            }
        }

        $eligible = $eligible | Where-Object { -not $excludeLookup.Contains($_.userPrincipalName) }
    }

    return @($eligible)
}

function Get-UserByUpn {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$UserPrincipalName,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    if ([string]::IsNullOrWhiteSpace($UserPrincipalName)) {
        return $null
    }

    $encoded = [uri]::EscapeDataString($UserPrincipalName.Trim())
    $uri = "$GraphBaseUrl/users/${encoded}?`$select=id,displayName,userPrincipalName,mail,accountEnabled"

    try {
        return Invoke-GraphRequest -Method GET -Uri $uri -Headers $Headers
    }
    catch {
        Write-LogEntry -Level WARN -Message "Unable to resolve observer account '$UserPrincipalName'. $($_.Exception.Message)"
        return $null
    }
}

function Get-BookingIdentityCandidates {
    [CmdletBinding()]
    param([Parameter(Mandatory)][psobject]$User)

    $values = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    $upn = [string](Get-ObjectPropertyValue -InputObject $User -PropertyName 'userPrincipalName' -DefaultValue '')
    $mail = [string](Get-ObjectPropertyValue -InputObject $User -PropertyName 'mail' -DefaultValue '')

    if (-not [string]::IsNullOrWhiteSpace($upn)) {
        [void]$values.Add($upn.Trim())
    }
    if (-not [string]::IsNullOrWhiteSpace($mail)) {
        [void]$values.Add($mail.Trim())
    }

    return @($values)
}

function Get-MatchingBookingStaffMember {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][array]$StaffMembers,
        [Parameter(Mandatory)][string[]]$IdentityCandidates
    )

    if (-not $StaffMembers -or $StaffMembers.Count -eq 0) {
        return $null
    }

    $candidateSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $IdentityCandidates) {
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
            [void]$candidateSet.Add(([string]$candidate).Trim())
        }
    }

    if ($candidateSet.Count -eq 0) {
        return $null
    }

    foreach ($staffMember in $StaffMembers) {
        $emailAddress = [string](Get-ObjectPropertyValue -InputObject $staffMember -PropertyName 'emailAddress' -DefaultValue '')
        if (-not [string]::IsNullOrWhiteSpace($emailAddress) -and $candidateSet.Contains($emailAddress.Trim())) {
            return $staffMember
        }
    }

    return $null
}

function Get-GlobalAdminUpns {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Headers)

    $roleTemplateId = '62e90394-69f5-4237-9190-012177145e10'
    $rolesUri = "$GraphBaseUrl/directoryRoles?`$filter=roleTemplateId eq '$roleTemplateId'&`$select=id"

    try {
        $roles = Get-GraphCollection -Uri $rolesUri -Headers $Headers
        if (-not $roles -or $roles.Count -eq 0) {
            Write-LogEntry -Level WARN -Message 'No active Global Administrator directory role was found for discovery.'
            return @()
        }

        $upnSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($role in $roles) {
            $roleId = [string](Get-ObjectPropertyValue -InputObject $role -PropertyName 'id' -DefaultValue '')
            if ([string]::IsNullOrWhiteSpace($roleId)) {
                continue
            }

            $membersUri = "$GraphBaseUrl/directoryRoles/$([uri]::EscapeDataString($roleId))/members/microsoft.graph.user?`$select=userPrincipalName"
            $members = Get-GraphCollection -Uri $membersUri -Headers $Headers
            foreach ($member in $members) {
                $upn = [string](Get-ObjectPropertyValue -InputObject $member -PropertyName 'userPrincipalName' -DefaultValue '')
                if (-not [string]::IsNullOrWhiteSpace($upn)) {
                    [void]$upnSet.Add($upn.Trim())
                }
            }
        }

        return @($upnSet)
    }
    catch {
        Write-LogEntry -Level WARN -Message "Unable to discover Global Administrators. Ensure Directory.Read.All is granted/consented. $($_.Exception.Message)"
        return @()
    }
}

function Get-BookingAccessRolePriority {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Role)

    switch ($Role) {
        'administrator' { return 3 }
        'scheduler' { return 2 }
        'viewer' { return 1 }
        default { return 0 }
    }
}

function Add-BookingAccessAssignment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Assignments,
        [Parameter(Mandatory)][psobject]$User,
        [Parameter(Mandatory)][string]$Role
    )

    $email = if (-not [string]::IsNullOrWhiteSpace([string]$User.userPrincipalName)) { [string]$User.userPrincipalName } else { [string]$User.mail }
    if ([string]::IsNullOrWhiteSpace($email)) {
        return
    }

    $key = $email.Trim().ToLowerInvariant()
    $newPriority = Get-BookingAccessRolePriority -Role $Role
    if ($Assignments.ContainsKey($key)) {
        $existingPriority = Get-BookingAccessRolePriority -Role ([string]$Assignments[$key].Role)
        if ($existingPriority -ge $newPriority) {
            return
        }
    }

    $Assignments[$key] = [pscustomobject]@{
        User = $User
        Role = $Role
    }
}

function Resolve-BookingAccessUsers {
    [CmdletBinding()]
    param(
        [Parameter()][AllowEmptyCollection()][string[]]$UserPrincipalNames = @(),
        [Parameter(Mandatory)][string]$Role,
        [Parameter(Mandatory)][hashtable]$Assignments,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    foreach ($upn in $UserPrincipalNames) {
        if ([string]::IsNullOrWhiteSpace([string]$upn)) {
            continue
        }

        $resolvedUser = Get-UserByUpn -UserPrincipalName ([string]$upn).Trim() -Headers $Headers
        if ($resolvedUser) {
            Add-BookingAccessAssignment -Assignments $Assignments -User $resolvedUser -Role $Role
        }
    }
}

function Get-SharedAccessAssignments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][array]$EligibleUsers,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    if (-not $ScriptSettings.AddSharedAccessMembers) {
        return @()
    }

    $assignments = @{}

    $adminUpns = @($ScriptSettings.BookingAdminUpns) + @($BookingAdminUpns)

    Resolve-BookingAccessUsers -UserPrincipalNames $adminUpns -Role 'administrator' -Assignments $assignments -Headers $Headers
    Resolve-BookingAccessUsers -UserPrincipalNames @($ScriptSettings.BookingEditorUpns) -Role 'scheduler' -Assignments $assignments -Headers $Headers
    Resolve-BookingAccessUsers -UserPrincipalNames @($ScriptSettings.BookingViewerUpns) -Role 'viewer' -Assignments $assignments -Headers $Headers

    if ($ScriptSettings.IncludeAllGlobalAdminsAsAdmins) {
        $globalAdmins = Get-GlobalAdminUpns -Headers $Headers
        foreach ($upn in $globalAdmins) {
            if ([string]::IsNullOrWhiteSpace([string]$upn)) {
                continue
            }

            $resolvedUser = Get-UserByUpn -UserPrincipalName ([string]$upn).Trim() -Headers $Headers
            if ($resolvedUser) {
                Add-BookingAccessAssignment -Assignments $assignments -User $resolvedUser -Role 'administrator'
            }
        }
    }

    if ($ScriptSettings.IncludeProvisionedUsersAsEditors) {
        foreach ($eligibleUser in $EligibleUsers) {
            Add-BookingAccessAssignment -Assignments $assignments -User $eligibleUser -Role 'scheduler'
        }
    }

    return @($assignments.Values)
}

function Get-AllBookingBusinesses {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Headers)

    $uri = "$GraphBaseUrl/solutions/bookingBusinesses"
    $response = Invoke-GraphRequest -Method GET -Uri $uri -Headers $Headers
    $items = Get-ObjectPropertyValue -InputObject $response -PropertyName 'value' -DefaultValue @()
    if ($items) {
        return @($items)
    }

    return @()
}

function New-BookingBusinessFromTemplate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][psobject]$User,
        [Parameter(Mandatory)][hashtable]$Template,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $displayName = [string]::Format($Template.Business.DisplayNameFormat, $User.displayName)
    $email = if (-not [string]::IsNullOrWhiteSpace($User.mail)) { $User.mail } else { $User.userPrincipalName }

    $body = @{
        displayName = $displayName
        email = $email
        defaultCurrencyIso = $Template.Business.DefaultCurrencyIso
    }

    if ($Template.Business.Phone) { $body.phone = $Template.Business.Phone }
    if ($Template.Business.WebSiteUrl) { $body.webSiteUrl = $Template.Business.WebSiteUrl }
    if ($Template.Business.Address) { $body.address = $Template.Business.Address }
    if ($Template.Business.LanguageTag) { $body.languageTag = $Template.Business.LanguageTag }
    if ($Template.Business.BusinessHours) { $body.businessHours = New-BookingBusinessHoursPayload -BusinessHours $Template.Business.BusinessHours }

    $uri = "$GraphBaseUrl/solutions/bookingBusinesses"
    return Invoke-GraphRequest -Method POST -Uri $uri -Headers $Headers -Body $body
}

function Get-BookingBusinessByDisplayName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][array]$Businesses,
        [Parameter(Mandatory)][string]$DisplayName
    )

    return $Businesses | Where-Object { $_.displayName -eq $DisplayName } | Select-Object -First 1
}

function Get-BookingStaffMembers {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BusinessId,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $encoded = [uri]::EscapeDataString($BusinessId)
    $uri = "$GraphBaseUrl/solutions/bookingBusinesses/$encoded/staffMembers"
    $response = Invoke-GraphRequestWithRetry -Method GET -Uri $uri -Headers $Headers -MaxAttempts 8 -InitialDelaySeconds 2
    $items = Get-ObjectPropertyValue -InputObject $response -PropertyName 'value' -DefaultValue @()
    if ($items) {
        return @($items)
    }

    return @()
}

function Get-BookingServices {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BusinessId,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $encoded = [uri]::EscapeDataString($BusinessId)
    $uri = "$GraphBaseUrl/solutions/bookingBusinesses/$encoded/services"
    $response = Invoke-GraphRequestWithRetry -Method GET -Uri $uri -Headers $Headers -MaxAttempts 8 -InitialDelaySeconds 2
    $items = Get-ObjectPropertyValue -InputObject $response -PropertyName 'value' -DefaultValue @()
    if ($items) {
        return @($items)
    }

    return @()
}

function New-BookingStaffMemberIfMissing {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BusinessId,
        [Parameter(Mandatory)][psobject]$User,
        [Parameter(Mandatory)][hashtable]$Template,
        [Parameter(Mandatory)][hashtable]$Headers,
        [Parameter()][AllowNull()][hashtable]$WorkingHours = $null
    )

    $identityCandidates = Get-BookingIdentityCandidates -User $User
    $email = if (-not [string]::IsNullOrWhiteSpace($User.mail)) { $User.mail } else { $User.userPrincipalName }

    $staffMembers = Get-BookingStaffMembers -BusinessId $BusinessId -Headers $Headers
    $existing = Get-MatchingBookingStaffMember -StaffMembers $staffMembers -IdentityCandidates $identityCandidates

    if ($existing) {
        Write-LogEntry -Level INFO -Message "Staff member already exists for $email"
        if (-not [string]::IsNullOrWhiteSpace([string]$existing.id)) {
            $staffTimeZone = if ($WorkingHours -and -not [string]::IsNullOrWhiteSpace([string]$WorkingHours.TimeZone)) { [string]$WorkingHours.TimeZone } else { $null }
            Sync-BookingStaffMemberConfiguration -BusinessId $BusinessId -StaffMemberId ([string]$existing.id) -Template $Template -Headers $Headers -WorkingHours $WorkingHours -StaffTimeZone $staffTimeZone
        }
        return $existing
    }

    $body = @{
        '@odata.type' = '#microsoft.graph.bookingStaffMember'
        displayName = $User.displayName
        emailAddress = $email
        role = $Template.Staff.Role
        availabilityIsAffectedByPersonalCalendar = $Template.Staff.AvailabilityIsAffectedByPersonalCalendar
        isEmailNotificationEnabled = $Template.Staff.IsEmailNotificationEnabled
    }

    if ($WorkingHours -and $WorkingHours.ContainsKey('WorkingHours') -and $WorkingHours.WorkingHours) {
        $body.useBusinessHours = $false
        $body.workingHours = @($WorkingHours.WorkingHours)
    }
    else {
        $body.useBusinessHours = $Template.Staff.UseBusinessHours
    }

    $staffTimeZone = if ($WorkingHours -and -not [string]::IsNullOrWhiteSpace([string]$WorkingHours.TimeZone)) { [string]$WorkingHours.TimeZone } else { $Template.Staff.TimeZone }
    if ($staffTimeZone) {
        $body.timeZone = $staffTimeZone
    }

    $encoded = [uri]::EscapeDataString($BusinessId)
    $uri = "$GraphBaseUrl/solutions/bookingBusinesses/$encoded/staffMembers"
    $created = Invoke-GraphRequestWithRetry -Method POST -Uri $uri -Headers $Headers -Body $body -MaxAttempts 7 -InitialDelaySeconds 2
    if ($created -and -not [string]::IsNullOrWhiteSpace([string]$created.id)) {
        Sync-BookingStaffMemberConfiguration -BusinessId $BusinessId -StaffMemberId ([string]$created.id) -Template $Template -Headers $Headers -WorkingHours $WorkingHours -StaffTimeZone $staffTimeZone
    }

    Write-LogEntry -Level SUCCESS -Message "Created staff member for $email"
    return $created
}

function Ensure-BookingAccessMember {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BusinessId,
        [Parameter(Mandatory)][psobject]$AccessUser,
        [Parameter(Mandatory)][string]$Role,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $identityCandidates = Get-BookingIdentityCandidates -User $AccessUser
    $email = if (-not [string]::IsNullOrWhiteSpace([string]$AccessUser.mail)) { [string]$AccessUser.mail } else { [string]$AccessUser.userPrincipalName }
    if ([string]::IsNullOrWhiteSpace($email)) {
        return
    }

    $staffMembers = Get-BookingStaffMembers -BusinessId $BusinessId -Headers $Headers
    $existing = Get-MatchingBookingStaffMember -StaffMembers $staffMembers -IdentityCandidates $identityCandidates

    if ($existing) {
        $existingRole = [string](Get-ObjectPropertyValue -InputObject $existing -PropertyName 'role' -DefaultValue '')
        if ($existingRole -ne $Role) {
            $body = @{
                role = $Role
                useBusinessHours = $true
                availabilityIsAffectedByPersonalCalendar = $false
                isEmailNotificationEnabled = $false
            }

            $encodedBusinessId = [uri]::EscapeDataString($BusinessId)
            $encodedStaffId = [uri]::EscapeDataString([string]$existing.id)
            $patchUri = "$GraphBaseUrl/solutions/bookingBusinesses/$encodedBusinessId/staffMembers/$encodedStaffId"
            [void](Invoke-GraphRequestWithRetry -Method PATCH -Uri $patchUri -Headers $Headers -Body $body -MaxAttempts 6 -InitialDelaySeconds 2)
            Write-LogEntry -Level SUCCESS -Message "Updated shared-access member '$email' to role '$Role' in business '$BusinessId'."
        }
        return
    }

    $body = @{
        '@odata.type' = '#microsoft.graph.bookingStaffMember'
        displayName = [string]$AccessUser.displayName
        emailAddress = $email
        role = $Role
        useBusinessHours = $true
        availabilityIsAffectedByPersonalCalendar = $false
        isEmailNotificationEnabled = $false
    }

    $encoded = [uri]::EscapeDataString($BusinessId)
    $uri = "$GraphBaseUrl/solutions/bookingBusinesses/$encoded/staffMembers"
    [void](Invoke-GraphRequestWithRetry -Method POST -Uri $uri -Headers $Headers -Body $body -MaxAttempts 6 -InitialDelaySeconds 2)

    Write-LogEntry -Level SUCCESS -Message "Added shared-access member '$email' to business '$BusinessId' with role '$Role'."
}

function Ensure-SharedAccessMembers {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BusinessId,
        [Parameter(Mandatory)][array]$AccessAssignments,
        [Parameter(Mandatory)][hashtable]$Headers,
        [Parameter(Mandatory)][string]$PrimaryStaffEmail
    )

    foreach ($assignment in $AccessAssignments) {
        $memberUser = $assignment.User
        $memberRole = [string]$assignment.Role
        $memberEmail = if (-not [string]::IsNullOrWhiteSpace([string]$memberUser.mail)) { [string]$memberUser.mail } else { [string]$memberUser.userPrincipalName }
        if ([string]::IsNullOrWhiteSpace($memberEmail)) {
            continue
        }

        # The primary engineer remains the admin of their own business.
        if (-not [string]::IsNullOrWhiteSpace($PrimaryStaffEmail) -and $memberEmail.Equals($PrimaryStaffEmail, [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }

        Ensure-BookingAccessMember -BusinessId $BusinessId -AccessUser $memberUser -Role $memberRole -Headers $Headers
    }
}

function New-BookingServiceIfMissing {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BusinessId,
        [Parameter(Mandatory)][hashtable]$ServiceTemplate,
        [Parameter(Mandatory)][string]$StaffMemberId,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $existing = Get-BookingServices -BusinessId $BusinessId -Headers $Headers |
        Where-Object { $_.displayName -eq $ServiceTemplate.DisplayName } |
        Select-Object -First 1

    if ($existing) {
        Write-LogEntry -Level INFO -Message "Service already exists: $($ServiceTemplate.DisplayName)"
        return $existing
    }

    $body = @{
        displayName = $ServiceTemplate.DisplayName
        description = $ServiceTemplate.Description
        defaultDuration = $ServiceTemplate.DefaultDuration
        preBuffer = $ServiceTemplate.PreBuffer
        postBuffer = $ServiceTemplate.PostBuffer
        isLocationOnline = $ServiceTemplate.IsLocationOnline
        isCustomerAllowedToManageBooking = $ServiceTemplate.IsCustomerAllowedToManageBooking
        isHiddenFromCustomers = $ServiceTemplate.IsHiddenFromCustomers
        smsNotificationsEnabled = $ServiceTemplate.SmsNotificationsEnabled
        isAnonymousJoinEnabled = $ServiceTemplate.IsAnonymousJoinEnabled
        staffMemberIds = @($StaffMemberId)
        schedulingPolicy = @{
            allowStaffSelection = $ServiceTemplate.SchedulingPolicy.AllowStaffSelection
            maximumAdvance = $ServiceTemplate.SchedulingPolicy.MaximumAdvance
            minimumLeadTime = $ServiceTemplate.SchedulingPolicy.MinimumLeadTime
            sendConfirmationsToOwner = $ServiceTemplate.SchedulingPolicy.SendConfirmationsToOwner
            timeSlotInterval = $ServiceTemplate.SchedulingPolicy.TimeSlotInterval
            isMeetingInviteToCustomersEnabled = $ServiceTemplate.SchedulingPolicy.IsMeetingInviteToCustomersEnabled
        }
    }

    $encoded = [uri]::EscapeDataString($BusinessId)
    $uri = "$GraphBaseUrl/solutions/bookingBusinesses/$encoded/services"
    $created = Invoke-GraphRequestWithRetry -Method POST -Uri $uri -Headers $Headers -Body $body -MaxAttempts 7 -InitialDelaySeconds 2

    Write-LogEntry -Level SUCCESS -Message "Created service: $($ServiceTemplate.DisplayName)"
    return $created
}

function Publish-BookingBusiness {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BusinessId,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $encoded = [uri]::EscapeDataString($BusinessId)
    $uri = "$GraphBaseUrl/solutions/bookingBusinesses/$encoded/publish"

    try {
        [void](Invoke-GraphRequest -Method POST -Uri $uri -Headers $Headers -Body @{})
        Write-LogEntry -Level SUCCESS -Message "Published booking business '$BusinessId'."
    }
    catch {
        Write-LogEntry -Level WARN -Message "Publish failed for '$BusinessId'. Continuing. $($_.Exception.Message)"
    }
}

function New-ParentDirectory {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    $dir = [IO.Path]::GetDirectoryName($full)
    if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
        [void](New-Item -ItemType Directory -Path $dir -Force)
    }
}

function Export-TamperMonkeyArtifacts {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][array]$Rows,
        [Parameter(Mandatory)][string]$CsvPath
    )

    New-ParentDirectory -Path $CsvPath

    $Rows |
        Select-Object userPrincipalName, engineerName, pullDownDescription, linkTextHtml, bookingLink |
        Export-Csv -LiteralPath $CsvPath -NoTypeInformation -Encoding UTF8
}

function Get-AdminAuditExpectations {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Headers)

    $resolved = @()
    $inputUpns = @($ScriptSettings.BookingAdminUpns) + @($BookingAdminUpns)
    $seen = @{}

    foreach ($upn in $inputUpns) {
        $candidate = [string]$upn
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }

        $candidate = $candidate.Trim()
        $normalized = $candidate.ToLowerInvariant()
        if ($seen.ContainsKey($normalized)) {
            continue
        }
        $seen[$normalized] = $true

        $user = Get-UserByUpn -UserPrincipalName $candidate -Headers $Headers
        if ($user) {
            $resolved += [pscustomobject]@{
                UserPrincipalName  = [string]$user.userPrincipalName
                DisplayName        = [string]$user.displayName
                IdentityCandidates = @(Get-BookingIdentityCandidates -User $user)
            }
            continue
        }

        $resolved += [pscustomobject]@{
            UserPrincipalName  = $candidate
            DisplayName        = $candidate
            IdentityCandidates = @($candidate)
        }
    }

    return @($resolved)
}

function Export-BookingAccessAudit {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][array]$Businesses,
        [Parameter(Mandatory)][hashtable]$Headers,
        [Parameter(Mandatory)][array]$ExpectedAdmins,
        [Parameter(Mandatory)][string]$CsvPath
    )

    $rows = New-Object System.Collections.Generic.List[object]
    $missingAdmins = New-Object System.Collections.Generic.List[object]

    foreach ($business in $Businesses) {
        $businessId = [string](Get-ObjectPropertyValue -InputObject $business -PropertyName 'id' -DefaultValue '')
        if ([string]::IsNullOrWhiteSpace($businessId)) {
            continue
        }

        $businessDisplayName = [string](Get-ObjectPropertyValue -InputObject $business -PropertyName 'displayName' -DefaultValue '')
        $businessEmail = [string](Get-ObjectPropertyValue -InputObject $business -PropertyName 'email' -DefaultValue '')
        $businessPublicUrl = [string](Get-ObjectPropertyValue -InputObject $business -PropertyName 'publicUrl' -DefaultValue '')

        try {
            $staffMembers = Get-BookingStaffMembers -BusinessId $businessId -Headers $Headers
        }
        catch {
            Write-LogEntry -Level WARN -Message "Skipping access audit for business '$businessDisplayName' ($businessId). Could not read staff members. $($_.Exception.Message)"
            continue
        }
        $adminEmails = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

        foreach ($staff in $staffMembers) {
            $staffEmail = [string](Get-ObjectPropertyValue -InputObject $staff -PropertyName 'emailAddress' -DefaultValue '')
            $staffRole = [string](Get-ObjectPropertyValue -InputObject $staff -PropertyName 'role' -DefaultValue '')

            if ($staffRole -eq 'administrator' -and -not [string]::IsNullOrWhiteSpace($staffEmail)) {
                [void]$adminEmails.Add($staffEmail.Trim())
            }

            [void]$rows.Add([pscustomobject]@{
                businessDisplayName   = $businessDisplayName
                businessId            = $businessId
                businessEmail         = $businessEmail
                businessPublicUrl     = $businessPublicUrl
                staffDisplayName      = [string](Get-ObjectPropertyValue -InputObject $staff -PropertyName 'displayName' -DefaultValue '')
                staffEmailAddress     = $staffEmail
                staffRole             = $staffRole
                staffId               = [string](Get-ObjectPropertyValue -InputObject $staff -PropertyName 'id' -DefaultValue '')
                staffTimeZone         = [string](Get-ObjectPropertyValue -InputObject $staff -PropertyName 'timeZone' -DefaultValue '')
                staffUseBusinessHours = [bool](Get-ObjectPropertyValue -InputObject $staff -PropertyName 'useBusinessHours' -DefaultValue $true)
            })
        }

        foreach ($expectedAdmin in $ExpectedAdmins) {
            $adminUpn = [string](Get-ObjectPropertyValue -InputObject $expectedAdmin -PropertyName 'UserPrincipalName' -DefaultValue '')
            $adminName = [string](Get-ObjectPropertyValue -InputObject $expectedAdmin -PropertyName 'DisplayName' -DefaultValue '')
            $identityCandidates = @(Get-ObjectPropertyValue -InputObject $expectedAdmin -PropertyName 'IdentityCandidates' -DefaultValue @())

            if ([string]::IsNullOrWhiteSpace($adminUpn)) {
                continue
            }

            $foundAdmin = $false
            foreach ($identity in $identityCandidates) {
                if ([string]::IsNullOrWhiteSpace([string]$identity)) {
                    continue
                }

                if ($adminEmails.Contains(([string]$identity).Trim())) {
                    $foundAdmin = $true
                    break
                }
            }

            if (-not $foundAdmin) {
                $expectedDisplay = if ([string]::IsNullOrWhiteSpace($adminName)) { $adminUpn } else { "$adminName <$adminUpn>" }
                [void]$missingAdmins.Add([pscustomobject]@{
                    businessDisplayName = $businessDisplayName
                    businessId          = $businessId
                    expectedAdmin       = $expectedDisplay
                })
            }
        }
    }

    New-ParentDirectory -Path $CsvPath
    @($rows) |
        Sort-Object businessDisplayName, staffRole, staffEmailAddress |
        Export-Csv -LiteralPath $CsvPath -NoTypeInformation -Encoding UTF8

    return @($missingAdmins)
}

# ============================================================================
# MAIN
# ============================================================================

Write-LogEntry -Level INFO -Message 'Starting Bookings provisioning...'

$token = Resolve-AccessToken
$headers = Get-GraphHeaders -Token $token

$users = Get-EligibleUsers -Headers $headers
if (-not $users -or $users.Count -eq 0) {
    throw 'No eligible users found for provisioning.'
}

Write-LogEntry -Level INFO -Message "Eligible users to process: $($users.Count)"

$sharedAccessAssignments = Get-SharedAccessAssignments -EligibleUsers $users -Headers $headers
if ($ScriptSettings.AddSharedAccessMembers) {
    Write-LogEntry -Level INFO -Message "Shared access assignments resolved: $($sharedAccessAssignments.Count)"
}

$allBusinesses = Get-AllBookingBusinesses -Headers $headers
Write-LogEntry -Level INFO -Message "Existing booking businesses found: $($allBusinesses.Count)"

$exportRows = New-Object System.Collections.Generic.List[object]

foreach ($user in $users) {
    try {
        $businessDisplayName = [string]::Format($ProvisioningTemplate.Business.DisplayNameFormat, $user.displayName)
        Write-LogEntry -Level INFO -Message "Processing user '$($user.displayName)' <$($user.userPrincipalName)>"

        $business = Get-BookingBusinessByDisplayName -Businesses $allBusinesses -DisplayName $businessDisplayName
        if (-not $business) {
            $business = New-BookingBusinessFromTemplate -User $user -Template $ProvisioningTemplate -Headers $headers
            $allBusinesses += $business
            Write-LogEntry -Level SUCCESS -Message "Created business '$businessDisplayName'."
        }
        else {
            Write-LogEntry -Level INFO -Message "Business already exists: '$businessDisplayName'."
        }

        $businessId = [string]$business.id
        if ([string]::IsNullOrWhiteSpace($businessId)) {
            throw "Business id is empty for '$businessDisplayName'."
        }

        Sync-BookingBusinessConfiguration -BusinessId $businessId -Template $ProvisioningTemplate -Headers $headers

        $staffWorkingHours = Get-UserMailboxWorkingHours -User $user -Headers $headers
        if ($staffWorkingHours -and $staffWorkingHours.WorkingHours) {
            $staffTimeZone = if (-not [string]::IsNullOrWhiteSpace([string]$staffWorkingHours.TimeZone)) { [string]$staffWorkingHours.TimeZone } else { $ProvisioningTemplate.Staff.TimeZone }
            Write-LogEntry -Level INFO -Message "Using mailbox working hours for '$($user.userPrincipalName)' in time zone '$staffTimeZone'."
        }
        elseif ($ScriptSettings.UseUserMailboxWorkingHours) {
            Write-LogEntry -Level WARN -Message "No mailbox working hours found for '$($user.userPrincipalName)'. Using business hours fallback."
        }

        $staff = New-BookingStaffMemberIfMissing -BusinessId $businessId -User $user -Template $ProvisioningTemplate -Headers $headers -WorkingHours $staffWorkingHours
        if (-not $staff -or [string]::IsNullOrWhiteSpace([string]$staff.id)) {
            throw "Failed to resolve/create staff member for '$($user.userPrincipalName)'."
        }

        if ($ScriptSettings.AddSharedAccessMembers -and $sharedAccessAssignments.Count -gt 0) {
            $primaryStaffEmail = if (-not [string]::IsNullOrWhiteSpace([string]$user.mail)) { [string]$user.mail } else { [string]$user.userPrincipalName }
            Ensure-SharedAccessMembers -BusinessId $businessId -AccessAssignments $sharedAccessAssignments -Headers $headers -PrimaryStaffEmail $primaryStaffEmail
        }

        foreach ($serviceTemplate in $ProvisioningTemplate.Services) {
            [void](New-BookingServiceIfMissing -BusinessId $businessId -ServiceTemplate $serviceTemplate -StaffMemberId ([string]$staff.id) -Headers $headers)
        }

        if (-not $SkipPublish) {
            Publish-BookingBusiness -BusinessId $businessId -Headers $headers
        }

        # Refresh services to capture latest webUrl values.
        $services = Get-BookingServices -BusinessId $businessId -Headers $headers

        foreach ($serviceTemplate in $ProvisioningTemplate.Services) {
            $service = $services | Where-Object { $_.displayName -eq $serviceTemplate.DisplayName } | Select-Object -First 1
            $bookingUrl = if ($service -and -not [string]::IsNullOrWhiteSpace([string]$service.webUrl)) { [string]$service.webUrl } else { '' }

            $pullDownDescription = [string]::Format($TamperMonkeyTemplate.PullDownDescriptionFormat, $serviceTemplate.DisplayName, $user.displayName)
            $linkTextHtml = [string]::Format($TamperMonkeyTemplate.LinkTextHtmlFormat, $serviceTemplate.DisplayName, $user.displayName)

            [void]$exportRows.Add([pscustomobject]@{
                userPrincipalName = [string]$user.userPrincipalName
                engineerName = [string]$user.displayName
                pullDownDescription = $pullDownDescription
                linkTextHtml = $linkTextHtml
                bookingLink = $bookingUrl
            })
        }
    }
    catch {
        Write-LogEntry -Level ERROR -Message "Failed processing user '$($user.userPrincipalName)': $($_.Exception.Message)"
        continue
    }
}

# Sort rows with grouping that mirrors ticket UI expectations: engineer then duration label.
$sortedRows = @($exportRows | Sort-Object engineerName, pullDownDescription)

Export-TamperMonkeyArtifacts -Rows $sortedRows -CsvPath $OutputCsvPath

$adminExpectations = Get-AdminAuditExpectations -Headers $headers
$missingAdmins = Export-BookingAccessAudit -Businesses $allBusinesses -Headers $headers -ExpectedAdmins $adminExpectations -CsvPath $AccessAuditCsvPath

if ($adminExpectations.Count -gt 0 -and $missingAdmins.Count -gt 0) {
    Write-LogEntry -Level WARN -Message "Access audit found missing admin memberships: $($missingAdmins.Count). See $([IO.Path]::GetFullPath($AccessAuditCsvPath))"
    foreach ($missing in $missingAdmins) {
        Write-LogEntry -Level WARN -Message "Missing admin $($missing.expectedAdmin) on business '$($missing.businessDisplayName)' ($($missing.businessId))."
    }
}
elseif ($adminExpectations.Count -gt 0) {
    Write-LogEntry -Level SUCCESS -Message 'Access audit confirmed expected admins are present on all discovered businesses.'
}

Write-LogEntry -Level SUCCESS -Message "Provisioning complete."
Write-LogEntry -Level SUCCESS -Message "CSV export: $([IO.Path]::GetFullPath($OutputCsvPath))"
Write-LogEntry -Level SUCCESS -Message "Access audit CSV export: $([IO.Path]::GetFullPath($AccessAuditCsvPath))"
