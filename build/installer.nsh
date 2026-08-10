; Kozum Cowork — installer customisation.
;
; Adds an outbound Windows Firewall allow rule for the app so that GitHub
; (plugins, marketplaces) and the configured inference providers are always
; reachable, regardless of a restrictive default outbound policy. Removed
; again on uninstall so we leave no orphaned rules behind.

!macro customInstall
  DetailPrint "Adding firewall rule for Kozum Cowork..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Kozum Cowork"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Kozum Cowork" dir=out action=allow program="$INSTDIR\Kozum Cowork.exe" enable=yes profile=any description="Outbound access for Kozum Cowork (providers, GitHub, MCP servers)"'
!macroend

!macro customUnInstall
  DetailPrint "Removing firewall rule..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Kozum Cowork"'
!macroend
