# Cross-platform terminal path promotion checklist

- [ ] Installed Codex version contains upstream changes `#35850` and `#35851`.
- [ ] A Linux app-server lists a Windows drive working directory without failing the entire request.
- [ ] A Linux app-server lists a Windows UNC working directory without converting it to a Linux absolute path.
- [ ] `\\?\\D:\\reports` and `\\.\\D:\\reports` normalize to `file:///D:/reports`.
- [ ] Supported device-namespace UNC paths normalize to canonical hosted file URIs.
- [ ] Reserved devices, volume identifiers, malformed UNC paths, and localhost aliases remain opaque.
- [ ] Foreign and opaque paths cannot satisfy local allowed-root or containment checks.
- [ ] Local filesystem authority requires a separately verified host path.
- [ ] Read-only and idempotent-write canaries preserve task, operation, and terminal ownership identifiers.
- [ ] Rollback to the currently validated Codex version remains available.
